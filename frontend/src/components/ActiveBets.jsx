import { fmt, formatTime } from '../utils/format';
import { PAYOUT } from '../data/constants';
import { secondsLeft } from '../hooks/useBets';

export default function ActiveBets({ bets, now }) {
  const visible = bets.filter((b) => b.status === 'active' || b.status === 'queued');
  if (visible.length === 0) return null;

  return (
    <div className="active-bets-list">
      {visible.map((bet) => (
        <div className="active-bet-card" key={bet.id}>
          <div className="side-panel-title">{bet.status === 'queued' ? 'Queued Bet' : 'Active Bet'}</div>

          <div className="active-bet-row">
            <span className="active-bet-label">Coin</span>
            <span className="active-bet-value">{bet.coin}</span>
          </div>
          <div className="active-bet-row">
            <span className="active-bet-label">Direction</span>
            <span className={`active-bet-value ${bet.direction}`}>{bet.direction.toUpperCase()}</span>
          </div>
          <div className="active-bet-row">
            <span className="active-bet-label">Entry price</span>
            <span className="active-bet-value">{bet.entryPrice ? fmt(bet.entryPrice) : '--'}</span>
          </div>
          <div className="active-bet-row">
            <span className="active-bet-label">Ends in</span>
            <span className="active-bet-value">{formatTime(secondsLeft(bet, now))}</span>
          </div>
          <div className="active-bet-row">
            <span className="active-bet-label">Amount</span>
            <span className="active-bet-value">T$ {bet.amount.toLocaleString()}</span>
          </div>
          <div className="active-bet-row">
            <span className="active-bet-label">Potential win</span>
            <span className="active-bet-value up">T$ {Math.floor(bet.amount * PAYOUT).toLocaleString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
