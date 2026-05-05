"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenPriceMid = tokenPriceMid;
exports.tokenPriceAsk = tokenPriceAsk;
function tokenPriceMid(price) {
    if (price.bid != null && price.ask != null)
        return (price.bid + price.ask) / 2;
    if (price.bid != null)
        return price.bid;
    if (price.ask != null)
        return price.ask;
    return null;
}
function tokenPriceAsk(price) {
    return price.ask ?? 0;
}
//# sourceMappingURL=models.js.map