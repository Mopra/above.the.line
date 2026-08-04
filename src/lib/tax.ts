import type { Lot } from './types';

export interface FifoResult {
  /** EUR gain (positive) or loss (negative) realised by this sale. */
  realised: number;
  /** Lots left over after the sale. */
  remaining: Lot[];
  /** Total EUR cost basis consumed. */
  basis: number;
}

/**
 * Consume the oldest lots first, as Danish rules require. FIFO applies across
 * every exchange and wallet you own, so if you hold BTC elsewhere the figures
 * this bot reports are only correct for the coins it bought itself.
 *
 * `proceeds` is the EUR actually received, already net of the sell fee.
 */
export function sellFifo(lots: Lot[], qty: number, proceeds: number): FifoResult {
  if (qty <= 0) return { realised: 0, remaining: lots, basis: 0 };

  const remaining = lots.map((l) => ({ ...l }));
  let toSell = qty;
  let basis = 0;

  while (toSell > 1e-12 && remaining.length > 0) {
    const lot = remaining[0];
    const take = Math.min(lot.qty, toSell);
    basis += take * lot.costPerUnit;
    lot.qty -= take;
    toSell -= take;
    if (lot.qty <= 1e-12) remaining.shift();
  }

  return { realised: proceeds - basis, remaining, basis };
}

export interface SkatSummary {
  /** Sum of all winning sales. Goes in rubrik 20. */
  gainsEur: number;
  /** Sum of all losing sales, as a positive number. Goes in rubrik 58. */
  lossesEur: number;
  gainsDkk: number;
  lossesDkk: number;
  /**
   * Estimated tax on the gains. Danish rules do not let you net losses against
   * gains, so this is charged on the gross gains regardless of the losses.
   */
  taxOnGainsDkk: number;
  /** Value of the loss deduction, at the lower ligningsmaessig rate. */
  reliefOnLossesDkk: number;
  netTaxDkk: number;
}

export function summariseForSkat(
  gainsEur: number,
  lossesEur: number,
  opts: { dkkPerEur: number; gainRatePct: number; lossRatePct: number },
): SkatSummary {
  const gainsDkk = gainsEur * opts.dkkPerEur;
  const lossesDkk = Math.abs(lossesEur) * opts.dkkPerEur;
  const taxOnGainsDkk = gainsDkk * (opts.gainRatePct / 100);
  const reliefOnLossesDkk = lossesDkk * (opts.lossRatePct / 100);
  return {
    gainsEur,
    lossesEur: Math.abs(lossesEur),
    gainsDkk,
    lossesDkk,
    taxOnGainsDkk,
    reliefOnLossesDkk,
    netTaxDkk: taxOnGainsDkk - reliefOnLossesDkk,
  };
}
