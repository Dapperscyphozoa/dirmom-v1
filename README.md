# DIRECTIONAL MOMENTUM V1

Slow-momentum trend-gated trading engine. Validated 180-day OKX backtest:

| Metric        | Value         |
|---------------|---------------|
| Sharpe        | **3.22**      |
| Annualised    | **+42.6%**    |
| Max Drawdown  | -6.5%         |
| WR            | 49.2%         |
| Trade freq    | ~0.04/hr      |

## Strategy

EMA(fast) × EMA(slow) crossover with ATR trail, gated to BTC trend regime.

| Asset | Fast | Slow | Trail | Alloc |
|-------|-----:|-----:|------:|------:|
| SOL   | 48   | 288  | 1.5×ATR | 40% |
| LINK  | 72   | 432  | 2.0×ATR | 35% |
| ETH   | 72   | 432  | 2.0×ATR | 25% |

Risk: 2% capital per trade. Trend regime = BTC drift > 200bps over 12hr + RV > 30bps.

## Run modes

### Local paper trading

```bash
npm install
PAPER_TRADING=true PAPER_EQUITY=100000 npm start
# → http://localhost:3000
```

### Render deploy (paper mode default)

```bash
git push origin dirmom-v1   # render.yaml auto-configures the service
```

### Live HL trading

Set `PAPER_TRADING=false` plus `HL_PRIVATE_KEY` and `HL_ADDRESS` env vars. Wire `hlClient` in `server.js` (already imported placeholder in engine.js).

## Endpoints

- `GET /` — dashboard (auto-refreshes 30s)
- `GET /health` — JSON status
- `GET /state` — full engine state
- `GET /signals` — last computed signal per asset
- `GET /trades` — closed trades log
- `POST /tick` — manual tick

## What was tested + killed (don't redo)

- Cointegration pairs / funding fade / breakout / fade-the-breakout / RSI reversion / Bollinger / pullback-in-trend / pullback overlay → all lost in 180d sweep.
- Only slow-MOM + HMM trend gate survived. This is the engine.
