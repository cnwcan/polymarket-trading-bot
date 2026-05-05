"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const api_1 = require("./api");
const monitor_1 = require("./monitor");
const binanceWs_1 = require("./binanceWs");
const polymarketWs_1 = require("./polymarketWs");
const scalper_1 = require("./scalper");
const dashboard_1 = require("./dashboard");
const logger_1 = require("./logger");
const db_1 = require("./db");
const proxy_1 = require("./proxy");
function parseArgs() {
    const args = process.argv.slice(2);
    const production = args.includes("--production");
    const simulation = production ? false : (args.includes("--simulation") || true);
    return { simulation };
}
function getTimeframeDuration(tf) {
    if (tf === "5m")
        return 300;
    if (tf === "15m")
        return 900;
    if (tf === "1h")
        return 3600;
    return 300;
}
async function discoverMarket(api, asset, timeframe) {
    const slugPrefix = asset.toLowerCase();
    if (!["btc", "eth", "sol", "xrp"].includes(slugPrefix)) {
        throw new Error(`Unsupported asset: ${asset}`);
    }
    const duration = getTimeframeDuration(timeframe);
    const now = Math.floor(Date.now() / 1000);
    const currentPeriod = Math.floor(now / duration) * duration;
    const trySlug = async (slug) => {
        try {
            const market = await api.getMarketBySlug(slug);
            if (market.active && !market.closed)
                return market;
        }
        catch {
            // not found
        }
        return null;
    };
    // Try current period and a few previous ones
    for (let offset = 0; offset <= 3; offset++) {
        const ts = currentPeriod - offset * duration;
        const slug = `${slugPrefix}-updown-${timeframe}-${ts}`;
        console.error(`[Discovery] Trying: ${slug}`);
        const market = await trySlug(slug);
        if (market) {
            console.error(`[Discovery] Found: ${market.slug} | ${market.conditionId}`);
            return market;
        }
    }
    throw new Error(`No active ${asset} ${timeframe} market found`);
}
async function main() {
    (0, logger_1.initHistoryLog)("history.toml");
    (0, db_1.initDb)();
    const args = parseArgs();
    const config = (0, config_1.loadConfig)();
    const simulation = args.simulation !== false ? config.simulation : !config.simulation;
    const { scalper: scalperConfig } = config.trading;
    const timeframe = scalperConfig.timeframe;
    const duration = getTimeframeDuration(timeframe);
    if (config.polymarket.polymarketProxyUrl) {
        (0, proxy_1.setupProxy)(config.polymarket.polymarketProxyUrl);
    }
    (0, logger_1.logPrintln)("=== Polymarket 5m Scalper Bot ===");
    (0, logger_1.logPrintln)(`Mode: ${simulation ? "SIMULATION" : "PRODUCTION"}`);
    (0, logger_1.logPrintln)(`Timeframe: ${timeframe} (${duration}s)`);
    (0, logger_1.logPrintln)(`Position: $${scalperConfig.minPositionUsdc}-$${scalperConfig.maxPositionUsdc}`);
    (0, logger_1.logPrintln)(`Take profit: ${scalperConfig.takeProfitPercent * 100}% | Stop loss: ${scalperConfig.stopLossPercent * 100}%`);
    (0, logger_1.logPrintln)(`Entry threshold: ${scalperConfig.entryThresholdPercent}% in ${scalperConfig.momentumWindowMs / 1000}s`);
    (0, logger_1.logPrintln)(`Ask range: $${scalperConfig.minEntryAsk.toFixed(2)}-$${scalperConfig.maxEntryAsk.toFixed(2)}`);
    (0, logger_1.logPrintln)(`Cooldown: ${scalperConfig.scalpCooldownSeconds}s | Max open: ${scalperConfig.maxOpenPositions}`);
    (0, logger_1.logPrintln)(`Daily loss limit: $${scalperConfig.dailyLossLimit}`);
    (0, logger_1.logPrintln)("");
    const api = new api_1.PolymarketApi(config.polymarket);
    if (!simulation) {
        (0, logger_1.logPrintln)("Authenticating with Polymarket CLOB...");
        let authOk = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await api.authenticate();
                (0, logger_1.logPrintln)("Authentication successful");
                authOk = true;
                break;
            }
            catch (e) {
                (0, logger_1.logPrintln)(`[Auth] Attempt ${attempt}/3 failed: ${e}`);
                if (attempt < 3) {
                    const delay = attempt * 3000;
                    (0, logger_1.logPrintln)(`[Auth] Retrying in ${delay / 1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }
        if (!authOk) {
            (0, logger_1.logPrintln)("[Auth] FATAL: Authentication failed after 3 attempts. Cannot run in PRODUCTION mode without valid API credentials.");
            (0, logger_1.logPrintln)("[Auth] Check PRIVATE_KEY, SIGNATURE_TYPE, and PROXY_WALLET_ADDRESS in .env");
            process.exit(1);
        }
        // Startup allowance check (GitHub Issue #297: proxy wallet allowance cache bug)
        try {
            const { balance, allowance, ok } = await api.checkCollateralAllowance();
            if (!ok) {
                (0, logger_1.logPrintln)(`[Auth] FATAL: USDC allowance is 0 or insufficient (balance=$${balance.toFixed(2)}, allowance=$${allowance.toFixed(2)}). ` +
                    `All orders will fail with 'not enough balance/allowance'. ` +
                    `Fix: run 'polymarket approve set --signature-type proxy' or check SIGNATURE_TYPE in .env`);
                process.exit(1);
            }
            else {
                (0, logger_1.logPrintln)(`[Auth] Allowance check OK (balance=$${balance.toFixed(2)})`);
            }
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Auth] Allowance check failed — proceeding with caution: ${e}`);
        }
    }
    const asset = config.trading.markets[0] ?? "btc";
    (0, logger_1.logPrintln)(`Asset: ${asset.toUpperCase()}`);
    // Create feed objects and scalper early (dashboard needs references)
    const binance = new binanceWs_1.BinancePriceFeed(scalperConfig.binanceWsUrl);
    const polyFeed = new polymarketWs_1.PolymarketOrderbookFeed();
    const scalper = new scalper_1.Scalper(api, binance, polyFeed, scalperConfig, simulation);
    const live = { upTokenId: "", downTokenId: "", periodTs: 0 };
    const startedAt = Date.now();
    // Start dashboard FIRST so healthcheck passes during startup
    (0, dashboard_1.startDashboard)({
        scalper, binance, polyFeed,
        port: config.trading.dashboardPort,
        asset, startedAt,
        startingBalance: config.trading.startingBalance,
        getLive: () => live,
        duration,
    });
    (0, dashboard_1.sampleBinanceAggTick)();
    // Connect Binance WebSocket
    binance.connect();
    binance.on("tick", () => { });
    (0, logger_1.logPrintln)("Waiting for Binance price feed...");
    await new Promise((resolve) => {
        const check = () => {
            if (binance.lastPrice > 0)
                resolve();
            else
                setTimeout(check, 500);
        };
        check();
    });
    (0, logger_1.logPrintln)(`Binance connected. BTC/USDT: $${binance.lastPrice.toFixed(2)}`);
    // Discover initial market
    (0, logger_1.logPrintln)(`Discovering ${asset.toUpperCase()} ${timeframe} market...`);
    let currentMarket = await discoverMarket(api, asset, timeframe);
    const monitor = new monitor_1.MarketMonitor(api, `${asset.toUpperCase()} ${timeframe}`, currentMarket);
    // Resolve token IDs
    const tokens = await monitor.resolveTokenIds();
    if (!tokens.upTokenId || !tokens.downTokenId) {
        throw new Error("Failed to resolve Up/Down token IDs");
    }
    live.upTokenId = tokens.upTokenId;
    live.downTokenId = tokens.downTokenId;
    scalper.setMinOrderSizeShares(tokens.minOrderSizeShares);
    // Connect poly feed and set market on scalper
    polyFeed.connect([live.upTokenId, live.downTokenId]);
    (0, logger_1.logPrintln)("Waiting for Polymarket orderbook...");
    await new Promise((resolve) => {
        const check = () => {
            if (polyFeed.bestAsks.size > 0)
                resolve();
            else
                setTimeout(check, 500);
        };
        check();
    });
    (0, logger_1.logPrintln)("Polymarket orderbook connected");
    live.periodTs = monitor_1.MarketMonitor.extractTimestampFromSlug(currentMarket.slug);
    await scalper.setMarket({
        conditionId: currentMarket.conditionId,
        slug: currentMarket.slug,
        upTokenId: live.upTokenId,
        downTokenId: live.downTokenId,
        periodTimestamp: live.periodTs,
        periodEndTimestamp: live.periodTs + duration,
    });
    (0, logger_1.logPrintln)("Bot ready — waiting for Start from dashboard\n");
    // Stats reporter — reads from `live` so it always uses current period's tokens
    setInterval(() => {
        const stats = scalper.getStats();
        const upBid = polyFeed.bestBids.get(live.upTokenId) ?? 0;
        const upAsk = polyFeed.bestAsks.get(live.upTokenId) ?? 0;
        const downBid = polyFeed.bestBids.get(live.downTokenId) ?? 0;
        const downAsk = polyFeed.bestAsks.get(live.downTokenId) ?? 0;
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, live.periodTs + duration - now);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        (0, logger_1.logPrintln)(`[Status] BTC: $${binance.lastPrice.toFixed(0)} | ` +
            `Up: ${upBid.toFixed(2)}/${upAsk.toFixed(2)} Down: ${downBid.toFixed(2)}/${downAsk.toFixed(2)} | ` +
            `${mins}m${secs}s left | Phase: ${stats.phase} | ` +
            `Total: $${stats.totalProfit.toFixed(2)}`);
    }, 15000);
    // Period rollover loop
    (async () => {
        for (;;) {
            const nowTs = Math.floor(Date.now() / 1000);
            const nextPeriod = live.periodTs + duration;
            const sleepMs = Math.max(0, (nextPeriod - nowTs + 2) * 1000);
            await new Promise(r => setTimeout(r, sleepMs));
            (0, logger_1.logPrintln)("[Main] Period ended — discovering new market...");
            for (let attempt = 0; attempt < 10; attempt++) {
                try {
                    const newMarket = await discoverMarket(api, asset, timeframe);
                    if (newMarket.conditionId === currentMarket.conditionId) {
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                    currentMarket = newMarket;
                    await monitor.updateMarket(newMarket);
                    const newTokens = await monitor.resolveTokenIds();
                    if (!newTokens.upTokenId || !newTokens.downTokenId) {
                        (0, logger_1.logPrintln)("[Main] Failed to resolve new tokens, retrying...");
                        await new Promise(r => setTimeout(r, 3000));
                        continue;
                    }
                    live.upTokenId = newTokens.upTokenId;
                    live.downTokenId = newTokens.downTokenId;
                    scalper.setMinOrderSizeShares(newTokens.minOrderSizeShares);
                    live.periodTs = monitor_1.MarketMonitor.extractTimestampFromSlug(newMarket.slug);
                    await scalper.setMarket({
                        conditionId: newMarket.conditionId,
                        slug: newMarket.slug,
                        upTokenId: live.upTokenId,
                        downTokenId: live.downTokenId,
                        periodTimestamp: live.periodTs,
                        periodEndTimestamp: live.periodTs + duration,
                    });
                    (0, logger_1.logPrintln)(`[Main] New period: ${newMarket.slug}`);
                    break;
                }
                catch (e) {
                    console.warn("[Main] Market discovery failed:", e);
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
    })();
    // Graceful shutdown
    const shutdown = () => {
        (0, logger_1.logPrintln)("[Main] Shutting down...");
        scalper.stop();
        binance.close();
        polyFeed.close();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map