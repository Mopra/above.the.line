import { config } from '@/lib/config';
import { loadState } from '@/lib/state';
import { summariseForSkat } from '@/lib/tax';
import EquityChart, { type ChartPoint } from './EquityChart';

export const dynamic = 'force-dynamic';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function dkk(eur: number): string {
  return `kr ${Math.round(eur * config.dkkPerEur).toLocaleString('da-DK')}`;
}

function eur(n: number): string {
  return `€${n.toFixed(2)}`;
}

function signedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function when(ms: number | null): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString('da-DK', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function Page() {
  const state = await loadState();
  const startEquity = config.maxAllocationEur;

  const history = state.history;
  const latest = history[history.length - 1] ?? null;
  const equityNow = latest?.equity ?? startEquity;
  const returnPct = (equityNow / startEquity - 1) * 100;

  // Buy and hold: the same money into BTC on the bot's first day, one fee paid.
  const firstPrice = history[0]?.price ?? null;
  const bhQty =
    firstPrice !== null
      ? (startEquity * (1 - config.takerFeeBps / 10_000)) / firstPrice
      : 0;

  const points: ChartPoint[] = history.map((p) => ({
    time: p.time,
    equity: p.equity,
    buyHold: bhQty * p.price,
  }));

  const tax = summariseForSkat(state.realisedGains, state.realisedLosses, {
    dkkPerEur: config.dkkPerEur,
    gainRatePct: config.taxRateGainPct,
    lossRatePct: config.taxRateLossPct,
  });

  const trades = [...state.trades].reverse().slice(0, 40);
  const mode = config.tradingEnabled ? 'Live money' : 'Paper trading';
  const deltaClass = returnPct > 0.05 ? 'up' : returnPct < -0.05 ? 'down' : 'flat';

  return (
    <main>
      <div className="head">
        <div>
          <h1>Above the line</h1>
          <p className="sub">
            {config.market} · long or cash · {config.smaDays}-day trend filter ·
            signals on {WEEKDAYS[config.signalWeekday] ?? 'Monday'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="badge">
            <span
              className={config.tradingEnabled ? 'dot dot-warning' : 'dot dot-muted'}
            />
            {mode}
          </span>
          {state.halted && (
            <span className="badge">
              <span className="dot dot-critical" />
              Halted
            </span>
          )}
          {config.killSwitch && (
            <span className="badge">
              <span className="dot dot-critical" />
              Kill switch on
            </span>
          )}
          <span className="badge">
            <span
              className={state.position === 'LONG' ? 'dot dot-good' : 'dot dot-muted'}
            />
            {state.position === 'LONG' ? 'Holding BTC' : 'In cash'}
          </span>
        </div>
      </div>

      <div className="card">
        <p className="hero-label">Portfolio value</p>
        <p className="hero">{dkk(equityNow)}</p>
        <p className={`hero-delta ${deltaClass}`}>
          {signedPct(returnPct)} since start · {eur(equityNow)} of {eur(startEquity)}
        </p>
      </div>

      <div className="tiles">
        <div className="card">
          <p className="tile-label">Position</p>
          <p className="tile-value">{state.position === 'LONG' ? 'Long' : 'Cash'}</p>
          <p className="tile-note">
            {state.position === 'LONG' && state.entryPrice
              ? `Entered at €${state.entryPrice.toFixed(0)} · stop at €${(
                  state.entryPrice *
                  (1 - config.stopLossPct / 100)
                ).toFixed(0)}`
              : 'Waiting for an uptrend'}
          </p>
        </div>
        <div className="card">
          <p className="tile-label">Realised gains</p>
          <p className="tile-value">{dkk(state.realisedGains)}</p>
          <p className="tile-note">rubrik 20 · {tax.gainsDkk.toFixed(0)} kr</p>
        </div>
        <div className="card">
          <p className="tile-label">Realised losses</p>
          <p className="tile-value">{dkk(state.realisedLosses)}</p>
          <p className="tile-note">rubrik 58 · {tax.lossesDkk.toFixed(0)} kr</p>
        </div>
        <div className="card">
          <p className="tile-label">Fees paid</p>
          <p className="tile-value">{dkk(state.totalFees)}</p>
          <p className="tile-note">
            {((state.totalFees / startEquity) * 100).toFixed(1)}% of capital ·{' '}
            {state.trades.length} trades
          </p>
        </div>
      </div>

      <section>
        <h2>Value over time</h2>
        <div className="card">
          {points.length >= 3 ? (
            <EquityChart points={points} />
          ) : (
            <p className="empty">
              Not enough history yet. The chart appears once the job has run a few
              times — it records one point per day.
            </p>
          )}
          {points.length >= 3 && (
            <details>
              <summary>Show the numbers</summary>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Bot</th>
                    <th className="num">Buy and hold</th>
                    <th className="num">BTC price</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points]
                    .reverse()
                    .slice(0, 60)
                    .map((p, i) => (
                      <tr key={p.time}>
                        <td>{new Date(p.time).toLocaleDateString('da-DK')}</td>
                        <td className="num">{eur(p.equity)}</td>
                        <td className="num">{eur(p.buyHold)}</td>
                        <td className="num">
                          €{history[history.length - 1 - i]?.price.toFixed(0)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      </section>

      <section>
        <h2>What it did and why</h2>
        <div className="card">
          {trades.length === 0 ? (
            <p className="empty">
              No trades yet. Last run {when(state.lastRunTime)}
              {state.lastNote ? `: ${state.lastNote}` : '.'}
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Side</th>
                  <th className="num">Price</th>
                  <th className="num">Amount</th>
                  <th className="num">Result</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{when(t.time)}</td>
                    <td>
                      {t.side === 'BUY' ? 'Buy' : 'Sell'}
                      {t.live ? '' : ' (paper)'}
                    </td>
                    <td className="num">€{t.price.toFixed(0)}</td>
                    <td className="num">{eur(t.qty * t.price)}</td>
                    <td
                      className={`num ${
                        t.realisedPnl === undefined
                          ? ''
                          : t.realisedPnl >= 0
                            ? 'up'
                            : 'down'
                      }`}
                    >
                      {t.realisedPnl === undefined
                        ? '—'
                        : `${t.realisedPnl >= 0 ? '+' : ''}${eur(t.realisedPnl)}`}
                    </td>
                    <td className="reason">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <p className="foot">
        Last run {when(state.lastRunTime)}. {state.lastNote ?? ''}
        <br />
        Gains and losses are shown separately because Danish rules tax them at
        different rates and do not let you net one against the other. Estimated tax
        on the gains so far: {Math.round(tax.taxOnGainsDkk).toLocaleString('da-DK')} kr.
        Figures cover only the coins this bot bought; FIFO applies across everything
        you own.
      </p>
    </main>
  );
}
