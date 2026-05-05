"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function env(key, defaultValue) {
    const v = process.env[key] ?? defaultValue;
    if (v === undefined)
        throw new Error(`Missing env: ${key}`);
    return v;
}
function envOptional(key) {
    return process.env[key];
}
function envNumber(key, defaultValue) {
    const v = process.env[key];
    if (v === undefined || v === "")
        return defaultValue;
    const n = Number(v);
    if (Number.isNaN(n))
        throw new Error(`Invalid number for ${key}: ${v}`);
    return n;
}
function envBool(key, defaultValue) {
    const v = process.env[key];
    if (v === undefined || v === "")
        return defaultValue;
    return v.toLowerCase() === "true" || v === "1";
}
/** Comma-separated list, e.g. MARKETS=eth,btc,sol */
function envList(key, defaultList) {
    const v = process.env[key];
    if (v === undefined || v === "")
        return defaultList;
    return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function loadConfig() {
    const production = envBool("PRODUCTION", false);
    const simulation = !production;
    return {
        polymarket: {
            gammaApiUrl: env("GAMMA_API_URL", "https://gamma-api.polymarket.com"),
            clobApiUrl: env("CLOB_API_URL", "https://clob.polymarket.com"),
            apiKey: envOptional("API_KEY"),
            apiSecret: envOptional("API_SECRET"),
            apiPassphrase: envOptional("API_PASSPHRASE"),
            privateKey: envOptional("PRIVATE_KEY"),
            proxyWalletAddress: envOptional("PROXY_WALLET_ADDRESS"),
            signatureType: envNumber("SIGNATURE_TYPE", 2),
            polymarketProxyUrl: envOptional("POLYMARKET_PROXY_URL"),
        },
        trading: {
            checkIntervalMs: envNumber("CHECK_INTERVAL_MS", 500),
            marketClosureCheckIntervalSeconds: envNumber("MARKET_CLOSURE_CHECK_INTERVAL_SECONDS", 10),
            markets: envList("MARKETS", ["btc"]),
            dashboardPort: envNumber("DASHBOARD_PORT", 3000),
            startingBalance: envNumber("STARTING_BALANCE", 20),
            scalper: {
                timeframe: env("TIMEFRAME", "5m"),
                maxPositionUsdc: envNumber("MAX_POSITION_USDC", 2),
                minPositionUsdc: envNumber("MIN_POSITION_USDC", 1),
                maxOpenPositions: envNumber("MAX_OPEN_POSITIONS", 3),
                dailyLossLimit: envNumber("DAILY_LOSS_LIMIT", 8),
                takeProfitPercent: envNumber("TAKE_PROFIT_PERCENT", 0.12),
                stopLossPercent: envNumber("STOP_LOSS_PERCENT", 0.20),
                entryThresholdPercent: envNumber("ENTRY_THRESHOLD_PERCENT", 0.10),
                maxEntryAsk: envNumber("MAX_ENTRY_ASK", 0.92),
                minEntryAsk: envNumber("MIN_ENTRY_ASK", 0.10),
                momentumWindowMs: envNumber("MOMENTUM_WINDOW_MS", 30000),
                scalpCooldownSeconds: envNumber("SCALP_COOLDOWN_SECONDS", 30),
                exitBeforeCloseSeconds: envNumber("EXIT_BEFORE_CLOSE_SECONDS", 15),
                binanceWsUrl: env("BINANCE_WS_URL", "wss://stream.binance.com:9443/ws/btcusdt@aggTrade"),
                entryDebugLogIntervalMs: envNumber("ENTRY_DEBUG_INTERVAL_MS", 30000),
                lateEntryEnabled: envBool("LATE_ENTRY_ENABLED", false),
                lateEntryWindowSeconds: envNumber("LATE_ENTRY_WINDOW_SECONDS", 90),
                lateEntryMinAsk: envNumber("LATE_ENTRY_MIN_ASK", 0.90),
                lateEntryMaxPositionUsdc: envNumber("LATE_ENTRY_MAX_POSITION_USDC", 15),
                holdToResolutionAskThreshold: envNumber("HOLD_TO_RESOLUTION_ASK_THRESHOLD", 0.92),
                whaleGuardSpreadLimit: envNumber("WHALE_GUARD_SPREAD_LIMIT", 4.0),
                whaleGuardSpikeThreshold: envNumber("WHALE_GUARD_SPIKE_THRESHOLD", 0.0015),
            },
        },
        simulation,
    };
}
//# sourceMappingURL=config.js.map