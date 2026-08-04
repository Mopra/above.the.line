import {
  fetchBalance,
  fetchDailyCandles,
  fetchTicker,
  marketBuy,
  marketSell,
  type FillResult,
} from './bitvavo';
import { config, hasCredentials } from './config';
import { loadState, saveState } from './state';
import { decide, weekKey, type StrategyParams } from './strategy';
import { sellFifo } from './tax';
import type { BotState, Candle, Trade } from './types';

export interface RunReport {
  ranAt: number;
  live: boolean;
  action: 'HOLD' | 'ENTER' | 'EXIT' | 'BLOCKED';
  reason: string;
  price: number;
  sma: number | null;
  position: BotState['position'];
  equityEur: number;
  trade?: Trade;
  blockedBy?: string;
}

function params(): StrategyParams {
  return {
    smaDays: config.smaDays,
    signalWeekday: config.signalWeekday,
    stopLossPct: config.stopLossPct,
  };
}

/** Drop the bar that is still forming so decisions only use closed candles. */
function closedCandles(candles: Candle[], now: number): Candle[] {
  const DAY = 86_400_000;
  return candles.filter((c) => c.time + DAY <= now);
}

function tradesThisMonth(state: BotState, now: number): number {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return state.trades.filter((t) => t.time >= monthStart).length;
}

function equity(state: BotState, price: number, cashEur: number): number {
  return cashEur + state.qty * price;
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One equity snapshot per calendar day, so a repeat run does not duplicate. */
function recordHistory(
  state: BotState,
  now: number,
  equityEur: number,
  price: number,
): void {
  const point = { time: now, equity: equityEur, price };
  const last = state.history[state.history.length - 1];
  if (last && dayStamp(last.time) === dayStamp(now)) {
    state.history[state.history.length - 1] = point;
  } else {
    state.history.push(point);
  }
  if (state.history.length > 800) state.history = state.history.slice(-800);
}

/**
 * One scheduled run. Safe to call more than once a day: the weekly signal is
 * guarded by an ISO week key, so a repeat call cannot double-enter.
 */
export async function runOnce(): Promise<RunReport> {
  const now = Date.now();
  const state = await loadState();

  const all = await fetchDailyCandles(config.market, 2500);
  const candles = closedCandles(all, now);
  if (candles.length < config.smaDays + 2) {
    throw new Error(
      `Only ${candles.length} closed candles available, need at least ${config.smaDays + 2}`,
    );
  }
  const idx = candles.length - 1;
  const bar = candles[idx];
  const d = decide(candles, idx, state.position, state.entryPrice, params());

  const livePrice = await fetchTicker(config.market);
  const live = config.tradingEnabled && hasCredentials();

  // Seed the paper-trading wallet the first time the bot ever runs.
  if (state.simCashEur === null) state.simCashEur = config.maxAllocationEur;

  // ---- Read the account, when we have keys -------------------------------
  let exchangeEur = 0;
  let btcAvailable = 0;
  if (hasCredentials()) {
    const balances = await fetchBalance();
    exchangeEur = Number(balances.find((b) => b.symbol === 'EUR')?.available ?? 0);
    btcAvailable = Number(balances.find((b) => b.symbol === 'BTC')?.available ?? 0);
  }

  // Live trading trusts the exchange. Dry runs trust the simulated wallet, so a
  // paper run still produces a meaningful equity curve with no money at risk.
  let cashEur = live ? exchangeEur : state.simCashEur;

  const block = (why: string): RunReport => ({
    ranAt: now,
    live: false,
    action: 'BLOCKED',
    reason: d.reason,
    blockedBy: why,
    price: livePrice,
    sma: d.sma,
    position: state.position,
    equityEur: equity(state, livePrice, cashEur),
  });

  // ---- Hard limits, checked before anything can be sent ------------------
  if (config.killSwitch) return finish(block('KILL_SWITCH is true.'));
  if (state.halted) return finish(block(`Bot is halted: ${state.haltReason}`));

  const accountValue = exchangeEur + btcAvailable * livePrice;
  if (hasCredentials() && accountValue > config.accountValueCeilingEur) {
    return finish(
      block(
        `Account holds EUR ${accountValue.toFixed(2)}, above the ` +
          `EUR ${config.accountValueCeilingEur} ceiling. Refusing to trade money ` +
          'the bot was not given.',
      ),
    );
  }

  let action = d.action;

  // A stop-loss exit ignores the weekly cadence. Everything else obeys it.
  const isStopExit = action === 'EXIT' && d.reason.startsWith('Stop loss');
  const currentWeek = weekKey(bar.time);
  if (action !== 'HOLD' && !isStopExit) {
    if (state.lastSignalWeek === currentWeek) {
      action = 'HOLD';
      d.reason = `Already acted on the ${currentWeek} signal. Holding.`;
    }
  }

  if (action !== 'HOLD' && tradesThisMonth(state, now) >= config.maxTradesPerMonth) {
    return finish(
      block(
        `Already ${tradesThisMonth(state, now)} trades this month, cap is ` +
          `${config.maxTradesPerMonth}. Something is wrong, so nothing is sent.`,
      ),
    );
  }

  // ---- Execute -----------------------------------------------------------
  let trade: Trade | undefined;

  if (action === 'ENTER') {
    const budget = Math.min(config.maxAllocationEur, cashEur);
    if (budget < config.minOrderEur) {
      return finish(
        block(
          `Only EUR ${budget.toFixed(2)} available, below the ` +
            `EUR ${config.minOrderEur} exchange minimum.`,
        ),
      );
    }
    const fill = await buy(budget, livePrice);
    trade = {
      id: `${now}-buy`,
      time: now,
      side: 'BUY',
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      reason: d.reason,
      live: fill.live,
    };
    state.position = 'LONG';
    state.qty += fill.qty;
    state.entryPrice = fill.qty > 0 ? (fill.quote + fill.fee) / fill.qty : fill.price;
    state.entryTime = now;
    state.lots.push({
      time: now,
      qty: fill.qty,
      costPerUnit: state.entryPrice,
    });
    state.totalFees += fill.fee;
    cashEur = Math.max(0, cashEur - fill.quote - fill.fee);
    if (!live) state.simCashEur = cashEur;
  } else if (action === 'EXIT') {
    const sellQty = live ? Math.min(state.qty, btcAvailable) : state.qty;
    if (sellQty * livePrice < config.minOrderEur) {
      return finish(
        block(
          `Position is worth less than the EUR ${config.minOrderEur} minimum, ` +
            'so it cannot be sold. Holding.',
        ),
      );
    }
    const fill = await sell(sellQty, livePrice);
    const proceeds = fill.quote - fill.fee;
    const { realised, remaining } = sellFifo(state.lots, sellQty, proceeds);
    if (realised >= 0) state.realisedGains += realised;
    else state.realisedLosses += Math.abs(realised);
    trade = {
      id: `${now}-sell`,
      time: now,
      side: 'SELL',
      qty: sellQty,
      price: fill.price,
      fee: fill.fee,
      reason: d.reason,
      realisedPnl: realised,
      live: fill.live,
    };
    state.lots = remaining;
    state.qty = Math.max(0, state.qty - sellQty);
    state.position = state.qty > 1e-10 ? 'LONG' : 'FLAT';
    if (state.position === 'FLAT') {
      state.entryPrice = null;
      state.entryTime = null;
    }
    state.totalFees += fill.fee;
    cashEur += proceeds;
    if (!live) state.simCashEur = cashEur;
  }

  if (trade) {
    state.trades.push(trade);
    // Keep the stored log bounded; the dashboard only needs recent history.
    if (state.trades.length > 500) state.trades = state.trades.slice(-500);
    if (!isStopExit) state.lastSignalWeek = currentWeek;
  }

  const equityNow = equity(state, livePrice, cashEur);
  recordHistory(state, now, equityNow, livePrice);
  state.lastRunTime = now;
  state.lastNote = d.reason;
  await saveState(state);

  return {
    ranAt: now,
    live: trade?.live ?? false,
    action,
    reason: d.reason,
    price: livePrice,
    sma: d.sma,
    position: state.position,
    equityEur: equityNow,
    trade,
  };

  async function finish(report: RunReport): Promise<RunReport> {
    recordHistory(state, now, report.equityEur, report.price);
    state.lastRunTime = now;
    state.lastNote = report.blockedBy ?? report.reason;
    await saveState(state);
    return report;
  }
}

type SimFill = FillResult & { live: boolean };

async function buy(budgetEur: number, refPrice: number): Promise<SimFill> {
  if (config.tradingEnabled && hasCredentials()) {
    const fill = await marketBuy(config.market, budgetEur);
    return { ...fill, live: true };
  }
  const fillPrice = refPrice * (1 + config.slippageBps / 10_000);
  const fee = budgetEur * (config.takerFeeBps / 10_000);
  const qty = (budgetEur - fee) / fillPrice;
  return {
    orderId: 'dry-run',
    status: 'filled',
    qty,
    quote: budgetEur - fee,
    fee,
    price: fillPrice,
    live: false,
  };
}

async function sell(qty: number, refPrice: number): Promise<SimFill> {
  if (config.tradingEnabled && hasCredentials()) {
    const fill = await marketSell(config.market, qty);
    return { ...fill, live: true };
  }
  const fillPrice = refPrice * (1 - config.slippageBps / 10_000);
  const gross = qty * fillPrice;
  const fee = gross * (config.takerFeeBps / 10_000);
  return {
    orderId: 'dry-run',
    status: 'filled',
    qty,
    quote: gross,
    fee,
    price: fillPrice,
    live: false,
  };
}
