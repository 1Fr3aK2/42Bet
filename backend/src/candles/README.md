# Candles module

Candlestick data for the price chart of the betting screen
(`frontend/src/components/PriceChart.jsx`, drawn with TradingView Lightweight
Charts).

## Route

`GET /crypto/:coin/candles?interval=N`: public, like the live price
`GET /crypto/:coin`. It lives under `/crypto` because nginx already forwards
that prefix to the backend.

| Parameter  | Values                       | Default |
|------------|------------------------------|---------|
| `coin`     | `BTC` or `ETH`               |         |
| `interval` | minutes per candle: `1`, `5`, `15` or `60` | `1` |

Response `200`: the last 720 candles (Kraken's maximum), oldest first. The
newest one is still open: its `close` is the latest price.

```json
[{ "time": 1793299260, "open": 72163.8, "high": 72163.8, "low": 72144, "close": 72144 }]
```

`time` is the start of the candle in seconds since 1970 (UTC). Errors: `400`
for another coin or interval, `502` when Kraken cannot be reached and no
earlier copy is kept.

## How it works

`CandlesService` reads Kraken's public OHLC endpoint
(`https://api.kraken.com/0/public/OHLC`, pairs `XBTEUR` and `ETHEUR`): the same
exchange as the live feed that settles the bets, so the chart and the results
use the same prices. Kraken allows about one public call per second, so each
list is kept for 15 seconds and shared by every browser; if Kraken fails, the
last copy is returned. Between two loads, the browser moves the last candle
itself with every live price received on the Socket.IO feed.

## Files

| File | Role |
|------|------|
| `candles.controller.ts` | The route |
| `candles.service.ts` | Kraken call, conversion and the 15 s cache |
| `dto/candles-query.dto.ts` | Validation of `interval` |
| `candles.module.ts` | Registered in `app.module.ts` |
