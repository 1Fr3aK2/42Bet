import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, CrosshairMode, LineStyle, TickMarkType, createChart } from 'lightweight-charts';
import { getCandles } from '../api/crypto';

// Candlestick chart of the selected coin, drawn with TradingView's Lightweight
// Charts. The candles come from the server (Kraken, the exchange that settles
// the bets) and the live price moves the last one. Like on TradingView, the
// mouse wheel or a pinch zooms and dragging moves through time. Each running
// bet of the player on this coin is a line at its entry price: green for UP,
// red for DOWN.

const INTERVALS = [
  { minutes: 1, label: '1m' },
  { minutes: 5, label: '5m' },
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
];
const GREEN = '#2ea84b';
const RED = '#e05252';

const euros = (price) => `€${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The chart works in UTC seconds; the axis and the crosshair show local time.
function tickLabel(time, type) {
  const date = new Date(time * 1000);
  if (type === TickMarkType.Year) return String(date.getFullYear());
  if (type === TickMarkType.Month) return date.toLocaleDateString([], { month: 'short' });
  if (type === TickMarkType.DayOfMonth) return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
const crosshairTime = (time) =>
  new Date(time * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function PriceChart({ coin, ticker, bets }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  // What the chart shows now, so a live price only moves candles of the same coin and size.
  const loaded = useRef(null); // { coin, minutes, last }
  const [minutes, setMinutes] = useState(1);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'

  // Create the chart once.
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: '#13151e' },
        textColor: '#8892aa',
        fontFamily: "'Courier New', Courier, monospace",
      },
      grid: { vertLines: { color: '#1a1d26' }, horzLines: { color: '#1a1d26' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e2330' },
      timeScale: { borderColor: '#1e2330', timeVisible: true, rightOffset: 4, barSpacing: 8, tickMarkFormatter: tickLabel },
      localization: { priceFormatter: euros, timeFormatter: crosshairTime },
      // Vertical swipes keep scrolling the page on phones; horizontal ones move the chart.
      handleScroll: { vertTouchDrag: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: GREEN,
      downColor: RED,
      borderVisible: false,
      wickUpColor: GREEN,
      wickDownColor: RED,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chartRef.current = null;
      seriesRef.current = null;
      chart.remove();
    };
  }, []);

  // Load the candles of this coin and size.
  useEffect(() => {
    let cancelled = false;
    loaded.current = null;
    setStatus('loading');
    getCandles(coin, minutes)
      .then((candles) => {
        if (cancelled || !seriesRef.current) return;
        seriesRef.current.setData(candles);
        loaded.current = { coin, minutes, last: candles[candles.length - 1] ?? null };
        chartRef.current.timeScale().scrollToRealTime();
        setStatus(candles.length ? 'ready' : 'error');
      })
      .catch(() => !cancelled && setStatus('error'));
    return () => { cancelled = true; };
  }, [coin, minutes]);

  // The live price moves the last candle, or opens the next one.
  useEffect(() => {
    const shown = loaded.current;
    if (!ticker || !shown?.last || shown.coin !== coin || !ticker.symbol.startsWith(`${coin}/`)) return;
    const size = shown.minutes * 60;
    const time = Math.floor((Date.parse(ticker.timestamp) || Date.now()) / 1000 / size) * size;
    const { last } = shown;
    if (time < last.time) return; // older than the newest candle
    const price = ticker.last;
    const candle = time === last.time
      ? { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
      : { time, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
    seriesRef.current.update(candle);
    shown.last = candle;
  }, [ticker, coin]);

  // A line at the entry price of each running bet on this coin.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return undefined;
    const lines = bets
      .filter((bet) => bet.coin === coin)
      .map((bet) => series.createPriceLine({
        price: bet.entryPrice,
        color: bet.direction === 'up' ? GREEN : RED,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `${bet.direction.toUpperCase()} ${bet.amount} T$`,
      }));
    return () => {
      if (seriesRef.current === series) lines.forEach((line) => series.removePriceLine(line));
    };
  }, [bets, coin]);

  // Back to the default zoom, on the latest candles.
  function resetZoom() {
    chartRef.current?.timeScale().resetTimeScale();
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }

  return (
    <div className="price-chart">
      <div className="chart-toolbar">
        <div className="side-panel-title">{coin} / EUR</div>
        <div className="chart-buttons" role="group" aria-label="Candle size">
          {INTERVALS.map((option) => (
            <button
              key={option.minutes}
              className={`chart-btn ${option.minutes === minutes ? 'active' : ''}`}
              aria-pressed={option.minutes === minutes}
              onClick={() => setMinutes(option.minutes)}
            >
              {option.label}
            </button>
          ))}
          <button className="chart-btn" onClick={resetZoom} title="Back to the default zoom">Reset</button>
        </div>
      </div>
      <div className="chart-area">
        <div className="chart-canvas" ref={containerRef} role="img" aria-label={`Candlestick chart of ${coin} in euros`} />
        {status !== 'ready' && (
          <div className="chart-message">
            {status === 'error' ? 'The price history is not available right now' : 'Loading candles…'}
          </div>
        )}
      </div>
      <div className="chart-hint">
        Scroll or pinch to zoom, drag to move. Your running bets are lines at their entry price:
        <span className="chart-hint-up"> green UP</span>, <span className="chart-hint-down">red DOWN</span>.
      </div>
    </div>
  );
}
