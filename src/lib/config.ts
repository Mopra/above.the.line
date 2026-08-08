function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} is not a number: "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export const config = {
  market: process.env.MARKET ?? 'BTC-EUR',

  /** Real orders are only sent when this is explicitly true. */
  tradingEnabled: bool('TRADING_ENABLED', false),
  killSwitch: bool('KILL_SWITCH', false),

  maxAllocationEur: num('MAX_ALLOCATION_EUR', 134),
  accountValueCeilingEur: num('ACCOUNT_VALUE_CEILING_EUR', 200),

  /**
   * Bitvavo has required an integer `operatorId` on every create, update and
   * cancel order request since 1 June 2025. It identifies which bot or person
   * placed an order; the value is yours to choose. Orders without it are
   * rejected, so this matters the moment TRADING_ENABLED becomes true.
   */
  bitvavoOperatorId: num('BITVAVO_OPERATOR_ID', 1),

  smaDays: num('SMA_DAYS', 140),
  signalWeekday: num('SIGNAL_WEEKDAY', 1),
  stopLossPct: num('STOP_LOSS_PCT', 20),
  /**
   * The wider stop that reads the live price rather than the daily close, so a
   * collapse is caught within the hour instead of at the next close. Set it to 0
   * to switch intraday stopping off entirely and behave exactly as the backtest
   * models. It is deliberately wider than STOP_LOSS_PCT: a tight intraday stop
   * would fire on wicks the backtest never saw.
   */
  crashStopPct: num('CRASH_STOP_PCT', 30),
  maxTradesPerMonth: num('MAX_TRADES_PER_MONTH', 6),

  statePrefix: process.env.STATE_PREFIX ?? 'default',

  dkkPerEur: num('DKK_PER_EUR', 7.46),
  taxRateGainPct: num('TAX_RATE_GAIN_PCT', 42),
  taxRateLossPct: num('TAX_RATE_LOSS_PCT', 26),

  /** Bitvavo taker fee at the entry tier, in basis points. */
  takerFeeBps: 25,
  /** Assumed market-order slippage, in basis points. */
  slippageBps: 10,
  /** Exchange minimum order value for BTC-EUR. */
  minOrderEur: 5,
} as const;

export function hasCredentials(): boolean {
  return Boolean(process.env.BITVAVO_API_KEY && process.env.BITVAVO_API_SECRET);
}
