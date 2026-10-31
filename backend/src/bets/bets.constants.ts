// Rules of the betting engine, kept in one place so they are easy to explain and change.

// Balance of every new account, set by the server (never by the client).
export const STARTING_BALANCE = 1000;

// A bet lasts this long from the moment it is placed.
export const BET_DURATION_SECONDS = 60;

// A winning bet pays back the stake plus 85% (team decision, same value as
// PAYOUT in the frontend). A losing bet loses the whole stake.
export const PAYOUT_MULTIPLIER = 1.85;

// How often the server looks for bets whose time is up.
export const SETTLEMENT_INTERVAL_MS = 1000;

// If a bet could not be settled within this delay after it expired (for
// example because the backend was restarting), the stake is refunded: the
// price at that later moment is not the price at the end of the bet.
export const LATE_SETTLEMENT_MS = 10000;
