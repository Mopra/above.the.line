import { decide, type StrategyParams } from './strategy';
import { sellFifo } from './tax';
import type { Candle, Lot, Position } from './types';

export interface BacktestCosts {
  /** Exchange taker fee in basis points. 25 = 0.25%. */
  feeBps: number;
  /** Assumed slippage on a market order, in basis points. */
  slippageBps: number;
}

export interface BacktestTrade {
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  fee: number;
  realised?: number;
  reason: string;
}

export interface BacktestResult {
  params: StrategyParams;
  from: number;
  to: number;
  bars: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  trades: BacktestTrade[];
  tradeCount: number;
  roundTrips: number;
  winRatePct: number;
  totalFees: number;
  /** Share of days holding BTC. */
  exposurePct: number;
  realisedGains: number;
  realisedLosses: number;
  /** Buy and hold over the identical window, same fee assumptions. */
  buyHoldReturnPct: number;
  buyHoldMaxDrawdownPct: number;
  equityCurve: { time: number; equity: number; buyHold: number }[];
}

function maxDrawdownPct(series: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Walk the candles one bar at a time and apply the strategy. Orders fill on the
 * close of the deciding bar, which is realistic here because the bot runs on a
 * daily schedule against a 24/7 market and sends market orders immediately.
 * Fees and slippage are both charged.
 */
export function runBacktest(
  candles: Candle[],
  params: StrategyParams,
  costs: BacktestCosts,
  startEquity = 134,
  /**
   * Bars before this index are used only to warm up the moving average. No
   * trades are taken and no equity is recorded until the index is reached.
   * This is what makes an out-of-sample run honest: the average is already
   * warm, but the test window still starts flat and in cash.
   */
  tradeFromIdx = 0,
): BacktestResult {
  if (candles.length === 0) throw new Error('No candles supplied to the backtest');
  if (tradeFromIdx < 0 || tradeFromIdx >= candles.length) {
    throw new Error(`tradeFromIdx ${tradeFromIdx} is outside the candle range`);
  }

  const feeRate = costs.feeBps / 10_000;
  const slipRate = costs.slippageBps / 10_000;

  let cash = startEquity;
  let qty = 0;
  let position: Position = 'FLAT';
  let entryPrice: number | null = null;
  let lots: Lot[] = [];

  const trades: BacktestTrade[] = [];
  const equityCurve: { time: number; equity: number; buyHold: number }[] = [];
  const equitySeries: number[] = [];
  const buyHoldSeries: number[] = [];
  let realisedGains = 0;
  let realisedLosses = 0;
  let totalFees = 0;
  let daysExposed = 0;

  // Buy and hold reference: buy everything on the first tradeable bar, same costs.
  const bhEntry = candles[tradeFromIdx].close * (1 + slipRate);
  const bhQty = (startEquity * (1 - feeRate)) / bhEntry;

  for (let i = tradeFromIdx; i < candles.length; i += 1) {
    const bar = candles[i];
    const d = decide(candles, i, position, entryPrice, params);

    if (d.action === 'ENTER' && cash > 0) {
      const fillPrice = bar.close * (1 + slipRate);
      const fee = cash * feeRate;
      const bought = (cash - fee) / fillPrice;
      totalFees += fee;
      trades.push({
        time: bar.time,
        side: 'BUY',
        price: fillPrice,
        qty: bought,
        fee,
        reason: d.reason,
      });
      lots.push({ time: bar.time, qty: bought, costPerUnit: cash / bought });
      qty += bought;
      entryPrice = cash / bought;
      cash = 0;
      position = 'LONG';
    } else if (d.action === 'EXIT' && qty > 0) {
      const fillPrice = bar.close * (1 - slipRate);
      const gross = qty * fillPrice;
      const fee = gross * feeRate;
      const proceeds = gross - fee;
      const { realised, remaining } = sellFifo(lots, qty, proceeds);
      totalFees += fee;
      if (realised >= 0) realisedGains += realised;
      else realisedLosses += Math.abs(realised);
      trades.push({
        time: bar.time,
        side: 'SELL',
        price: fillPrice,
        qty,
        fee,
        realised,
        reason: d.reason,
      });
      lots = remaining;
      cash = proceeds;
      qty = 0;
      entryPrice = null;
      position = 'FLAT';
    }

    if (position === 'LONG') daysExposed += 1;
    const equity = cash + qty * bar.close;
    const buyHold = bhQty * bar.close;
    equityCurve.push({ time: bar.time, equity, buyHold });
    equitySeries.push(equity);
    buyHoldSeries.push(buyHold);
  }

  const endEquity = equitySeries[equitySeries.length - 1];
  const testedBars = candles.length - tradeFromIdx;
  const years =
    (candles[candles.length - 1].time - candles[tradeFromIdx].time) /
    (365.25 * 86_400_000);
  const sells = trades.filter((t) => t.side === 'SELL');
  const wins = sells.filter((t) => (t.realised ?? 0) > 0).length;

  return {
    params,
    from: candles[tradeFromIdx].time,
    to: candles[candles.length - 1].time,
    bars: testedBars,
    startEquity,
    endEquity,
    totalReturnPct: (endEquity / startEquity - 1) * 100,
    cagrPct: years > 0 ? ((endEquity / startEquity) ** (1 / years) - 1) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(equitySeries),
    trades,
    tradeCount: trades.length,
    roundTrips: sells.length,
    winRatePct: sells.length > 0 ? (wins / sells.length) * 100 : 0,
    totalFees,
    exposurePct: (daysExposed / testedBars) * 100,
    realisedGains,
    realisedLosses,
    buyHoldReturnPct:
      (buyHoldSeries[buyHoldSeries.length - 1] / startEquity - 1) * 100,
    buyHoldMaxDrawdownPct: maxDrawdownPct(buyHoldSeries),
    equityCurve,
  };
}

export interface SweepEntry {
  smaDays: number;
  inSample: BacktestResult;
}

/**
 * Grid search the trend length on the in-sample window only. Whatever wins here
 * is then measured once on data it has never seen. That out-of-sample number is
 * the only one worth believing.
 */
export function sweepInSample(
  candles: Candle[],
  smaCandidates: number[],
  base: Omit<StrategyParams, 'smaDays'>,
  costs: BacktestCosts,
  startEquity = 134,
): SweepEntry[] {
  // Every candidate starts trading on the same bar, so the longest average does
  // not get an unfair head start or a shorter test window.
  const warmup = Math.max(...smaCandidates);
  if (warmup >= candles.length) {
    throw new Error('In-sample window is shorter than the longest trend filter');
  }
  return smaCandidates
    .map((smaDays) => ({
      smaDays,
      inSample: runBacktest(
        candles,
        { ...base, smaDays },
        costs,
        startEquity,
        warmup,
      ),
    }))
    .sort((a, b) => score(b.inSample) - score(a.inSample));
}

/**
 * Rank by return per unit of drawdown rather than raw return, so the winner is
 * not simply the most reckless setting.
 */
export function score(r: BacktestResult): number {
  const dd = Math.max(r.maxDrawdownPct, 1);
  return r.totalReturnPct / dd;
}

export function splitCandles(
  candles: Candle[],
  splitRatio = 0.5,
): { inSample: Candle[]; outOfSample: Candle[] } {
  const cut = Math.floor(candles.length * splitRatio);
  return { inSample: candles.slice(0, cut), outOfSample: candles.slice(cut) };
}
