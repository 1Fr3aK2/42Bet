import { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import CoinSelector from './components/CoinSelector';
import PriceDisplay from './components/PriceDisplay';
import Timer from './components/Timer';
import BetSection from './components/BetSection';
import ActiveBets from './components/ActiveBets';
import HistoryList from './components/HistoryList';
import PriceChart from './components/PriceChart';
import Toast from './components/Toast';
import RegisterModal from './components/RegisterModal';
import LoginModal from './components/LoginModal';
import SettingsPage from './components/SettingsPage';
import ForumPage from './components/Forum/ForumPage';
import ModerationPage from './components/Forum/ModerationPage';
import AdminUsersPage from './components/AdminUsersPage';
import { COINS } from './data/constants';
import { socket } from './api/socket';
import { getMe } from './api/users';
import { getTicker } from './api/crypto';
import { BET_SECONDS, betAmountError } from './api/bets';
import useBets, { secondsLeft } from './hooks/useBets';
import { fmt } from './utils/format';

export default function App() {
  // ── State (this replaces every loose "let" at the top of script.js) ──
  const [selectedCoin, setSelectedCoin] = useState('BTC');
  // Latest ticker of each coin from the server's Kraken feed: price and the
  // 24 h high, low, volume and change. Empty until the first one arrives.
  const [tickers, setTickers] = useState({});
  const [sidePanelView, setSidePanelView] = useState('chart'); // 'chart' | 'activity'
  const [betAmount, setBetAmount] = useState('100');
  const [betStatus, setBetStatus] = useState({ text: '', type: '' });
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState({ msg: '', type: '', show: false });
  const [showRegister, setShowRegister] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showForum, setShowForum] = useState(false);
  const [showModeration, setShowModeration] = useState(false);
  const [showAdminUsers, setShowAdminUsers] = useState(false);
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('currentUser');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('token'));

  // ── Balance and bets come from the server ──
  // The server checks, places, settles and pays every bet (hooks/useBets.js);
  // the page only shows the result. Guests have no balance and cannot bet.
  const { balance, activeBets, settledBets, now, place } = useBets(token, {
    onSettled: showResults,
    onExpired: () => {
      setToken(null);
      setCurrentUser(null);
      showToast('Session expired, please log in again', 'loss');
    },
  });

  // ── Persist auth state to localStorage so a page refresh doesn't log out ──
  useEffect(() => {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  }, [token]);

  useEffect(() => {
    if (currentUser) localStorage.setItem('currentUser', JSON.stringify(currentUser));
    else localStorage.removeItem('currentUser');
  }, [currentUser]);

  // ── On app load, refresh the logged-in user from the backend ──
  // localStorage may hold an outdated copy; the database is the source of truth.
  useEffect(() => {
    if (!token) return;
    getMe(token)
      .then(setCurrentUser)
      .catch(() => {
        // token expired or invalid -> log out
        setToken(null);
        setCurrentUser(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Listen for real-time crypto prices from the backend's Socket.io gateway ──
  useEffect(() => {
    function handleTicker(ticker) {
      const coin = ticker.symbol.split('/')[0]; // "BTC/EUR" -> "BTC"
      setTickers((prev) => ({ ...prev, [coin]: ticker }));
    }

    // The gateway only sends a ticker when the price changes: ask the server
    // for the current one now instead of waiting for the next change.
    COINS.forEach((coin) => {
      getTicker(coin)
        .then((ticker) => ticker && handleTicker(ticker))
        .catch(() => {});
    });

    socket.on('crypto:ticker', handleTicker);
    return () => socket.off('crypto:ticker', handleTicker);
  }, []);

  // ── "Methods" (same responsibilities as the functions in script.js) ──

  function showToast(msg, type) {
    setToast({ msg, type, show: true });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3500);
  }

  // Guests can look at the prices, but betting, the forum and the settings
  // need an account: show why and open the login.
  function askToLogin(message) {
    showToast(message, 'loss');
    setShowLogin(true);
  }

  // Called by useBets when the server has settled one or more of the user's bets.
  function showResults(bets) {
    if (bets.length === 1) {
      const [bet] = bets;
      if (bet.status === 'won') showToast(`✓ WIN ${bet.coin} +T$ ${bet.payout}`, 'win');
      else if (bet.status === 'lost') showToast(`✗ LOSS ${bet.coin} -T$ ${bet.amount}`, 'loss');
      else showToast(`↺ REFUND ${bet.coin} T$ ${bet.amount}`, 'info');
    } else {
      const count = (status) => bets.filter((bet) => bet.status === status).length;
      showToast(`${bets.length} bets settled: ${count('won')} won, ${count('lost')} lost`, count('won') ? 'win' : 'loss');
    }

    const [last] = bets; // newest first
    const diff = last.exitPrice ? ((last.exitPrice - last.entryPrice) / last.entryPrice) * 100 : 0;
    setBetStatus({
      text: `${last.coin} ${last.status.toUpperCase()} (${diff >= 0 ? '+' : ''}${diff.toFixed(3)}%)`,
      type: last.status === 'won' ? 'up' : last.status === 'lost' ? 'down' : '',
    });
  }

  // The server checks the login, the amount and the balance, takes the entry
  // price from its own feed and settles the bet BET_SECONDS later. The checks
  // here only show the problem before anything is sent.
  async function placeBet(direction) {
    if (!currentUser) {
      askToLogin('Log in to place bets');
      return;
    }
    const error = betAmountError(betAmount, balance);
    if (error) {
      setBetStatus({ text: error, type: 'down' });
      return;
    }

    setPlacing(true);
    try {
      const bet = await place({ coin: selectedCoin, direction, amount: Number(betAmount) });
      setBetStatus({ text: `Active: ${direction.toUpperCase()} on ${bet.coin} at ${fmt(bet.entryPrice)}`, type: '' });
    } catch (err) {
      setBetStatus({ text: err.message, type: 'down' });
    } finally {
      setPlacing(false);
    }
  }

  async function handleLoginSuccess(accessToken) {
    setToken(accessToken);
    try {
      // Load the real profile (username, avatar, ...) from the backend
      const user = await getMe(accessToken);
      setCurrentUser(user);
      showToast(`Welcome back, ${user.username}!`, 'win');
    } catch {
      showToast('Logged in, but could not load your profile', 'loss');
    }
  }

  const ticker = tickers[selectedCoin];
  // The running bet that ends first, for the countdown under the price.
  const nextBet = activeBets.reduce((first, bet) => (!first || bet.expiresAt < first.expiresAt ? bet : first), null);

  return (
    <>
      <Navbar
        balance={balance}
        onRegisterClick={() => setShowRegister(true)}
        onLoginClick={() => setShowLogin(true)}
        onSettingsClick={() => (currentUser ? setShowSettings(true) : askToLogin('Log in to change your settings'))}
        onForumClick={() => (currentUser ? setShowForum(true) : askToLogin('Log in to use the forum'))}
        onModerationClick={() => setShowModeration(true)}
        onAdminClick={() => setShowAdminUsers(true)}
        currentUser={currentUser}
        onLogout={() => { setCurrentUser(null); setToken(null); }}
      />

      <main className="page-content">
        <div className="trading-layout">
          <div className="trading-panel">
            <CoinSelector selectedCoin={selectedCoin} onSelect={setSelectedCoin} />
            {ticker ? (
              <PriceDisplay
                coin={selectedCoin}
                price={ticker.last}
                basePrice={ticker.last - ticker.change}
                stats={{
                  high: ticker.high,
                  low: ticker.low,
                  volume: `${Math.round(ticker.volume).toLocaleString('en-US')} ${selectedCoin}`,
                }}
              />
            ) : (
              <div className="price-display">
                <span className="price-coin">{selectedCoin}</span>
                <span className="price-change">Waiting for the live price…</span>
              </div>
            )}
            <Timer secondsLeft={nextBet ? secondsLeft(nextBet, now) : null} duration={BET_SECONDS} />
            <BetSection
              betAmount={betAmount}
              onAmountChange={(value) => setBetAmount(String(value))}
              balance={balance}
              onBet={placeBet}
              betStatus={betStatus}
              loggedIn={Boolean(currentUser)}
              placing={placing}
              amountError={currentUser ? betAmountError(betAmount, balance) : ''}
            />
          </div>

          <div className="side-panel">
            <div className="side-panel-tabs">
              <button
                className={`side-tab-btn ${sidePanelView === 'chart' ? 'active' : ''}`}
                onClick={() => setSidePanelView('chart')}
              >
                Chart
              </button>
              <button
                className={`side-tab-btn ${sidePanelView === 'activity' ? 'active' : ''}`}
                onClick={() => setSidePanelView('activity')}
              >
                Activity
              </button>
            </div>

            {sidePanelView === 'chart' ? (
              <PriceChart coin={selectedCoin} ticker={ticker} bets={activeBets} />
            ) : (
              <>
                <ActiveBets bets={activeBets} now={now} />
                <HistoryList history={settledBets} />
              </>
            )}
          </div>
        </div>
      </main>

      <Toast {...toast} />

      {showRegister && (
        <RegisterModal
          onClose={() => setShowRegister(false)}
          onSuccess={({ user, accessToken }) => {
            setToken(accessToken);
            setCurrentUser(user);
            showToast(`Welcome, ${user.username}!`, 'win');
          }}
        />
      )}

      {showLogin && (
        <LoginModal
          onClose={() => setShowLogin(false)}
          onSuccess={handleLoginSuccess}
        />
      )}

      {showSettings && (
        <SettingsPage
          user={currentUser}
          onClose={() => setShowSettings(false)}
          onUpdate={(updatedUser) => {
            setCurrentUser((u) => ({ ...u, ...updatedUser }));
            showToast('Profile updated', 'win');
          }}
        />
      )}

      {showForum && (
        <ForumPage
          token={token}
          currentUser={currentUser}
          onClose={() => setShowForum(false)}
        />
      )}

      {showModeration && (
        <ModerationPage
          token={token}
          onClose={() => setShowModeration(false)}
        />
      )}

      {showAdminUsers && (
        <AdminUsersPage
          token={token}
          currentUser={currentUser}
          onClose={() => setShowAdminUsers(false)}
        />
      )}
    </>
  );
}
