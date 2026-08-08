import type { Candle, Position } from './types';

export interface StrategyParams {
  /** Length of the trend filter, in daily bars. */
  smaDays: number;
  /** 0 = Sunday .. 6 = Saturday. The day weekly entry/exit is decided. */
  signalWeekday: number;
  /** Hard stop, as a percentage below entry price. Checked daily. */
  stopLossPct: number;
  /**
   * Second, wider stop measured against the *live* price instead of the daily
   * close, so a collapse does not have to wait for the bar to close. Optional,
   * and inert unless `decide` is also handed a live price: the backtest never
   * passes one, so a simulated run behaves exactly as it always did.
   *
   * Keep it wider than `stopLossPct`. Setting it narrower does not fail, but it
   * makes the intraday stop the binding one and the daily-close stop dead
   * weight, which is a different strategy from the one that was validated.
   */
  crashStopPct?: number;
}

export type Action = 'HOLD' | 'ENTER' | 'EXIT';

export interface Decision {
  action: Action;
  reason: string;
  /** Simple moving average at the decision bar, or null if not yet available. */
  sma: number | null;
  close: number;
  /** True when this bar is a scheduled weekly decision point. */
  isSignalDay: boolean;
  /** Price at which the hard stop would trigger, when a position is open. */
  stopPrice: number | null;
  /** Live price at which the wider intraday stop would trigger, if configured. */
  crashStopPrice: number | null;
  /**
   * True when this decision is a stop-loss exit of either kind. The caller uses
   * it to let the exit skip the weekly cadence, so it must not be inferred from
   * the wording of `reason` — a reworded message would silently trap a position.
   */
  isStop: boolean;
}

/** Simple moving average of the closes of the last `length` bars ending at `endIdx`. */
export function sma(candles: Candle[], endIdx: number, length: number): number | null {
  if (length <= 0) throw new Error('SMA length must be positive');
  if (endIdx < length - 1) return null;
  let sum = 0;
  for (let i = endIdx - length + 1; i <= endIdx; i += 1) sum += candles[i].close;
  return sum / length;
}

/** ISO-ish week key, used to guarantee at most one weekly signal per week. */
export function weekKey(timeMs: number): string {
  const d = new Date(timeMs);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The whole strategy, as one pure function.
 *
 * Rules, in priority order:
 *   1. If long and the daily close has fallen stopLossPct below entry, exit.
 *      This is checked on every bar, not only on the weekly signal day.
 *   2. If long and the *live* price has fallen crashStopPct below entry, exit
 *      without waiting for the bar to close. Only active when a live price is
 *      supplied, which the backtest deliberately never does.
 *   3. On the weekly signal day only:
 *        - flat and close above the SMA  -> enter
 *        - long and close below the SMA  -> exit
 *   4. Otherwise hold.
 *
 * Long-or-cash. No shorting, no leverage, no averaging in.
 *
 * `livePrice` is the current ticker, when the caller has one. It is used for
 * rule 2 and nothing else: the trend, the entry and the exit all still read
 * closed daily candles, so the shape of the strategy is unchanged.
 */
export function decide(
  candles: Candle[],
  idx: number,
  position: Position,
  entryPrice: number | null,
  params: StrategyParams,
  livePrice?: number,
): Decision {
  const bar = candles[idx];
  const trend = sma(candles, idx, params.smaDays);
  const isSignalDay = new Date(bar.time).getUTCDay() === params.signalWeekday;
  const holding = position === 'LONG' && entryPrice !== null;
  const stopPrice = holding ? entryPrice! * (1 - params.stopLossPct / 100) : null;
  const crashPct = params.crashStopPct ?? 0;
  const crashStopPrice =
    holding && crashPct > 0 ? entryPrice! * (1 - crashPct / 100) : null;

  // Every branch reports the same context; only the verdict differs.
  const context = {
    sma: trend,
    close: bar.close,
    isSignalDay,
    stopPrice,
    crashStopPrice,
  };

  if (stopPrice !== null && bar.close <= stopPrice) {
    return {
      action: 'EXIT',
      isStop: true,
      reason:
        `Stop loss. Close EUR ${bar.close.toFixed(0)} is at or below the stop at ` +
        `EUR ${stopPrice.toFixed(0)} (${params.stopLossPct}% under the EUR ` +
        `${entryPrice!.toFixed(0)} entry).`,
      ...context,
    };
  }

  if (crashStopPrice !== null && livePrice !== undefined && livePrice <= crashStopPrice) {
    return {
      action: 'EXIT',
      isStop: true,
      reason:
        `Stop loss, intraday. Live price EUR ${livePrice.toFixed(0)} is at or below ` +
        `the crash stop at EUR ${crashStopPrice.toFixed(0)} (${crashPct}% under the ` +
        `EUR ${entryPrice!.toFixed(0)} entry). Not waiting for the daily close.`,
      ...context,
    };
  }

  if (trend === null) {
    return {
      action: 'HOLD',
      isStop: false,
      reason: `Not enough history yet: the ${params.smaDays}-day average needs more bars.`,
      ...context,
      sma: null,
    };
  }

  if (!isSignalDay) {
    return {
      action: 'HOLD',
      isStop: false,
      reason: 'Not the weekly signal day. Only the stop loss is live today.',
      ...context,
    };
  }

  const above = bar.close > trend;
  const gapPct = ((bar.close - trend) / trend) * 100;

  if (position === 'FLAT' && above) {
    return {
      action: 'ENTER',
      isStop: false,
      reason:
        `Weekly signal: close EUR ${bar.close.toFixed(0)} is ${gapPct.toFixed(1)}% above ` +
        `the ${params.smaDays}-day average of EUR ${trend.toFixed(0)}. Uptrend, go long.`,
      ...context,
    };
  }

  if (position === 'LONG' && !above) {
    return {
      action: 'EXIT',
      isStop: false,
      reason:
        `Weekly signal: close EUR ${bar.close.toFixed(0)} is ${Math.abs(gapPct).toFixed(1)}% ` +
        `below the ${params.smaDays}-day average of EUR ${trend.toFixed(0)}. Trend over, go to cash.`,
      ...context,
    };
  }

  return {
    action: 'HOLD',
    isStop: false,
    reason:
      position === 'LONG'
        ? `Still above the ${params.smaDays}-day average by ${gapPct.toFixed(1)}%. Stay long.`
        : `Still below the ${params.smaDays}-day average by ${Math.abs(gapPct).toFixed(1)}%. Stay in cash.`,
    ...context,
  };
}
