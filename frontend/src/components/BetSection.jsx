import { PAYOUT } from '../data/constants';

const QUICK_AMOUNTS = [50, 100, 250, 500];

export default function BetSection({ betAmount, onAmountChange, balance, onBet, betStatus, loggedIn, placing, amountError }) {
  const win = Math.floor((parseFloat(betAmount) || 0) * PAYOUT);
  // Guests cannot bet, and nothing is sent while a bet is on its way or the amount is wrong.
  const canBet = loggedIn && !placing && !amountError;
  const status = loggedIn ? betStatus : { text: 'Log in or register to place bets', type: '' };

  return (
    <div className="bet-section">
      <div className="bet-input-row">
        <label className="bet-label" htmlFor="bet-amount">Bet amount</label>

        <div className="quick-amounts">
          {QUICK_AMOUNTS.map((amt) => (
            <button key={amt} className="quick-btn" disabled={!loggedIn} onClick={() => onAmountChange(amt)}>
              {amt}
            </button>
          ))}
          <button className="quick-btn" disabled={!loggedIn} onClick={() => onAmountChange(Math.floor(balance))}>
            MAX
          </button>
        </div>

        <div className="bet-input-wrapper">
          <span className="bet-currency">T$</span>
          {/* Whole positive amounts only: a change with anything but digits
              (letters, "-", "." or "e") is ignored. */}
          <input
            id="bet-amount"
            className="bet-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={7}
            value={betAmount}
            disabled={!loggedIn}
            aria-invalid={Boolean(amountError)}
            aria-describedby={amountError ? 'bet-amount-error' : undefined}
            onChange={(e) => /^\d*$/.test(e.target.value) && onAmountChange(e.target.value)}
          />
        </div>
        {amountError && <div id="bet-amount-error" className="modal-error">{amountError}</div>}
      </div>

      <div className="payout-info">
        Payout: <span className="payout-multiplier">x{PAYOUT}</span>
        &nbsp;·&nbsp; Win: <span className="payout-win">T$ {win.toLocaleString()}</span>
      </div>

      <div className="bet-buttons">
        <button className="bet-btn bet-up" disabled={!canBet} onClick={() => onBet('up')}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <polyline points="18 15 12 9 6 15" />
          </svg>
          UP
        </button>
        <button className="bet-btn bet-down" disabled={!canBet} onClick={() => onBet('down')}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          DOWN
        </button>
      </div>

      <div className={`bet-status ${status.type ? `active ${status.type}` : ''}`}>
        {status.text}
      </div>
    </div>
  );
}
