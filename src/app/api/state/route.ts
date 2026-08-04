import { NextResponse } from 'next/server';
import { loadState } from '@/lib/state';
import { config } from '@/lib/config';
import { summariseForSkat } from '@/lib/tax';

export const dynamic = 'force-dynamic';

/** Read-only view of the bot's state. No credentials are ever returned. */
export async function GET(): Promise<NextResponse> {
  try {
    const state = await loadState();
    const tax = summariseForSkat(state.realisedGains, state.realisedLosses, {
      dkkPerEur: config.dkkPerEur,
      gainRatePct: config.taxRateGainPct,
      lossRatePct: config.taxRateLossPct,
    });
    return NextResponse.json({
      ok: true,
      mode: config.tradingEnabled ? 'LIVE' : 'DRY_RUN',
      market: config.market,
      settings: {
        smaDays: config.smaDays,
        signalWeekday: config.signalWeekday,
        stopLossPct: config.stopLossPct,
        maxAllocationEur: config.maxAllocationEur,
      },
      state,
      tax: {
        rubrik20Dkk: Math.round(tax.gainsDkk),
        rubrik58Dkk: Math.round(tax.lossesDkk),
        netTaxDkk: Math.round(tax.netTaxDkk),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
