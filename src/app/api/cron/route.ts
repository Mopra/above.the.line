import { NextResponse } from 'next/server';
import { runOnce } from '@/lib/engine';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The scheduled job. Vercel calls this once a day and sends
 * `Authorization: Bearer $CRON_SECRET`. Without a matching secret the request
 * is rejected, so nobody can move your money by hitting the URL.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured. Refusing to run.' },
      { status: 500 },
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await runOnce();
    return NextResponse.json({
      ok: true,
      mode: config.tradingEnabled ? 'LIVE' : 'DRY_RUN',
      ...report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A failed run must never look like a successful one.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
