// src/api/bets.js

// The betting engine runs on the server (backend/src/bets): it checks the
// login, the amount and the balance, takes the price from its own live feed,
// and settles and pays every bet. These helpers only send the requests and
// return what the server decided. Every route needs the login token.

// Same limits as backend/src/bets/dto/create-bet.dto.ts.
export const MIN_BET = 1;
export const MAX_BET = 1000000;
// A bet lasts this long from the moment it is placed (BET_DURATION_SECONDS
// in backend/src/bets/bets.constants.ts). Only used to draw the countdown.
export const BET_SECONDS = 60;

async function request(path, token, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    let message = 'Request failed';
    try {
      const error = await response.json();
      message = (Array.isArray(error.message) ? error.message.join(', ') : error.message) || message;
    } catch {
      // keep the default message
    }
    const error = new Error(message);
    error.status = response.status; // 401 means the session expired
    throw error;
  }

  return response.json();
}

// GET /users/me/balance -> { balance }
export function getBalance(token) {
  return request('/users/me/balance', token);
}

// GET /users/me/bets -> the user's bets, newest first.
// status: 'active' (still running) or 'settled' (won, lost or refunded).
export function getBets(token, { status, limit }) {
  return request(`/users/me/bets?${new URLSearchParams({ status, limit })}`, token);
}

// POST /users/me/bets -> { bet, balance }. The server answers 400 for an
// invalid amount, a stake above the balance or a coin without a live price.
export function placeBet(token, { coin, direction, amount }) {
  return request('/users/me/bets', token, {
    method: 'POST',
    body: JSON.stringify({ coin, direction, amount }),
  });
}

// Checks the amount typed in the bet field before it is sent, so the player
// sees the problem at once: a whole number of T$ between MIN_BET and MAX_BET,
// and not above the balance. Returns the error message, or '' when valid.
// The server checks everything again: this is only for the player.
export function betAmountError(value, balance) {
  if (!/^\d+$/.test(String(value))) return 'Enter the amount in whole T$ (digits only)';
  const amount = Number(value);
  if (amount < MIN_BET) return `The minimum bet is ${MIN_BET} T$`;
  if (amount > MAX_BET) return `The maximum bet is ${MAX_BET.toLocaleString('en-US')} T$`;
  if (balance !== null && amount > balance) return 'Insufficient balance';
  return '';
}
