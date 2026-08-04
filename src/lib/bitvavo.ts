import { createHmac } from 'node:crypto';
import type { Candle } from './types';

const BASE = 'https://api.bitvavo.com/v2';

/** Bitvavo returns candles as [timeMs, open, high, low, close, volume] strings. */
type RawCandle = [number, string, string, string, string, string];

function toCandle(raw: RawCandle): Candle {
  return {
    time: raw[0],
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
  };
}

async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Bitvavo GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch daily candles, newest first, walking backwards until the exchange runs
 * out of history. Bitvavo caps a single response at 1440 candles.
 */
export async function fetchDailyCandles(
  market: string,
  maxBars = 4000,
): Promise<Candle[]> {
  const DAY = 86_400_000;
  const seen = new Map<number, Candle>();
  let end: number | undefined;

  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ interval: '1d', limit: '1440' });
    if (end !== undefined) query.set('end', String(end));

    const raw = await publicGet<RawCandle[]>(`/${market}/candles?${query}`);
    if (raw.length === 0) break;

    let oldest = Number.POSITIVE_INFINITY;
    for (const row of raw) {
      const candle = toCandle(row);
      seen.set(candle.time, candle);
      if (candle.time < oldest) oldest = candle.time;
    }

    if (seen.size >= maxBars) break;
    // Next page ends one day before the oldest bar we just received.
    const nextEnd = oldest - DAY;
    if (nextEnd === end) break;
    end = nextEnd;
  }

  // Oldest first, which is what every consumer here expects.
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

export async function fetchTicker(market: string): Promise<number> {
  const data = await publicGet<{ price: string }>(`/ticker/price?market=${market}`);
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Bitvavo returned an unusable price for ${market}: ${data.price}`);
  }
  return price;
}

// --------------------------------------------------------------------------
// Authenticated calls. The API key must have View + Trade permission only.
// --------------------------------------------------------------------------

function credentials(): { key: string; secret: string } {
  const key = process.env.BITVAVO_API_KEY;
  const secret = process.env.BITVAVO_API_SECRET;
  if (!key || !secret) {
    throw new Error('BITVAVO_API_KEY and BITVAVO_API_SECRET must both be set');
  }
  return { key, secret };
}

async function privateCall<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const { key, secret } = credentials();
  const timestamp = Date.now();
  const payload = body === undefined ? '' : JSON.stringify(body);
  // Bitvavo signs: timestamp + method + "/v2" + path + body
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}${method}/v2${path}${payload}`)
    .digest('hex');

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'Bitvavo-Access-Key': key,
      'Bitvavo-Access-Signature': signature,
      'Bitvavo-Access-Timestamp': String(timestamp),
      'Bitvavo-Access-Window': '10000',
    },
    body: body === undefined ? undefined : payload,
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bitvavo ${method} ${path} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

export interface BalanceEntry {
  symbol: string;
  available: string;
  inOrder: string;
}

export async function fetchBalance(): Promise<BalanceEntry[]> {
  return privateCall<BalanceEntry[]>('GET', '/balance');
}

interface RawFill {
  amount: string;
  price: string;
  fee?: string;
}

interface RawOrder {
  orderId: string;
  status: string;
  filledAmount: string;
  filledAmountQuote: string;
  feePaid?: string;
  fills?: RawFill[];
}

export interface FillResult {
  orderId: string;
  status: string;
  /** BTC filled */
  qty: number;
  /** EUR spent or received, before fee adjustment */
  quote: number;
  /** EUR fee */
  fee: number;
  /** Effective EUR per BTC */
  price: number;
}

function summariseOrder(order: RawOrder): FillResult {
  const qty = Number(order.filledAmount ?? 0);
  const quote = Number(order.filledAmountQuote ?? 0);
  let fee = Number(order.feePaid ?? 0);
  if (!Number.isFinite(fee) || fee === 0) {
    fee = (order.fills ?? []).reduce((sum, f) => sum + Number(f.fee ?? 0), 0);
  }
  return {
    orderId: order.orderId,
    status: order.status,
    qty,
    quote,
    fee: Number.isFinite(fee) ? fee : 0,
    price: qty > 0 ? quote / qty : 0,
  };
}

/** Spend `amountQuote` EUR on a market buy. */
export async function marketBuy(market: string, amountQuote: number): Promise<FillResult> {
  const order = await privateCall<RawOrder>('POST', '/order', {
    market,
    side: 'buy',
    orderType: 'market',
    amountQuote: amountQuote.toFixed(2),
  });
  return summariseOrder(order);
}

/** Sell `amount` BTC at market. */
export async function marketSell(market: string, amount: number): Promise<FillResult> {
  const order = await privateCall<RawOrder>('POST', '/order', {
    market,
    side: 'sell',
    orderType: 'market',
    amount: amount.toFixed(8),
  });
  return summariseOrder(order);
}
