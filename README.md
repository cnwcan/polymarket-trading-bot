<h1 align="center">Polymarket Scalper Bot</h1>

<p align="center"><strong>Automate Polymarket crypto Up/Down with two live feeds, a risk-aware momentum engine, and an operator-grade dashboard—simulate before you ever risk a dollar.</strong></p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-16+-green.svg" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5+-blue.svg" alt="TypeScript" /></a>
  <img src="https://img.shields.io/badge/License-Apache%202.0-yellow.svg" alt="License" />
</p>

<p align="center">
  <img src="image/banner.png" alt="Poly Scalper" width="100%" />
</p>

<p align="center">
  <a href="#get-started-in-2-minutes">Get started</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#stack--algorithms">Stack & algorithms</a> ·
  <a href="#execution-algorithms-deep-dive">Deep algorithms</a> ·
  <a href="#disclaimer">Disclaimer</a>
</p>

---

## Why people open this repo

| You want… | This repo delivers… |
|-----------|---------------------|
| **Speed to truth** | **Simulation-first**: run the full decision stack with **zero** live orders (`PRODUCTION=false`). |
| **Edge, not spaghetti** | **Binance WebSocket** momentum + **Polymarket CLOB** order-book depth—not a toy poll loop. |
| **Control from the couch** | **React** dashboard: start/stop, mode, position bands, auto-scale, sessions, logs—plus JSON **API** for automation. |
| **Production hygiene** | **TypeScript**, **SQLite WAL** journaling, **Docker** + **`/api/health`**, optional **Telegram** fills to your phone. |

---

## Operator spotlight *(anecdotal — not typical)*

> **Not financial advice. Past performance ≠ future results.**

Teams that care about **latency** sometimes tune **EU network paths** (e.g. **Frankfurt → Zurich** transit toward Polygon-facing infra) to tighten round-trips to quotes and the CLOB. In **one** reported setup, an operator described growing roughly **USD 20 → USD 2,600 over ~twelve days** during volatile, favorable conditions—**most deployments will not look like this** (fees, slippage, outages, and losses are normal).

---

## Get started in 2 minutes

```bash
git clone <your-repo-url> && cd poly-main
npm install && cp .env.example .env
npm run build && npm run build:dashboard
npm run dev
```

Open **`http://localhost:3000`** — tune `.env`, flip **`PRODUCTION`** only when you understand the risk.

---

## What you get

| Pillar | What it means for you |
|--------|------------------------|
| **Two-stream intelligence** | Spot **momentum** (Binance) meets outcome **liquidity** (Polymarket best bid/ask) before any entry. |
| **Risk rails** | Daily loss cap, position min/max, cooldowns, optional **Whale Guard** (BTC spike + spread chaos filter). |
| **Advanced exits** | Take-profit / stop-loss discipline, optional **late entry**, optional **hold toward resolution** near expiry. |
| **Ops that scale** | Session + trade history in **SQLite**, append-only **`history.toml`**, optional **Telegram** on closed trades. |
| **Ship anywhere** | **Dockerfile** multi-stage build; health URL ready for Kubernetes / PaaS. |

---

## Overview

- **Markets** – Gamma discovery for `{asset}-updown-{timeframe}-{periodStart}` · assets: `btc`, `eth`, `sol`, `xrp` (**first** `MARKETS` wins).
- **Timeframes** – **`5m` · `15m` · `1h`** (default **5m**).
- **Live trading** – **`@polymarket/clob-client`** + **ethers** signer; API keys derived from **`PRIVATE_KEY`** unless you set **`API_*`** explicitly.
- **Persistence** – **`sessions.db`** + **`history.toml`** (gitignored locally).

Full knobs: **`.env.example`** → **`src/config.ts`** & **`src/scalper.ts`**.

---

## Stack & algorithms

### Technology stack

| Layer | Choices | Why it matters |
|--------|---------|----------------|
| **Runtime** | Node **16+** | One process runs bot + HTTP dashboard + APIs. |
| **Language** | **TypeScript** → `dist/` | Shared types across strategy, CLOB, and UI. |
| **Trading** | **Polygon**, **ethers v5**, **`@polymarket/clob-client`** | Official CLOB path: sign, derive keys, place & redeem. |
| **Data plane** | **`ws`** × 2 (Binance + Polymarket books) | Streaming-first, not blind polling. |
| **Storage** | **better-sqlite3** WAL | Fast trade/session ledger. |
| **UI** | **React 18**, **Vite 5**, **Chart.js** | Dashboard builds into **`public/`**, served by same server as **`/api/*`**. |
| **Deploy** | **Docker** + **`GET /api/health`** | Image-ready for serious hosting. |

### Execution algorithms (deep dive)

Everything below maps to **`src/scalper.ts`** plus spread telemetry in **`src/polymarketWs.ts`** and swing stats in **`src/binanceWs.ts`**. For exact constants and ordering, read **`checkEntrySignal`**, **`computeSmartPositionSize`**, **`checkExitConditions`**, **`executeBuy`**, **`checkLateEntrySignal`**.

#### Dual-stream signal fusion

- **Plane A (Binance)** – Measures spot momentum over **`MOMENTUM_WINDOW_MS`** vs **`ENTRY_THRESHOLD_PERCENT`** (rally vs dip legs).
- **Plane B (Polymarket)** – Requires Up/Down **asks** in **`MIN_ENTRY_ASK`–`MAX_ENTRY_ASK`** and maintains **rolling spread history** so we know when the touchline is **normal vs stressed**.

#### Whale Guard — two independent crash filters

Before sizing:

1. **BTC shock** – `getMaxSwing(5000)` must stay under **`WHALE_GUARD_SPIKE_THRESHOLD`** or the tape is “too hot”.
2. **Spread explosion** – `getSpreadExpansion(tokenId, 10000)` returns **current spread ÷ median spread** over that window; above **`WHALE_GUARD_SPREAD_LIMIT`** ⇒ **liquidity vacuum**, skip entry.

Optional **late-entry** applies its **own** tight **5s BTC spike cap** (hard-coded gate in `checkLateEntrySignal`) so last-minute punts don’t fire into a climax candle.

#### Daily loss fuse & inventory caps

Before hunting new entries, the tick checks **`dailyLoss >= DAILY_LOSS_LIMIT`** — if tripped, **new risk stops** and any **open position** is exited under **`daily_loss_limit`**. Separately, **`MAX_OPEN_POSITIONS`**, **`SCALP_COOLDOWN_SECONDS`**, and the **“too close to expiry”** buffer prevent stacking correlated bets into settlement noise.

#### Smart position sizing — Half-Kelly × momentum × spread quality

`computeSmartPositionSize` is **not** fixed-share sizing:

1. **Half-Kelly** style edge on binary asks — win-rate prior **ramps with momentum strength**, then **Kelly-like** fraction with **half-Kelly** damping for variance.
2. **Momentum score** – Rewards signals that **clear** the threshold by a wide margin vs noise barely crossing.
3. **Spread quality** – Penalizes wide bid/ask (maps toward **0.2** quality); rewards tight books (**→ 1.0**).

The blend becomes a **confidence** scalar; USD size snaps into **`MIN_POSITION_USDC`–`MAX_POSITION_USDC`** with exchange realities (**$1** min, share rounding). **`BUY_FEE_BUFFER`** (~**1.025**) absorbs fee slack.

#### Live execution — retries, slippage fuse, geo discipline

- **Pre-trade balance sync**; **geo/API** errors can trip **cooldown** instead of blind retry spam.
- **Up to 3** buy attempts with backoff; **aborts** if ask runs **>15%** from the working price or if **~90%** collateral would be consumed.
- **500 ms** tick while running — fast enough for **5m** markets.

#### Exit stack — beyond “TP / SL”

1. **`TAKE_PROFIT_PERCENT`**
2. **Rapid reversal** – If the position is only **3s** old (sim) or **10s** (live) and P&amp;L already **≤ −30%** (sim) or **≤ −40%** (live), **emergency exit** (wider live window = settlement/reality lag).
3. **`STOP_LOSS_PERCENT`**
4. **Period clock** – Inside **`EXIT_BEFORE_CLOSE_SECONDS`**, **force flat** (`period_ending`) because short-horizon tokens don’t auto-teleport back to USDC; the code explicitly prioritizes **not** being bag-held into resolution mess.

**Stuck sells**: `stuck_retry` ladder → **`sell_abandoned`** after **`MAX_SELL_STUCK_RETRIES`**. **Phantom protection**: if conditional token balance is **0** on abandon, **no P&amp;L** is booked.

Other reasons include **`daily_loss_limit`**, **`force_exit_rollover`**, CLOB min-size paths — see **`describeExitReason`** for the full vocabulary surfaced to Telegram/UI.

#### Optional lanes & housekeeping

- **Late entry** – When enabled + inside **`LATE_ENTRY_WINDOW_SECONDS`**, hunts **`LATE_ENTRY_MIN_ASK`** with **`LATE_ENTRY_MAX_POSITION_USDC`** caps (typically ≤ **80%** live collateral).
- **Auto-scale** – Dashboard rescales min/max vs **live equity** curve.
- **Hold-to-resolution** knobs exist for narrative trades, but **short candles** still emphasize **flattening before expiry** when inventory risk dominates — follow the comments beside period-end logic.
- **~60s** optional balance refresh during live ticks (`PERIODIC_SYNC_INTERVAL_MS`).

#### Simulation fidelity

Paper trading mirrors branch logic without sending orders and can append **`simulation_trades.jsonl`** for offline analytics.

---

## Features (checklist)

| Area | Capability |
|------|----------------|
| Trading | Scalper loop · daily loss cap · sim vs live |
| APIs | Gamma discovery · CLOB orders & redeem · optional **`POLYMARKET_PROXY_URL`** |
| Feeds | Binance WS + Polymarket order book WS |
| Dashboard | Status · controls · history · logs → `npm run build:dashboard` → `public/` |
| Alerts | Optional Telegram (**`TELEGRAM_BOT_TOKEN`**, **`TELEGRAM_CHAT_ID`**) |
| Ops | **`GET /api/health`** for orchestrators |

## Prerequisites

- **Node.js 16+**
- **Polygon** wallet + USDC for live trading; POL/MATIC for redemptions
- **Production:** `PRIVATE_KEY`, `PROXY_WALLET_ADDRESS`, correct `SIGNATURE_TYPE`

## Scripts

| Command | What it does |
|---------|----------------|
| `npm run dev` | `ts-node src/main.ts` |
| `npm run build` | `tsc` → `dist/` |
| `npm run build:dashboard` | Vite → `public/` |
| `npm start` / `npm run sim` / `npm run prod` | Compiled bot · force sim · force prod |

## Configuration

See **`.env.example`**. Never commit **`.env`**.

## HTTP API *(same port as the UI)*

`GET /api/health` · `GET /api/status` · `POST /api/control` · `GET /api/sessions` · `GET /api/logs` — full list in **`src/dashboard.ts`**.

## Docker

```bash
docker build -t poly-scalper .
docker run --env-file .env -p 3000:3000 -v poly-data:/app/data poly-scalper
```

Build the dashboard **before** `docker build` if you changed the UI.

## Project layout

| Path | Role |
|------|------|
| `src/main.ts` | Wiring: config, feeds, dashboard, discovery, scalper |
| `src/scalper.ts` | Strategy core |
| `src/api.ts` | Gamma + CLOB |
| `src/dashboard.ts` | HTTP + static `public/` |
| `src/db.ts` | SQLite |
| `dashboard/` | React source · `public/` = build output |

## Troubleshooting

- **Auth fails** → keys, `SIGNATURE_TYPE`, network, proxy/geo.
- **Allowance errors** → USDC allowance for your Polymarket wallet model.
- **No market** → `MARKETS` / `TIMEFRAME` vs active Gamma markets.
- **Blank UI** → run `npm run build:dashboard`.

## Security

Never commit secrets. Prefer simulation. Use a **dedicated** wallet with limited funds.

## Disclaimer

Software is **as-is** for education and research. Prediction markets involve **major risk of loss**. **Past performance— including anecdotes in this README—is not indicative of future results.** Not investment, legal, or tax advice. You alone are responsible for compliance and losses.

## License

Apache License 2.0 — see [LICENSE](LICENSE) when present in the repository.
