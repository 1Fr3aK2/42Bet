# Bets Module (`backend/src/bets`)

## What it does

Server-side betting engine. The balance (T$) and the bets are stored in the
database, so they survive a page refresh, cannot be changed from the browser
and stay consistent when many users bet at the same time.

A user bets that a coin's price will go **up** or **down** in the next 60
seconds. The server records the live Kraken price when the bet is placed and
compares it with the live price when the 60 seconds are over.

## Rules

| Rule | Value | Defined in |
|------|-------|------------|
| Starting balance of a new account | 1000 T$, set by the server | `STARTING_BALANCE`, used in `users.service.ts` |
| Bet duration | 60 s from the moment the bet is placed | `BET_DURATION_SECONDS` |
| Win (price moved in the chosen direction) | stake × 1.85 credited (stake back + 85%) | `PAYOUT_MULTIPLIER` |
| Loss | the stake is lost | |
| Same price at the end | stake refunded | |
| Bet settled more than 10 s late (backend down) | stake refunded | `LATE_SETTLEMENT_MS` |
| Coins | those with a live Kraken price: BTC, ETH | `KrakenService` |

All values are in `bets.constants.ts`.

## How a bet works

1. `POST /users/me/bets` reads the live price from `KrakenService`, debits the
   stake and creates the bet (`status: "active"`, `expiresAt` = now + 60 s),
   all in one database transaction.
2. Every second, `BetsService` looks for active bets whose `expiresAt` has
   passed and settles them with the live price: it sets `status`, `exitPrice`,
   `payout` and `settledAt`, credits the payout and updates `wins`/`losses`
   on the user, again in one transaction.

### Why it is safe with many users at the same time

- **No overdraft**: the stake is debited with a single conditional update,
  `UPDATE "User" SET wallet = wallet - amount WHERE id = ? AND wallet >= amount`.
  PostgreSQL runs it atomically, so simultaneous bets can never take the
  balance below zero. Tested: 8 simultaneous bets of 300 T$ with 1000 T$ →
  exactly 3 accepted.
- **Never paid twice**: settlement only pays if it is the one that moves the
  bet out of `"active"` (`UPDATE ... WHERE id = ? AND status = 'active'`).
- **Prices come from the server**: the client only sends coin, direction and
  amount; it can never choose the entry or exit price, or its balance.

## Endpoints

All endpoints require a logged-in user: `Authorization: Bearer <token>`
(`JwtAuthGuard`), otherwise `401 Unauthorized`.

They live under `/users/me` because nginx already forwards `/users` to the
backend, so no nginx change was needed.

### `GET /users/me/balance` — Balance of the logged-in user

#### Response `200`

```json
{ "balance": 900 }
```

---

### `POST /users/me/bets` — Place a bet

#### Request body

```json
{ "coin": "BTC", "direction": "up", "amount": 100 }
```

`CreateBetDto` validation:

| Field       | Type    | Constraints                                   |
|-------------|---------|-----------------------------------------------|
| `coin`      | string  | required, 2–10 letters; must have a live price (BTC, ETH) |
| `direction` | string  | required, `up` or `down`                      |
| `amount`    | integer | required, 1 to 1,000,000, and ≤ the balance   |

Any other field is rejected (global `ValidationPipe` with `forbidNonWhitelisted`).

#### Response `201`

```json
{
  "bet": {
    "id": 12,
    "coin": "BTC",
    "direction": "up",
    "amount": 100,
    "entryPrice": 71956.6,
    "exitPrice": null,
    "status": "active",
    "payout": 0,
    "expiresAt": "2026-10-29T13:06:01.531Z",
    "settledAt": null,
    "createdAt": "2026-10-29T13:05:01.534Z",
    "userId": 3
  },
  "balance": 900
}
```

#### Errors `400 Bad Request`

```json
{ "message": "Insufficient balance", "error": "Bad Request", "statusCode": 400 }
{ "message": "No live price for DOGE", "error": "Bad Request", "statusCode": 400 }
```

Invalid fields return the usual validation messages.

---

### `GET /users/me/bets` — Bets of the logged-in user

Newest first. Query parameters (optional):

| Param    | Values                | Default |
|----------|-----------------------|---------|
| `status` | `active` or `settled` | all     |
| `limit`  | 1–100                 | 20      |

#### Response `200`

An array of bet objects (same shape as above). A settled bet has `status`
`won`, `lost` or `refunded`, plus `exitPrice`, `payout` and `settledAt`
(`exitPrice` is `null` for a bet refunded because it was settled too late).

## Bet fields

| Field        | Description |
|--------------|-------------|
| `coin`       | `BTC` or `ETH` |
| `direction`  | `up` or `down` |
| `amount`     | stake in T$, debited when the bet is placed |
| `entryPrice` | live price (EUR) when the bet was placed |
| `exitPrice`  | live price (EUR) when the bet was settled |
| `status`     | `active`, `won`, `lost` or `refunded` |
| `payout`     | T$ credited at settlement: `floor(amount × 1.85)` if won, `amount` if refunded, `0` if lost |
| `expiresAt`  | when the bet ends (placement + 60 s) |
| `settledAt`  | when the server settled it (at most about 1 s after `expiresAt`) |

## Frontend

The betting screen uses this module through `frontend/src/api/bets.js` (the
requests) and `frontend/src/hooks/useBets.js` (the balance, the bets and the
socket below). The browser only shows what the server decided:

- Guests see the prices but cannot bet: the bet controls are disabled and the
  forum and settings buttons open the login. The server refuses any bet
  without a valid token (`401`).
- The amount field accepts digits only, and the browser shows the same limits
  as the server (`1` to `1 000 000`, not above the balance) before anything is
  sent. The server checks them again (`400`).
- Each bet lasts 60 s from the moment it is placed: there are no rounds. The
  countdown under the price and on each active bet uses `expiresAt`.
- The candlestick chart draws each running bet as a line at its `entryPrice`:
  green for `up`, red for `down`. The line goes away when the bet is settled.
- When a bet is placed or settled, `bets:changed` arrives on the socket below,
  and the page reloads the balance, the active bets and the 8 latest results,
  then shows the result in a toast.
- Only `BTC` and `ETH` have live prices.
- The registration form still sends `wallet: 0`: it is ignored.

## Real-time channel

`BetsGateway` is the Socket.IO namespace `/bets`. The browser connects with its
login token, `io('/bets', { auth: { token } })`; a missing or invalid token is
disconnected. Each socket joins a room of its own user, and when one of that
user's bets is placed or settled the server emits `bets:changed` to that room
only. The betting screen and the analytics dashboard use it to reload by
themselves.

## Testing

`scripts/test-bets.sh` creates two users and checks every rule above through
nginx (about 75 seconds, because it waits for the bets to be settled).
`scripts/test-analytics.sh` also checks the `/bets` socket.

## Files

| File | Purpose |
|------|---------|
| `bets.constants.ts` | rules (starting balance, duration, payout, timings) |
| `bets.service.ts` | balance, placing and listing bets, settlement loop |
| `bets.controller.ts` | the three routes under `/users/me` |
| `bets.gateway.ts` | the `/bets` socket that tells a user their bets changed |
| `bets.module.ts` | wires Prisma, Auth, JWT and the Kraken price feed |
| `dto/create-bet.dto.ts`, `dto/list-bets.dto.ts` | request validation |
| `../../prisma/migrations/20261029125730_add_bets` | creates the `Bet` table |
