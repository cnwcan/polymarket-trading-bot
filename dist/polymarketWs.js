"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolymarketOrderbookFeed = void 0;
const ws_1 = __importDefault(require("ws"));
const events_1 = require("events");
const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const ZOMBIE_TIMEOUT_MS = 30000;
class PolymarketOrderbookFeed extends events_1.EventEmitter {
    constructor(reconnectMs = 1500) {
        super();
        this.ws = null;
        this.assetIds = [];
        this.pingIntervalId = null;
        this.reconnectTimeoutId = null;
        this.zombieCheckId = null;
        this.closed = false;
        this.lastMessageAt = 0;
        this.bestBids = new Map();
        this.bestAsks = new Map();
        this.spreadHistory = new Map();
        this.SPREAD_HISTORY_MS = 30000;
        this.reconnectMs = reconnectMs;
    }
    connect(assetIds) {
        this.assetIds = assetIds;
        this.closed = false;
        this.doConnect();
    }
    updateSubscription(assetIds) {
        this.assetIds = assetIds;
        this.bestBids.clear();
        this.bestAsks.clear();
        this.spreadHistory.clear();
        this.stopPing();
        this.stopZombieCheck();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        this.doConnect();
    }
    doConnect() {
        if (this.closed)
            return;
        try {
            this.ws = new ws_1.default(POLYMARKET_WS_URL);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws.on("open", () => {
            console.error("[PolyWS] Connected");
            this.lastMessageAt = Date.now();
            this.subscribe();
            this.startPing();
            this.startZombieCheck();
        });
        this.ws.on("message", (raw) => {
            this.lastMessageAt = Date.now();
            const text = raw.toString();
            if (text === "PONG")
                return;
            try {
                const msg = JSON.parse(text);
                this.handleMessage(msg);
            }
            catch {
                // malformed
            }
        });
        this.ws.on("close", () => {
            console.error("[PolyWS] Disconnected");
            this.stopPing();
            this.stopZombieCheck();
            this.scheduleReconnect();
        });
        this.ws.on("error", (err) => {
            console.error("[PolyWS] Error:", err.message);
        });
    }
    subscribe() {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN)
            return;
        if (this.assetIds.length === 0)
            return;
        this.ws.send(JSON.stringify({
            assets_ids: this.assetIds,
            type: "market",
            custom_feature_enabled: true,
        }));
        console.error(`[PolyWS] Subscribed to ${this.assetIds.length} assets`);
    }
    handleMessage(msg) {
        const eventType = msg.event_type;
        if (!eventType)
            return;
        switch (eventType) {
            case "book":
                this.handleBook(msg);
                break;
            case "best_bid_ask":
                this.handleBestBidAsk(msg);
                break;
            case "price_change":
                this.handlePriceChange(msg);
                break;
            case "last_trade_price":
                this.handleLastTrade(msg);
                break;
        }
    }
    applyTouchline(assetId, bestBid, bestAsk) {
        if (!(bestBid > 0 && bestAsk > 0 && bestBid < bestAsk && bestAsk <= 1.01))
            return false;
        const spread = bestAsk - bestBid;
        if (spread > 0.9)
            return false;
        this.bestBids.set(assetId, bestBid);
        this.bestAsks.set(assetId, bestAsk);
        const now = Date.now();
        let hist = this.spreadHistory.get(assetId);
        if (!hist) {
            hist = [];
            this.spreadHistory.set(assetId, hist);
        }
        hist.push({ spread, ts: now });
        const cutoff = now - this.SPREAD_HISTORY_MS;
        while (hist.length > 0 && hist[0].ts < cutoff)
            hist.shift();
        return true;
    }
    /**
     * Returns the current spread vs the median spread over the last
     * windowMs. A ratio > 2 means spread doubled (liquidity vacuum).
     */
    getSpreadExpansion(assetId, windowMs = 10000) {
        const hist = this.spreadHistory.get(assetId);
        if (!hist || hist.length < 3)
            return 1;
        const cutoff = Date.now() - windowMs;
        const recent = hist.filter(h => h.ts >= cutoff);
        if (recent.length < 2)
            return 1;
        const sorted = recent.map(h => h.spread).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (median <= 0)
            return 1;
        const currentSpread = recent[recent.length - 1].spread;
        return currentSpread / median;
    }
    handleBook(msg) {
        const assetId = msg.asset_id;
        const rawBids = msg.bids;
        const rawAsks = msg.asks;
        const bids = (rawBids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
        const asks = (rawAsks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
        if (bids.length > 0 && asks.length > 0) {
            const bestBid = Math.max(...bids.map(b => b.price));
            const bestAsk = Math.min(...asks.map(a => a.price));
            this.applyTouchline(assetId, bestBid, bestAsk);
        }
        else if (bids.length > 0) {
            const bestBid = Math.max(...bids.map(b => b.price));
            const ask = this.bestAsks.get(assetId);
            if (ask !== undefined && ask > 0)
                this.applyTouchline(assetId, bestBid, ask);
        }
        else if (asks.length > 0) {
            const bestAsk = Math.min(...asks.map(a => a.price));
            const bid = this.bestBids.get(assetId);
            if (bid !== undefined && bid > 0)
                this.applyTouchline(assetId, bid, bestAsk);
        }
        const snapshot = {
            assetId,
            market: msg.market,
            bids, asks,
            timestamp: parseInt(msg.timestamp, 10),
        };
        this.emit("book", snapshot);
    }
    handleBestBidAsk(msg) {
        const assetId = msg.asset_id;
        const bestBid = parseFloat(msg.best_bid);
        const bestAsk = parseFloat(msg.best_ask);
        const ok = this.applyTouchline(assetId, bestBid, bestAsk);
        if (!ok)
            return;
        const spread = bestAsk - bestBid;
        const bba = {
            assetId, bestBid, bestAsk, spread,
            timestamp: parseInt(msg.timestamp, 10),
        };
        this.emit("bestBidAsk", bba);
    }
    handlePriceChange(msg) {
        const changes = msg.price_changes;
        if (!changes)
            return;
        for (const ch of changes) {
            const assetId = ch.asset_id;
            const prevBid = this.bestBids.get(assetId) ?? 0;
            const prevAsk = this.bestAsks.get(assetId) ?? 0;
            const newBid = ch.best_bid !== undefined && ch.best_bid !== "" ? parseFloat(ch.best_bid) : prevBid;
            const newAsk = ch.best_ask !== undefined && ch.best_ask !== "" ? parseFloat(ch.best_ask) : prevAsk;
            if (newBid > 0 && newAsk > 0) {
                this.applyTouchline(assetId, newBid, newAsk);
            }
        }
        this.emit("priceChange", msg);
    }
    handleLastTrade(msg) {
        const trade = {
            assetId: msg.asset_id,
            price: parseFloat(msg.price),
            size: parseFloat(msg.size),
            side: msg.side,
            timestamp: parseInt(msg.timestamp, 10),
        };
        this.emit("lastTrade", trade);
    }
    startPing() {
        this.stopPing();
        this.pingIntervalId = setInterval(() => {
            if (this.ws?.readyState === ws_1.default.OPEN) {
                this.ws.send("PING");
            }
        }, 10000);
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
            if (silentMs > ZOMBIE_TIMEOUT_MS) {
                console.error(`[PolyWS] Zombie detected (${Math.round(silentMs / 1000)}s silent) — reconnecting`);
                this.stopPing();
                this.stopZombieCheck();
                if (this.ws) {
                    this.ws.removeAllListeners();
                    this.ws.close();
                    this.ws = null;
                }
                this.doConnect();
            }
        }, 10000);
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
        this.reconnectTimeoutId = setTimeout(() => {
            console.error("[PolyWS] Reconnecting...");
            this.doConnect();
        }, this.reconnectMs);
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
exports.PolymarketOrderbookFeed = PolymarketOrderbookFeed;
//# sourceMappingURL=polymarketWs.js.map