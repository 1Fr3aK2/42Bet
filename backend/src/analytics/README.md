# Analytics Module (`backend/src/analytics`)

## What it does

Statistics of the logged-in user's bets, for the analytics dashboard
(module "Advanced analytics dashboard", Data and Analytics, Major). One endpoint
returns the summary figures, the chart series and the bets for a period and
filters chosen by the user. The dashboard in `frontend/src/components/Analytics`
draws the charts, exports CSV, JSON and PDF, and reloads in real time through
the `/bets` socket.

## Endpoint

### `GET /users/me/analytics` — Statistics of the user's bets

**Auth**: `JwtAuthGuard` (`Authorization: Bearer <token>`), otherwise `401`.
It lives under `/users/me` because nginx already forwards `/users`.

#### Query parameters (all optional)

| Param       | Type    | Meaning |
|-------------|---------|---------|
| `from`, `to` | ISO date | Period; a bet counts when it was **placed** in it |
| `coin`      | string  | `BTC` or `ETH` (2–10 letters, any case) |
| `direction` | string  | `up` or `down` |
| `tzOffset`  | integer | The browser's `Date.getTimezoneOffset()` (−840 to 840), to group by the user's local day |

Invalid values, unknown parameters, or `from` after `to` → `400`.

#### Response `200`

```json
{
  "summary": {
    "balance": 954, "bets": 10, "active": 0, "won": 4, "lost": 6, "refunded": 0,
    "winRate": 40, "wagered": 860, "paidOut": 814, "profit": -46,
    "bestBet": 170, "worstBet": -150
  },
  "profitOverTime": [{ "time": "2026-10-27T13:15:02.110Z", "profit": 85 }],
  "profitByDay": [{ "day": "2026-10-27", "profit": 3, "bets": 3 }],
  "byCoin": [{ "name": "BTC", "bets": 4, "won": 2, "lost": 2, "refunded": 0, "winRate": 50, "profit": -26 }],
  "byDirection": [{ "name": "up", "bets": 6, "won": 4, "lost": 2, "refunded": 0, "winRate": 66.7, "profit": 74 }],
  "bets": [{ "id": 31, "coin": "ETH", "direction": "up", "amount": 10, "status": "lost", "...": "..." }],
  "betsTruncated": false
}
```

| Field | Meaning |
|-------|---------|
| `summary.balance` | current balance (not filtered) |
| `summary.winRate` | won ÷ (won + lost), in %, one decimal; `null` when no bet was won or lost |
| `summary.profit` | sum of `payout − amount` of the settled bets |
| `summary.bestBet`, `worstBet` | highest and lowest profit of one settled bet |
| `profitOverTime` | running total of the profit, one point per settled bet, in settlement order |
| `profitByDay` | profit and number of settled bets per local day |
| `byCoin`, `byDirection` | the same counts per coin and per direction |
| `bets` | the bets, newest first, at most 500 (`betsTruncated` says when there were more) |

## Real-time updates

The betting engine has a Socket.IO namespace, `/bets` (`BetsGateway` in
`backend/src/bets`). The page connects with `io('/bets', { auth: { token } })`;
a missing or invalid token is disconnected. When one of the user's bets is
placed or settled, the server emits `bets:changed` to that user only, and the
dashboard reloads.

## Frontend

| File | Purpose |
|------|---------|
| `frontend/src/components/Analytics/AnalyticsDashboard.jsx` | The page at `#/analytics` (Analytics button in the navbar): filters (7 days, 30 days, all time, dates, coin, direction), 6 KPI tiles, 4 charts with data tables, latest bets, live indicator |
| `frontend/src/components/Analytics/exporters.js` | CSV (the bets), JSON (everything shown) and PDF (an A4 text report written without a library) |
| `frontend/src/style.css` (section ANALYTICS DASHBOARD) and `frontend/src/responsive.css` | Styles, and the phone layout |
| `frontend/src/api/analytics.js` | The request to this endpoint |

## Testing

`scripts/test-analytics.sh` checks the endpoint, its filters and validation,
and the `/bets` socket, through nginx (about 10 seconds).

## Files

| File | Purpose |
|------|---------|
| `analytics.service.ts` | Reads the bets and computes every figure |
| `analytics.controller.ts` | The route |
| `analytics.module.ts` | Wires Prisma and Auth |
| `dto/analytics-query.dto.ts` | Validation of the query parameters |
