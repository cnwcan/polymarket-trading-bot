"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketMonitor = void 0;
class MarketMonitor {
    constructor(api, marketName, market) {
        this.upTokenId = null;
        this.downTokenId = null;
        this.minOrderSizeShares = 1;
        this.api = api;
        this.marketName = marketName;
        this.market = market;
    }
    async updateMarket(market) {
        console.error(`[Monitor] Updating ${this.marketName} market: ${market.slug}`);
        this.market = market;
        this.upTokenId = null;
        this.downTokenId = null;
    }
    getSlug() {
        return this.market.slug;
    }
    getConditionId() {
        return this.market.conditionId;
    }
    async resolveTokenIds() {
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
                }
                else if (outcomeUpper.includes("DOWN") || outcomeUpper === "0") {
                    this.downTokenId = token.token_id;
                    console.error(`[Monitor] Down token: ${token.token_id.slice(0, 16)}...`);
                }
            }
        }
        catch (e) {
            console.error(`[Monitor] Failed to resolve tokens:`, e);
        }
        return { upTokenId: this.upTokenId, downTokenId: this.downTokenId, minOrderSizeShares: this.minOrderSizeShares };
    }
    static extractTimestampFromSlug(slug) {
        const lastDash = slug.lastIndexOf("-");
        if (lastDash === -1)
            return 0;
        const ts = parseInt(slug.slice(lastDash + 1), 10);
        return Number.isNaN(ts) ? 0 : ts;
    }
    static extractDurationFromSlug(slug) {
        if (slug.includes("-5m-"))
            return 300;
        if (slug.includes("-15m-"))
            return 900;
        if (slug.includes("-1h-"))
            return 3600;
        return 300;
    }
}
exports.MarketMonitor = MarketMonitor;
//# sourceMappingURL=monitor.js.map