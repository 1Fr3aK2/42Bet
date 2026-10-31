// src/api/crypto.js

// GET /crypto/:coin -> the latest ticker the server received from Kraken
// (price, 24 h high, low, volume and change), or null when it has none yet.
// The socket only sends a ticker when the price changes, so the page asks for
// the current one when it opens instead of waiting for the next change.
export async function getTicker(coin) {
  const response = await fetch(`/crypto/${coin}`);
  if (!response.ok) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// GET /crypto/:coin/candles?interval=N -> the last 720 candles of N minutes
// ({ time, open, high, low, close }, time in UTC seconds), oldest first.
// The server takes them from Kraken, the exchange that also settles the bets.
export async function getCandles(coin, interval) {
  const response = await fetch(`/crypto/${coin}/candles?interval=${interval}`);
  if (!response.ok) throw new Error('The price history is not available right now');
  return response.json();
}
