import { PolymarketApi } from "./api";
import type { Market } from "./models";

export interface TokenIds {
  upTokenId: string | null;
  downTokenId: string | null;
  minOrderSizeShares: number;
}

export class MarketMonitor {
  private api: PolymarketApi;
  private marketName: string;
  private market: Market;
  private upTokenId: string | null = null;
  private downTokenId: string | null = null;
  private minOrderSizeShares = 1;

  constructor(api: PolymarketApi, marketName: string, market: Market) {
    this.api = api;
    this.marketName = marketName;
    this.market = market;
  }

  async updateMarket(market: Market): Promise<void> {
    console.error(`[Monitor] Updating ${this.marketName} market: ${market.slug}`);
    this.market = market;
    this.upTokenId = null;
    this.downTokenId = null;
  }

  getSlug(): string {
    return this.market.slug;
  }

  getConditionId(): string {
    return this.market.conditionId;
  }

  async resolveTokenIds(): Promise<TokenIds> {
    if (this.upTokenId && this.downTokenId) {
      return { upTokenId: this.upTokenId, downTokenId: this.downTokenId, minOrderSizeShares: this.minOrderSizeShares };
    }

    const conditionId = this.market.conditionId;
    console.error(`[Monitor] Resolving token IDs for ${conditionId.slice(0, 16)}...`);

    try {
      const details = await this.api.getMarket(conditionId);
      const minSize = Number(details.minimum_order_size);
      if (Number.isFinite(minSize) && minSize > 0) {
        this.minOrderSizeShares = minSize;
      }
      for (const token of details.tokens) {
        const outcomeUpper = token.outcome.toUpperCase();
        if (outcomeUpper.includes("UP") || outcomeUpper === "1") {
          this.upTokenId = token.token_id;
          console.error(`[Monitor] Up token: ${token.token_id.slice(0, 16)}...`);
        } else if (outcomeUpper.includes("DOWN") || outcomeUpper === "0") {
          this.downTokenId = token.token_id;
          console.error(`[Monitor] Down token: ${token.token_id.slice(0, 16)}...`);
        }
      }
    } catch (e) {
      console.error(`[Monitor] Failed to resolve tokens:`, e);
    }

    return { upTokenId: this.upTokenId, downTokenId: this.downTokenId, minOrderSizeShares: this.minOrderSizeShares };
  }

  static extractTimestampFromSlug(slug: string): number {
    const lastDash = slug.lastIndexOf("-");
    if (lastDash === -1) return 0;
    const ts = parseInt(slug.slice(lastDash + 1), 10);
    return Number.isNaN(ts) ? 0 : ts;
  }

  static extractDurationFromSlug(slug: string): number {
    if (slug.includes("-5m-")) return 300;
    if (slug.includes("-15m-")) return 900;
    if (slug.includes("-1h-")) return 3600;
    return 300;
  }
}
