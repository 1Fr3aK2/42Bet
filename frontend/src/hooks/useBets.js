import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { getBalance, getBets, placeBet } from '../api/bets';

// The logged-in user's balance and bets, as the server has them. The server
// places, settles and pays every bet (backend/src/bets); this hook reads the
// result, and reads it again whenever the server says on the /bets channel
// that one of the user's bets changed. Guests (no token) have nothing to load.
//
//   onSettled(bets)  the user's bets that finished while the page was open
//   onExpired()      the server refused the token (expired session)
export default function useBets(token, { onSettled, onExpired }) {
  const [balance, setBalance] = useState(null);
  const [activeBets, setActiveBets] = useState([]);
  const [settledBets, setSettledBets] = useState([]);
  const [now, setNow] = useState(() => Date.now());

  // Read inside load() without making it change on every render.
  const callbacks = useRef({});
  callbacks.current = { onSettled, onExpired };
  const lastLoad = useRef(0); // number of the latest load: older answers are ignored
  const activeIds = useRef(null); // ids of the bets that were running at the last load

  const load = useCallback(async () => {
    if (!token) return;
    const thisLoad = ++lastLoad.current;
    try {
      const [wallet, active, settled] = await Promise.all([
        getBalance(token),
        getBets(token, { status: 'active', limit: 100 }),
        getBets(token, { status: 'settled', limit: 8 }),
      ]);
      if (thisLoad !== lastLoad.current) return;

      const finished = activeIds.current ? settled.filter((bet) => activeIds.current.has(bet.id)) : [];
      activeIds.current = new Set(active.map((bet) => bet.id));
      setBalance(wallet.balance);
      setActiveBets(active);
      setSettledBets(settled);
      if (finished.length > 0) callbacks.current.onSettled?.(finished);
    } catch (error) {
      if (error.status === 401) callbacks.current.onExpired?.();
    }
  }, [token]);

  // Login or logout: forget the previous user's data, then load.
  useEffect(() => {
    lastLoad.current += 1;
    activeIds.current = null;
    setBalance(null);
    setActiveBets([]);
    setSettledBets([]);
    load();
  }, [load]);

  // Real time: the server sends "bets:changed" when one of the user's bets is
  // placed or settled. Every (re)connection reloads too, in case one was missed.
  useEffect(() => {
    if (!token) return undefined;
    const socket = io('/bets', { auth: { token } });
    socket.on('connect', load);
    socket.on('bets:changed', load);
    return () => socket.disconnect();
  }, [token, load]);

  // Ticks every second while a bet is running, for the countdowns.
  useEffect(() => {
    if (activeBets.length === 0) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeBets.length]);

  // Sends the bet. The server checks it and answers with the new balance;
  // a refused bet throws an Error with the server's message.
  const place = useCallback(
    async (bet) => {
      try {
        const result = await placeBet(token, bet);
        setBalance(result.balance);
        setActiveBets((bets) => [result.bet, ...bets]); // shown at once, load() confirms it
        activeIds.current?.add(result.bet.id);
        load();
        return result.bet;
      } catch (error) {
        if (error.status === 401) callbacks.current.onExpired?.();
        throw error;
      }
    },
    [token, load],
  );

  return { balance, activeBets, settledBets, now, place };
}

// Whole seconds left before the server settles the bet.
export function secondsLeft(bet, now) {
  return Math.max(0, Math.ceil((new Date(bet.expiresAt).getTime() - now) / 1000));
}
