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

/** What the bot decided on a given run. */
export type RunAction = 'HOLD' | 'ENTER' | 'EXIT' | 'BLOCKED';

/**
 * One snapshot per scheduled run, so the dashboard can draw a curve.
 *
 * The last three fields are the paper run's actual value as an experiment.
 * Price alone tells you what happened; price against the trend filter tells you
 * how close each call was, which is the thing worth knowing when you later ask
 * whether SMA_DAYS should have been shorter. They are optional because points
 * written before they existed do not have them.
 */
export interface EquityPoint {
  time: number;
  /** Total EUR value: cash plus BTC at the price of the moment. */
  equity: number;
  /** BTC-EUR price at the snapshot, used for the buy-and-hold comparison. */
  price: number;
  /** The trend filter at this run, or null before there is enough history. */
  sma?: number | null;
  /** What the run decided to do. */
  action?: RunAction;
  /** Why, in plain language. The block reason when something was refused. */
  note?: string;
}

/** Which wallet the current ledger belongs to. */
export type TradingMode = 'PAPER' | 'LIVE';

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
  /**
   * Account value at this ledger's first run, the baseline for "since start".
   * MAX_ALLOCATION_EUR is a spending cap, not the money that was deposited, so
   * measuring returns against it invents a gain or loss the moment the two
   * differ. null means "not recorded yet"; the engine seeds it once and never
   * touches it again.
   */
  startEquityEur: number | null;
  /**
   * Which wallet this ledger belongs to. Paper and live positions cannot share
   * one: going live while holding a paper position would leave the bot certain
   * it owns BTC it never bought. The engine archives and starts clean when this
   * changes. null means a state written before the field existed, which is
   * adopted rather than reset.
   */
  mode: TradingMode | null;
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
    startEquityEur: null,
    mode: null,
    halted: false,
    haltReason: null,
    lastNote: null,
  };
}
