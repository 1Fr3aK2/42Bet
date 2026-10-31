export default function HistoryList({ history }) {
  return (
    <div className="history-panel">
      <div className="side-panel-title">Recent Results</div>
      <div className="history-list">
        {history.length === 0 && (
          <div className="history-empty">No bets yet — place your first bet</div>
        )}

        {history.map((h) => {
          // Settled bets from the server: won, lost or refunded (same price,
          // or settled too late), with the payout the server credited.
          const diff = h.exitPrice ? ((h.exitPrice - h.entryPrice) / h.entryPrice) * 100 : 0;
          const sign = diff >= 0 ? '+' : '';
          const payout = h.status === 'won' ? `+T$ ${h.payout}` : h.status === 'lost' ? `-T$ ${h.amount}` : 'Refunded';
          const result = h.status === 'won' ? 'win' : h.status === 'lost' ? 'loss' : '';
          return (
            <div className="history-item" key={h.id}>
              <div className="history-left">
                <span className="history-coin">{h.coin}</span>
                <span className={`history-direction ${h.direction}`}>{h.direction.toUpperCase()}</span>
                <span className="history-move">{sign}{diff.toFixed(3)}%</span>
              </div>
              <span className={`history-result ${result}`}>{payout}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
