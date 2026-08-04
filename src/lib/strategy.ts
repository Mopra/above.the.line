import type { Candle, Position } from './types';

export interface StrategyParams {
  /** Length of the trend filter, in daily bars. */
  smaDays: number;
  /** 0 = Sunday .. 6 = Saturday. The day weekly entry/exit is decided. */
  signalWeekday: number;
  /** Hard stop, as a percentage below entry price. Checked daily. */
  stopLossPct: number;
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
 *   1. If long and price has fallen stopLossPct below entry, exit today.
 *      This is checked on every bar, not only on the weekly signal day.
 *   2. On the weekly signal day only:
 *        - flat and close above the SMA  -> enter
 *        - long and close below the SMA  -> exit
 *   3. Otherwise hold.
 *
 * Long-or-cash. No shorting, no leverage, no averaging in.
 */
export function decide(
  candles: Candle[],
  idx: number,
  position: Position,
  entryPrice: number | null,
  params: StrategyParams,
): Decision {
  const bar = candles[idx];
  const trend = sma(candles, idx, params.smaDays);
  const isSignalDay = new Date(bar.time).getUTCDay() === params.signalWeekday;
  const stopPrice =
    position === 'LONG' && entryPrice !== null
      ? entryPrice * (1 - params.stopLossPct / 100)
      : null;

  if (position === 'LONG' && stopPrice !== null && bar.close <= stopPrice) {
    return {
      action: 'EXIT',
      reason:
        `Stop loss. Close EUR ${bar.close.toFixed(0)} is at or below the stop at ` +
        `EUR ${stopPrice.toFixed(0)} (${params.stopLossPct}% under the EUR ` +
        `${entryPrice!.toFixed(0)} entry).`,
      sma: trend,
      close: bar.close,
      isSignalDay,
      stopPrice,
    };
  }

  if (trend === null) {
    return {
      action: 'HOLD',
      reason: `Not enough history yet: the ${params.smaDays}-day average needs more bars.`,
      sma: null,
      close: bar.close,
      isSignalDay,
      stopPrice,
    };
  }

  if (!isSignalDay) {
    return {
      action: 'HOLD',
      reason: 'Not the weekly signal day. Only the stop loss is live today.',
      sma: trend,
      close: bar.close,
      isSignalDay,
      stopPrice,
    };
  }

  const above = bar.close > trend;
  const gapPct = ((bar.close - trend) / trend) * 100;

  if (position === 'FLAT' && above) {
    return {
      action: 'ENTER',
      reason:
        `Weekly signal: close EUR ${bar.close.toFixed(0)} is ${gapPct.toFixed(1)}% above ` +
        `the ${params.smaDays}-day average of EUR ${trend.toFixed(0)}. Uptrend, go long.`,
      sma: trend,
      close: bar.close,
      isSignalDay,
      stopPrice,
    };
  }

  if (position === 'LONG' && !above) {
    return {
      action: 'EXIT',
      reason:
        `Weekly signal: close EUR ${bar.close.toFixed(0)} is ${Math.abs(gapPct).toFixed(1)}% ` +
        `below the ${params.smaDays}-day average of EUR ${trend.toFixed(0)}. Trend over, go to cash.`,
      sma: trend,
      close: bar.close,
      isSignalDay,
      stopPrice,
    };
  }

  return {
    action: 'HOLD',
    reason:
      position === 'LONG'
        ? `Still above the ${params.smaDays}-day average by ${gapPct.toFixed(1)}%. Stay long.`
        : `Still below the ${params.smaDays}-day average by ${Math.abs(gapPct).toFixed(1)}%. Stay in cash.`,
    sma: trend,
    close: bar.close,
    isSignalDay,
    stopPrice,
  };
}
