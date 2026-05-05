import WebSocket from "ws";
import { EventEmitter } from "events";

export interface BinanceTick {
  price: number;
  timestamp: number;
}

export class BinancePriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private closed = false;
  private backoffMs = 1000;
  private readonly maxBackoffMs = 30_000;
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private zombieCheckId: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private readonly ZOMBIE_TIMEOUT_MS = 15_000;

  private priceHistory: Array<{ price: number; ts: number }> = [];
  private readonly historyWindowMs = 90_000;

  lastPrice = 0;

  constructor(url: string) {
    super();
    this.url = url;
  }

  connect(): void {
    this.closed = false;
    this.backoffMs = 1000;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
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

    this.ws.on("message", (raw: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      try {
        const data = JSON.parse(raw.toString());
        const price = parseFloat(data.p ?? "0");
        const tradeTs = typeof data.T === "number" ? data.T : Date.now();
        if (price <= 0) return;

        this.lastPrice = price;

        const ts = typeof tradeTs === "number" && tradeTs > 1e12 ? tradeTs : Date.now();
        this.priceHistory.push({ price, ts });
        this.trimHistory(ts);

        const tick: BinanceTick = { price, timestamp: ts };
        this.emit("tick", tick);
      } catch {
        // malformed
      }
    });

    this.ws.on("close", () => {
      console.error("[BinanceWS] Disconnected");
      this.stopPing();
      this.stopZombieCheck();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("[BinanceWS] Error:", err.message);
    });

    this.ws.on("pong", () => {});
  }

  getRecentChange(windowMs: number): number {
    const now = Date.now();
    this.trimHistory(now);
    if (this.priceHistory.length < 2) return 0;
    const cutoff = now - windowMs;
    let oldest: { price: number; ts: number } | null = null;
    for (const entry of this.priceHistory) {
      if (entry.ts >= cutoff) {
        oldest = entry;
        break;
      }
    }
    if (!oldest) oldest = this.priceHistory[0];
    const latest = this.priceHistory[this.priceHistory.length - 1];
    if (oldest.price <= 0) return 0;
    return (latest.price - oldest.price) / oldest.price;
  }

  /**
   * Returns the max absolute price change (%) within any sub-window of
   * the last `windowMs`. Used to detect sudden whale spikes.
   */
  getMaxSwing(windowMs: number): number {
    const now = Date.now();
    this.trimHistory(now);
    const cutoff = now - windowMs;
    let min = Infinity;
    let max = -Infinity;
    for (const entry of this.priceHistory) {
      if (entry.ts < cutoff) continue;
      if (entry.price < min) min = entry.price;
      if (entry.price > max) max = entry.price;
    }
    if (min === Infinity || min <= 0) return 0;
    return (max - min) / min;
  }

  private trimHistory(now: number): void {
    const cutoff = now - this.historyWindowMs;
    while (this.priceHistory.length > 0 && this.priceHistory[0].ts < cutoff) {
      this.priceHistory.shift();
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingIntervalId = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 15_000);
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
    }, 5_000);
  }

  private stopZombieCheck(): void {
    if (this.zombieCheckId) {
      clearInterval(this.zombieCheckId);
      this.zombieCheckId = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    console.error(`[BinanceWS] Reconnecting in ${this.backoffMs}ms...`);
    this.reconnectTimeoutId = setTimeout(() => {
      this.doConnect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
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
