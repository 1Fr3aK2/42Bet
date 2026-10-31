import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { getAnalytics } from '../../api/analytics';
import { betsToCsv, download, fmt, price, reportLines, signed, textToPdf } from './exporters';

// Analytics dashboard of the logged-in user's bets, opened at #/analytics by
// the Analytics button of the navbar. It is rendered next to <App /> in
// main.jsx, reads the login token from localStorage (like src/api/users.js)
// and reloads by itself when the server says one of the user's bets changed.

const HASH = '#/analytics';
const GREEN = '#2ea84b';
const RED = '#e05252';
const ORANGE = '#e8a020';
const MUTED = '#8892aa';
const GRID = '#1e2330';
const TOOLTIP_STYLE = { background: '#13151e', border: '1px solid #1e2330', fontSize: 12 };
const OUTCOMES = [
  { key: 'won', label: 'Won', color: GREEN },
  { key: 'lost', label: 'Lost', color: RED },
  { key: 'refunded', label: 'Refunded', color: MUTED },
];
const GROUP_COLORS = { BTC: ORANGE, ETH: '#7b8cde', Up: GREEN, Down: RED };
const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: 'All time', days: null },
];
const NO_FILTERS = { from: '', to: '', coin: '', direction: '' };

const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const percent = (rate) => (rate === null ? '—' : `${rate}%`);
const shortDay = (day) => new Date(`${day}T00:00`).toLocaleDateString([], { day: '2-digit', month: 'short' });
const dateTime = (time) =>
  new Date(time).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// "YYYY-MM-DD" of a date in local time, the format of <input type="date">.
function dayString(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function rangeDates(days) {
  const today = new Date();
  return { from: dayString(new Date(today.getTime() - (days - 1) * 86400000)), to: dayString(today) };
}

// The filters as the API expects them: whole local days as ISO dates.
function toQuery(filters) {
  return {
    from: filters.from && new Date(`${filters.from}T00:00:00`).toISOString(),
    to: filters.to && new Date(`${filters.to}T23:59:59.999`).toISOString(),
    coin: filters.coin,
    direction: filters.direction,
    tzOffset: new Date().getTimezoneOffset(),
  };
}

export default function AnalyticsDashboard() {
  const [open, setOpen] = useState(window.location.hash === HASH);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const token = open ? localStorage.getItem('token') : null;
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);

  useEffect(() => {
    const onHashChange = () => setOpen(window.location.hash === HASH);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const close = useCallback(() => {
    // Remove the hash without reloading the page or adding a history entry.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setOpen(false);
  }, []);

  // Focus the title, so screen readers start there, and close with Escape.
  useEffect(() => {
    if (!open) return undefined;
    document.getElementById('analytics-title')?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  const load = useCallback(async () => {
    if (!token || invalidRange) return;
    try {
      setData(await getAnalytics(toQuery(filters), token));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token, filters, invalidRange]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Real time: the server sends "bets:changed" on the /bets namespace when one
  // of the user's bets is placed or settled, and the dashboard reloads.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!open || !token) return undefined;
    const socket = io('/bets', { auth: { token } });
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('bets:changed', () => loadRef.current());
    return () => {
      socket.disconnect();
      setLive(false);
    };
  }, [open, token]);

  if (!open) return null;

  const setFilter = (name) => (e) => setFilters((f) => ({ ...f, [name]: e.target.value }));
  const activeRange = RANGES.find(({ days }) => {
    const dates = days === null ? { from: '', to: '' } : rangeDates(days);
    return filters.from === dates.from && filters.to === dates.to;
  });
  const fileDate = dayString(new Date());

  function exportPdf() {
    let username;
    try {
      username = JSON.parse(localStorage.getItem('currentUser'))?.username;
    } catch {
      username = undefined;
    }
    download(textToPdf(reportLines({ data, filters, username })), `transcendence-analytics-${fileDate}.pdf`);
  }

  let body;
  if (!token) body = <p className="analytics-message">Log in to see the analytics of your bets.</p>;
  else if (invalidRange) {
    body = <p className="analytics-message analytics-error" role="alert">The start date must be on or before the end date.</p>;
  } else if (!data) {
    body = error
      ? <p className="analytics-message analytics-error" role="alert">{error}</p>
      : <p className="analytics-message">Loading…</p>;
  } else {
    // A failed reload keeps the last data on screen, with the error above it.
    body = (
      <>
        {error && <p className="analytics-note analytics-error" role="alert">{error}</p>}
        <Dashboard data={data} />
      </>
    );
  }

  return (
    <div className="settings-page analytics-page" role="dialog" aria-modal="true" aria-labelledby="analytics-title">
      <button className="settings-close" onClick={close} aria-label="Close">×</button>
      <div className="analytics-container">
        <header className="analytics-header">
          <h1 id="analytics-title" tabIndex={-1}>Analytics</h1>
          {token && <span className={`analytics-live ${live ? 'on' : ''}`}>{live ? 'Live' : 'Offline'}</span>}
          <div className="analytics-exports" role="group" aria-label="Export">
            <button className="analytics-button" disabled={!data || !token}
              onClick={() => download(betsToCsv(data.bets), `transcendence-bets-${fileDate}.csv`, 'text/csv')}>
              Export CSV
            </button>
            <button className="analytics-button" disabled={!data || !token}
              onClick={() => download(JSON.stringify({ filters, ...data }, null, 2), `transcendence-analytics-${fileDate}.json`, 'application/json')}>
              Export JSON
            </button>
            <button className="analytics-button" disabled={!data || !token} onClick={exportPdf}>Export PDF</button>
          </div>
        </header>

        {token && (
          <div className="analytics-filters" role="group" aria-label="Filters">
            {RANGES.map(({ label, days }) => (
              <button key={label} className={`analytics-button ${activeRange?.days === days ? 'active' : ''}`}
                aria-pressed={activeRange?.days === days}
                onClick={() => setFilters((f) => ({ ...f, ...(days === null ? { from: '', to: '' } : rangeDates(days)) }))}>
                {label}
              </button>
            ))}
            <label>
              From
              <input type="date" value={filters.from} max={filters.to || undefined} onChange={setFilter('from')} />
            </label>
            <label>
              To
              <input type="date" value={filters.to} min={filters.from || undefined} onChange={setFilter('to')} />
            </label>
            <label>
              Coin
              <select value={filters.coin} onChange={setFilter('coin')}>
                <option value="">All</option>
                <option value="BTC">BTC</option>
                <option value="ETH">ETH</option>
              </select>
            </label>
            <label>
              Direction
              <select value={filters.direction} onChange={setFilter('direction')}>
                <option value="">All</option>
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </label>
          </div>
        )}

        {body}
      </div>
    </div>
  );
}

function Kpi({ label, value, detail, valueTone = '' }) {
  return (
    <div className="analytics-kpi">
      <div className="analytics-kpi-label">{label}</div>
      <div className={`analytics-kpi-value ${valueTone}`}>{value}</div>
      {detail && <div className="analytics-kpi-detail">{detail}</div>}
    </div>
  );
}

function Dashboard({ data }) {
  const { summary } = data;
  const outcomes = OUTCOMES.map((o) => ({ ...o, value: summary[o.key] })).filter((o) => o.value > 0);
  const groups = [
    ...data.byCoin,
    ...data.byDirection.map((g) => ({ ...g, name: g.name === 'up' ? 'Up' : 'Down' })),
  ].map((g) => ({ ...g, rate: g.winRate ?? 0, label: percent(g.winRate) }));
  // Cumulative profit after each settled bet, from 0: bets settled seconds
  // apart stay readable, which a time axis would squeeze into one spike.
  const profitLine = data.profitOverTime.length
    ? [{ n: 0, time: null, profit: 0 }, ...data.profitOverTime.map((p, i) => ({ n: i + 1, ...p }))]
    : [];

  return (
    <>
      <div className="analytics-kpis">
        <Kpi label="Balance" value={`${fmt(summary.balance)} T$`} />
        <Kpi label="Profit" value={`${signed(summary.profit)} T$`} valueTone={tone(summary.profit)}
          detail={`${fmt(summary.paidOut)} T$ paid out`} />
        <Kpi label="Win rate" value={percent(summary.winRate)}
          detail={`${summary.won} won · ${summary.lost} lost · ${summary.refunded} refunded`} />
        <Kpi label="Bets" value={fmt(summary.bets)} detail={`${summary.active} still running`} />
        <Kpi label="Wagered" value={`${fmt(summary.wagered)} T$`} />
        <Kpi label="Best bet" value={summary.bestBet === null ? '—' : `${signed(summary.bestBet)} T$`}
          valueTone={tone(summary.bestBet)}
          detail={summary.worstBet === null ? undefined : `worst: ${signed(summary.worstBet)} T$`} />
      </div>

      {summary.bets === 0 ? (
        <p className="analytics-message">No bets in this period. Place a bet and it will show up here.</p>
      ) : (
        <>
          <div className="analytics-charts">
            <figure className="analytics-card wide">
              <figcaption className="analytics-card-title">Cumulative profit after each settled bet (T$)</figcaption>
              {profitLine.length ? (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={profitLine} margin={{ top: 8, right: 16 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="n" type="number" domain={[0, 'dataMax']} allowDecimals={false}
                      tickFormatter={(n) => (n === 0 ? 'start' : `#${n}`)} stroke={MUTED} fontSize={11} />
                    <YAxis stroke={MUTED} fontSize={11} width={60} tickFormatter={fmt} />
                    <ReferenceLine y={0} stroke={MUTED} strokeDasharray="4 4" />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(n, items) => (n === 0 ? 'Start' : `Bet #${n} · ${dateTime(items?.[0]?.payload.time)}`)}
                      formatter={(v) => [`${signed(v)} T$`, 'Profit']} />
                    <Line type="linear" dataKey="profit" stroke={ORANGE} strokeWidth={2}
                      dot={profitLine.length <= 60 ? { r: 3, fill: ORANGE } : false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="analytics-message">Your bets are still running.</p>
              )}
            </figure>

            <figure className="analytics-card">
              <figcaption className="analytics-card-title">Profit by day (T$)</figcaption>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={data.profitByDay}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="day" tickFormatter={shortDay} stroke={MUTED} fontSize={11} />
                  <YAxis stroke={MUTED} fontSize={11} width={60} tickFormatter={fmt} />
                  <ReferenceLine y={0} stroke={MUTED} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={shortDay} cursor={{ fill: '#1a1d26' }}
                    formatter={(v) => [`${signed(v)} T$`, 'Profit']} />
                  <Bar dataKey="profit" isAnimationActive={false}>
                    {data.profitByDay.map((d) => <Cell key={d.day} fill={d.profit < 0 ? RED : GREEN} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <details>
                <summary>Data table</summary>
                <table className="analytics-table">
                  <thead><tr><th>Day</th><th className="num">Bets</th><th className="num">Profit</th></tr></thead>
                  <tbody>
                    {data.profitByDay.map((d) => (
                      <tr key={d.day}><td>{d.day}</td><td className="num">{d.bets}</td>
                        <td className={`num ${tone(d.profit)}`}>{signed(d.profit)} T$</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </figure>

            <figure className="analytics-card">
              <figcaption className="analytics-card-title">Results</figcaption>
              {outcomes.length ? (
                <div className="analytics-donut">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={outcomes} dataKey="value" nameKey="label" innerRadius={55} outerRadius={85}
                        paddingAngle={2} stroke="none" isAnimationActive={false}>
                        {outcomes.map((o) => <Cell key={o.key} fill={o.color} />)}
                      </Pie>
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <ul className="analytics-legend">
                    {OUTCOMES.map((o) => (
                      <li key={o.key}><span style={{ background: o.color }} />{o.label}: {summary[o.key]}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="analytics-message">Your bets are still running.</p>
              )}
            </figure>

            <figure className="analytics-card">
              <figcaption className="analytics-card-title">Win rate by coin and direction</figcaption>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={groups} margin={{ top: 18 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="name" stroke={MUTED} fontSize={11} />
                  <YAxis domain={[0, 100]} stroke={MUTED} fontSize={11} width={45} tickFormatter={(v) => `${v}%`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: '#1a1d26' }}
                    formatter={(v, name, { payload }) => [`${percent(payload.winRate)} of ${payload.bets} bets`, 'Win rate']} />
                  <Bar dataKey="rate" minPointSize={2} isAnimationActive={false}>
                    {groups.map((g) => <Cell key={g.name} fill={GROUP_COLORS[g.name] ?? ORANGE} />)}
                    <LabelList dataKey="label" position="top" fill="#c9cfdb" fontSize={11} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <details>
                <summary>Data table</summary>
                <table className="analytics-table">
                  <thead>
                    <tr><th></th><th className="num">Bets</th><th className="num">Won</th><th className="num">Lost</th>
                      <th className="num">Win rate</th><th className="num">Profit</th></tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.name}><td>{g.name}</td><td className="num">{g.bets}</td><td className="num">{g.won}</td>
                        <td className="num">{g.lost}</td><td className="num">{percent(g.winRate)}</td>
                        <td className={`num ${tone(g.profit)}`}>{signed(g.profit)} T$</td></tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </figure>
          </div>

          <LatestBets bets={data.bets} total={summary.bets} />
        </>
      )}
    </>
  );
}

function LatestBets({ bets, total }) {
  const shown = bets.slice(0, 10);
  return (
    <section className="analytics-card" aria-labelledby="analytics-latest">
      <h2 id="analytics-latest" className="analytics-card-title">Latest bets</h2>
      <div className="analytics-table-wrap">
        <table className="analytics-table">
          <thead>
            <tr><th>Placed</th><th>Coin</th><th>Direction</th><th className="num">Stake</th>
              <th className="num">Entry → exit (EUR)</th><th>Result</th><th className="num">Profit</th></tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id}>
                <td>{dateTime(b.createdAt)}</td>
                <td>{b.coin}</td>
                <td className={b.direction === 'up' ? 'up' : 'down'}>{b.direction}</td>
                <td className="num">{fmt(b.amount)} T$</td>
                <td className="num">{price(b.entryPrice)} → {price(b.exitPrice)}</td>
                <td>{b.status}</td>
                <td className={`num ${b.status === 'active' ? '' : tone(b.payout - b.amount)}`}>
                  {b.status === 'active' ? '—' : `${signed(b.payout - b.amount)} T$`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="analytics-note">
        The {shown.length} newest of {fmt(total)} bets in this period. The exports include up to 500.
      </p>
    </section>
  );
}
