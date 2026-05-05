"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinancePriceFeed = void 0;
const ws_1 = __importDefault(require("ws"));
const events_1 = require("events");
class BinancePriceFeed extends events_1.EventEmitter {
    constructor(url) {
        super();
        this.ws = null;
        this.closed = false;
        this.backoffMs = 1000;
        this.maxBackoffMs = 30000;
        this.pingIntervalId = null;
        this.reconnectTimeoutId = null;
        this.zombieCheckId = null;
        this.lastMessageAt = 0;
        this.ZOMBIE_TIMEOUT_MS = 15000;
        this.priceHistory = [];
        this.historyWindowMs = 90000;
        this.lastPrice = 0;
        this.url = url;
    }
    connect() {
        this.closed = false;
        this.backoffMs = 1000;
        this.doConnect();
    }
    doConnect() {
        if (this.closed)
            return;
        try {
            this.ws = new ws_1.default(this.url);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws.on("open", () => {
            console.error("[BinanceWS] Connected");
            this.backoffMs = 1000;
            this.lastMessageAt = Date.now();
            this.startPing();
            this.startZombieCheck();
        });
        this.ws.on("message", (raw) => {
            this.lastMessageAt = Date.now();
            try {
                const data = JSON.parse(raw.toString());
                const price = parseFloat(data.p ?? "0");
                const tradeTs = typeof data.T === "number" ? data.T : Date.now();
                if (price <= 0)
                    return;
                this.lastPrice = price;
                const ts = typeof tradeTs === "number" && tradeTs > 1e12 ? tradeTs : Date.now();
                this.priceHistory.push({ price, ts });
                this.trimHistory(ts);
                const tick = { price, timestamp: ts };
                this.emit("tick", tick);
            }
            catch {
                // malformed
            }
        });
        this.ws.on("close", () => {
            console.error("[BinanceWS] Disconnected");
            this.stopPing();
            this.stopZombieCheck();
            this.scheduleReconnect();
        });
        this.ws.on("error", (err) => {
            console.error("[BinanceWS] Error:", err.message);
        });
        this.ws.on("pong", () => { });
    }
    getRecentChange(windowMs) {
        const now = Date.now();
        this.trimHistory(now);
        if (this.priceHistory.length < 2)
            return 0;
        const cutoff = now - windowMs;
        let oldest = null;
        for (const entry of this.priceHistory) {
            if (entry.ts >= cutoff) {
                oldest = entry;
                break;
            }
        }
        if (!oldest)
            oldest = this.priceHistory[0];
        const latest = this.priceHistory[this.priceHistory.length - 1];
        if (oldest.price <= 0)
            return 0;
        return (latest.price - oldest.price) / oldest.price;
    }
    /**
     * Returns the max absolute price change (%) within any sub-window of
     * the last `windowMs`. Used to detect sudden whale spikes.
     */
    getMaxSwing(windowMs) {
        const now = Date.now();
        this.trimHistory(now);
        const cutoff = now - windowMs;
        let min = Infinity;
        let max = -Infinity;
        for (const entry of this.priceHistory) {
            if (entry.ts < cutoff)
                continue;
            if (entry.price < min)
                min = entry.price;
            if (entry.price > max)
                max = entry.price;
        }
        if (min === Infinity || min <= 0)
            return 0;
        return (max - min) / min;
    }
    trimHistory(now) {
        const cutoff = now - this.historyWindowMs;
        while (this.priceHistory.length > 0 && this.priceHistory[0].ts < cutoff) {
            this.priceHistory.shift();
        }
    }
    startPing() {
        this.stopPing();
        this.pingIntervalId = setInterval(() => {
            if (this.ws?.readyState === ws_1.default.OPEN) {
                this.ws.ping();
            }
        }, 15000);
    }
    stopPing() {
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
            this.pingIntervalId = null;
        }
    }
    startZombieCheck() {
        this.stopZombieCheck();
        this.zombieCheckId = setInterval(() => {
            const silentMs = Date.now() - this.lastMessageAt;
            if (silentMs > this.ZOMBIE_TIMEOUT_MS) {
                console.error(`[BinanceWS] Zombie detected (${Math.round(silentMs / 1000)}s silent) — reconnecting`);
                this.stopPing();
                this.stopZombieCheck();
                if (this.ws) {
                    this.ws.removeAllListeners();
                    this.ws.close();
                    this.ws = null;
                }
                this.doConnect();
            }
        }, 5000);
    }
    stopZombieCheck() {
        if (this.zombieCheckId) {
            clearInterval(this.zombieCheckId);
            this.zombieCheckId = null;
        }
    }
    scheduleReconnect() {
        if (this.closed)
            return;
        console.error(`[BinanceWS] Reconnecting in ${this.backoffMs}ms...`);
        this.reconnectTimeoutId = setTimeout(() => {
            this.doConnect();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
    close() {
        this.closed = true;
        this.stopPing();
        this.stopZombieCheck();
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
    }
}
exports.BinancePriceFeed = BinancePriceFeed;
//# sourceMappingURL=binanceWs.js.map