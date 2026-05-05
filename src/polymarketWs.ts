import WebSocket from "ws";
import { EventEmitter } from "events";

const POLYMARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const ZOMBIE_TIMEOUT_MS = 30_000;

export interface BookSnapshot {
  assetId: string;
  market: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
}

export interface BestBidAsk {
  assetId: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  timestamp: number;
}

export interface LastTrade {
  assetId: string;
  price: number;
  size: number;
  side: string;
  timestamp: number;
}

export class PolymarketOrderbookFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private assetIds: string[] = [];
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private zombieCheckId: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private reconnectMs: number;
  private lastMessageAt = 0;

  bestBids = new Map<string, number>();
  bestAsks = new Map<string, number>();
  private spreadHistory = new Map<string, Array<{ spread: number; ts: number }>>();
  private readonly SPREAD_HISTORY_MS = 30_000;

  constructor(reconnectMs = 1500) {
    super();
    this.reconnectMs = reconnectMs;
  }

  connect(assetIds: string[]): void {
    this.assetIds = assetIds;
    this.closed = false;
    this.doConnect();
  }

  updateSubscription(assetIds: string[]): void {
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

  private doConnect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(POLYMARKET_WS_URL);
    } catch {
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

    this.ws.on("message", (raw: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      const text = raw.toString();
      if (text === "PONG") return;
      try {
        const msg = JSON.parse(text);
        this.handleMessage(msg);
      } catch {
        // malformed
      }
    });

    this.ws.on("close", () => {
      console.error("[PolyWS] Disconnected");
      this.stopPing();
      this.stopZombieCheck();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[PolyWS] Error:", err.message);
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.assetIds.length === 0) return;
    this.ws.send(JSON.stringify({
      assets_ids: this.assetIds,
      type: "market",
      custom_feature_enabled: true,
    }));
    console.error(`[PolyWS] Subscribed to ${this.assetIds.length} assets`);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const eventType = msg.event_type as string | undefined;
    if (!eventType) return;

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

  private applyTouchline(assetId: string, bestBid: number, bestAsk: number): boolean {
    if (!(bestBid > 0 && bestAsk > 0 && bestBid < bestAsk && bestAsk <= 1.01)) return false;
    const spread = bestAsk - bestBid;
    if (spread > 0.9) return false;
    this.bestBids.set(assetId, bestBid);
    this.bestAsks.set(assetId, bestAsk);

    const now = Date.now();
    let hist = this.spreadHistory.get(assetId);
    if (!hist) { hist = []; this.spreadHistory.set(assetId, hist); }
    hist.push({ spread, ts: now });
    const cutoff = now - this.SPREAD_HISTORY_MS;
    while (hist.length > 0 && hist[0].ts < cutoff) hist.shift();

    return true;
  }

  /**
   * Returns the current spread vs the median spread over the last
   * windowMs. A ratio > 2 means spread doubled (liquidity vacuum).
   */
  getSpreadExpansion(assetId: string, windowMs = 10_000): number {
    const hist = this.spreadHistory.get(assetId);
    if (!hist || hist.length < 3) return 1;
    const cutoff = Date.now() - windowMs;
    const recent = hist.filter(h => h.ts >= cutoff);
    if (recent.length < 2) return 1;
    const sorted = recent.map(h => h.spread).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return 1;
    const currentSpread = recent[recent.length - 1].spread;
    return currentSpread / median;
  }

  private handleBook(msg: Record<string, unknown>): void {
    const assetId = msg.asset_id as string;
    const rawBids = msg.bids as Array<{ price: string; size: string }> | undefined;
    const rawAsks = msg.asks as Array<{ price: string; size: string }> | undefined;
    const bids = (rawBids ?? []).map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
    const asks = (rawAsks ?? []).map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
    if (bids.length > 0 && asks.length > 0) {
      const bestBid = Math.max(...bids.map(b => b.price));
      const bestAsk = Math.min(...asks.map(a => a.price));
      this.applyTouchline(assetId, bestBid, bestAsk);
    } else if (bids.length > 0) {
      const bestBid = Math.max(...bids.map(b => b.price));
      const ask = this.bestAsks.get(assetId);
      if (ask !== undefined && ask > 0) this.applyTouchline(assetId, bestBid, ask);
    } else if (asks.length > 0) {
      const bestAsk = Math.min(...asks.map(a => a.price));
      const bid = this.bestBids.get(assetId);
      if (bid !== undefined && bid > 0) this.applyTouchline(assetId, bid, bestAsk);
    }
    const snapshot: BookSnapshot = {
      assetId,
      market: msg.market as string,
      bids, asks,
      timestamp: parseInt(msg.timestamp as string, 10),
    };
    this.emit("book", snapshot);
  }

  private handleBestBidAsk(msg: Record<string, unknown>): void {
    const assetId = msg.asset_id as string;
    const bestBid = parseFloat(msg.best_bid as string);
    const bestAsk = parseFloat(msg.best_ask as string);
    const ok = this.applyTouchline(assetId, bestBid, bestAsk);
    if (!ok) return;
    const spread = bestAsk - bestBid;
    const bba: BestBidAsk = {
      assetId, bestBid, bestAsk, spread,
      timestamp: parseInt(msg.timestamp as string, 10),
    };
    this.emit("bestBidAsk", bba);
  }

  private handlePriceChange(msg: Record<string, unknown>): void {
    const changes = msg.price_changes as Array<Record<string, string>> | undefined;
    if (!changes) return;
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

  private handleLastTrade(msg: Record<string, unknown>): void {
    const trade: LastTrade = {
      assetId: msg.asset_id as string,
      price: parseFloat(msg.price as string),
      size: parseFloat(msg.size as string),
      side: msg.side as string,
      timestamp: parseInt(msg.timestamp as string, 10),
    };
    this.emit("lastTrade", trade);
  }

  private startPing(): void {
    this.stopPing();
    this.pingIntervalId = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("PING");
      }
    }, 10_000);
  }

  private stopPing(): void {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  private startZombieCheck(): void {
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
    }, 10_000);
  }

  private stopZombieCheck(): void {
    if (this.zombieCheckId) {
      clearInterval(this.zombieCheckId);
      this.zombieCheckId = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.reconnectTimeoutId = setTimeout(() => {
      console.error("[PolyWS] Reconnecting...");
      this.doConnect();
    }, this.reconnectMs);
  }

  close(): void {
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
