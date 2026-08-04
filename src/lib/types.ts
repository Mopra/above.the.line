/** One daily OHLC bar. `time` is the candle open time in ms UTC. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Position = 'FLAT' | 'LONG';

/** A purchased parcel of BTC, kept for FIFO cost-basis accounting. */
export interface Lot {
  /** ms UTC of the buy */
  time: number;
  /** BTC acquired, net of fee */
  qty: number;
  /** EUR paid per BTC, including the buy fee */
  costPerUnit: number;
}

export type TradeSide = 'BUY' | 'SELL';

export interface Trade {
  id: string;
  time: number;
  side: TradeSide;
  /** BTC quantity transacted */
  qty: number;
  /** EUR per BTC actually filled */
  price: number;
  /** EUR fee charged by the exchange */
  fee: number;
  /** Why the bot did this, in plain language */
  reason: string;
  /** Realised EUR gain (positive) or loss (negative) on a SELL, FIFO basis */
  realisedPnl?: number;
  /** false when the trade was only simulated */
  live: boolean;
}

/** One snapshot per scheduled run, so the dashboard can draw a curve. */
export interface EquityPoint {
  time: number;
  /** Total EUR value: cash plus BTC at the price of the moment. */
  equity: number;
  /** BTC-EUR price at the snapshot, used for the buy-and-hold comparison. */
  price: number;
}

export interface BotState {
  position: Position;
  /** EUR per BTC at entry, including fee. Basis for the stop loss. */
  entryPrice: number | null;
  entryTime: number | null;
  /** BTC currently held by the bot */
  qty: number;
  /** Open FIFO lots */
  lots: Lot[];
  /** ISO week key (e.g. "2026-W31") of the last weekly signal acted on */
  lastSignalWeek: string | null;
  lastRunTime: number | null;
  /** Cumulative realised EUR gains and losses, kept separate for Danish tax */
  realisedGains: number;
  realisedLosses: number;
  totalFees: number;
  trades: Trade[];
  history: EquityPoint[];
  /**
   * Cash the paper-trading simulation believes it holds. Only used while
   * TRADING_ENABLED is false; with live trading the exchange balance is truth.
   * null means "not started yet", so the engine seeds it from MAX_ALLOCATION_EUR.
   */
  simCashEur: number | null;
  /** Set by the engine when a hard limit trips. Requires manual reset. */
  halted: boolean;
  haltReason: string | null;
  /** Free-text note from the most recent run, shown on the dashboard */
  lastNote: string | null;
}

export function initialState(): BotState {
  return {
    position: 'FLAT',
    entryPrice: null,
    entryTime: null,
    qty: 0,
    lots: [],
    lastSignalWeek: null,
    lastRunTime: null,
    realisedGains: 0,
    realisedLosses: 0,
    totalFees: 0,
    trades: [],
    history: [],
    simCashEur: null,
    halted: false,
    haltReason: null,
    lastNote: null,
  };
}
