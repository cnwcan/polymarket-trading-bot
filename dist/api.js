"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolymarketApi = void 0;
const ethers_1 = require("ethers");
const clob_client_1 = require("@polymarket/clob-client");
const POLYGON_CHAIN_ID = 137;
const CTF_CONTRACT = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const RPC_URL = "https://polygon-rpc.com";
class PolymarketApi {
    constructor(config) {
        this.clobClient = null;
        this.signer = null;
        this.DEFAULT_FEE_RATE_BPS = 1000;
        this.config = config;
        this.gammaUrl = config.gammaApiUrl;
        this.clobUrl = config.clobApiUrl;
    }
    async getClobClient() {
        if (this.clobClient)
            return this.clobClient;
        const pk = this.config.privateKey;
        if (!pk)
            throw new Error("Private key is required. Set PRIVATE_KEY in .env");
        this.signer = new ethers_1.Wallet(pk);
        // IMPORTANT: API key creation/derivation must use the same signatureType/funder
        // as the trading client, otherwise createOrDeriveApiKey may fail.
        const sigType = this.config.signatureType;
        const funder = this.config.proxyWalletAddress ? this.config.proxyWalletAddress : undefined;
        const tempClient = new clob_client_1.ClobClient(this.clobUrl, POLYGON_CHAIN_ID, this.signer, undefined, sigType, funder);
        let creds;
        try {
            creds = await tempClient.createOrDeriveApiKey();
        }
        catch (e) {
            throw new Error(`CLOB API key creation/derivation failed. Check PRIVATE_KEY, SIGNATURE_TYPE, PROXY_WALLET_ADDRESS and account permissions. Original error: ${String(e)}`);
        }
        if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
            const raw = JSON.stringify(creds);
            throw new Error(`CLOB API key derivation returned invalid credentials (key/secret/passphrase missing). ` +
                `This usually means the CLOB API call failed silently (geo-block, proxy error, or network issue). Raw: ${raw}`);
        }
        this.clobClient = new clob_client_1.ClobClient(this.clobUrl, POLYGON_CHAIN_ID, this.signer, creds, sigType, funder);
        return this.clobClient;
    }
    getWalletAddress() {
        return this.config.proxyWalletAddress;
    }
    async authenticate() {
        await this.getClobClient();
        console.error("Successfully authenticated with Polymarket CLOB API");
        if (this.config.proxyWalletAddress) {
            console.error("Proxy wallet:", this.config.proxyWalletAddress);
        }
        else {
            console.error("Trading account: EOA (private key account)");
        }
    }
    async getMarketBySlug(slug) {
        const url = `${this.gammaUrl}/events/slug/${slug}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Failed to fetch market by slug: ${slug} (status: ${res.status})`);
        const json = (await res.json());
        const markets = json.markets;
        if (!Array.isArray(markets) || markets.length === 0) {
            throw new Error("Invalid market response: no markets array");
        }
        const m = markets[0];
        return {
            conditionId: (m.conditionId ?? m.condition_id),
            id: m.id,
            question: m.question,
            slug: m.slug,
            resolutionSource: (m.resolutionSource ?? m.resolution_source),
            endDateISO: (m.endDateISO ?? m.end_date_iso),
            endDateIso: (m.endDateIso ?? m.end_date_iso),
            active: m.active,
            closed: m.closed,
            tokens: m.tokens,
            clobTokenIds: (m.clobTokenIds ?? m.clob_token_ids),
            outcomes: m.outcomes,
        };
    }
    async getMarket(conditionId) {
        const url = `${this.clobUrl}/markets/${conditionId}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Failed to fetch market (status: ${res.status})`);
        const json = await res.json();
        return json;
    }
    async getOrderbook(tokenId) {
        const url = `${this.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error("Failed to fetch orderbook");
        return (await res.json());
    }
    async getPrice(tokenId, side) {
        const url = `${this.clobUrl}/price?side=${side}&token_id=${encodeURIComponent(tokenId)}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Failed to fetch price (status: ${res.status})`);
        const json = (await res.json());
        const priceStr = json?.price;
        if (priceStr == null)
            throw new Error("Invalid price response");
        return Number(priceStr);
    }
    async getBestPrice(tokenId) {
        const ob = await this.getOrderbook(tokenId);
        const bestBid = ob.bids?.[0]?.price != null ? Number(ob.bids[0].price) : null;
        const bestAsk = ob.asks?.[0]?.price != null ? Number(ob.asks[0].price) : null;
        if (bestAsk == null)
            return null;
        return { tokenId, bid: bestBid, ask: bestAsk };
    }
    async getConditionalTokenBalance(tokenId) {
        const client = await this.getClobClient();
        const bal = await client.getBalanceAllowance({
            asset_type: clob_client_1.AssetType.CONDITIONAL,
            token_id: tokenId,
            signature_type: this.config.signatureType,
        });
        const raw = Number(bal?.balance ?? 0);
        if (!Number.isFinite(raw) || raw <= 0)
            return 0;
        // CLOB ALWAYS returns 6-decimal micro-units (1 token = 1_000_000 units).
        // Previous heuristic (>= 1M → divide, else return as-is) was WRONG for
        // sub-$1 values — e.g. raw=9620 (0.009620 tokens) was returned as 9620.
        return raw / 1000000;
    }
    async getCollateralBalance() {
        const client = await this.getClobClient();
        const bal = await client.getBalanceAllowance({
            asset_type: clob_client_1.AssetType.COLLATERAL,
            signature_type: this.config.signatureType,
        });
        const rawBal = Number(bal?.balance ?? 0);
        const hasBal = Number.isFinite(rawBal) && rawBal > 0;
        if (!hasBal)
            return 0;
        // CLOB ALWAYS returns 6-decimal micro-USDC (1 USDC = 1_000_000 units).
        // Use ONLY `balance` field — `allowance` is the ERC20 spending approval
        // which can be astronomically large (max uint256) and must not be used
        // as the account balance.
        return rawBal / 1000000;
    }
    async checkCollateralAllowance() {
        const client = await this.getClobClient();
        const bal = await client.getBalanceAllowance({
            asset_type: clob_client_1.AssetType.COLLATERAL,
            signature_type: this.config.signatureType,
        });
        const rawBal = Number(bal?.balance ?? 0);
        const rawAllowance = Number(bal?.allowance ?? 0);
        const balance = (Number.isFinite(rawBal) && rawBal > 0) ? rawBal / 1000000 : 0;
        // Allowance can be astronomically large (max uint256) for approved accounts.
        // A value of 0 or very small means the exchange contract cannot spend USDC.
        const allowance = (Number.isFinite(rawAllowance) && rawAllowance > 0) ? rawAllowance / 1000000 : 0;
        const ok = allowance > 0 && (allowance >= balance || allowance > 1000000);
        return { balance, allowance, ok };
    }
    async placeOrder(params) {
        const client = await this.getClobClient();
        const side = params.side === "BUY" ? clob_client_1.Side.BUY : clob_client_1.Side.SELL;
        const tickSize = (params.tickSize === "0.1" || params.tickSize === "0.01" || params.tickSize === "0.001" || params.tickSize === "0.0001")
            ? params.tickSize
            : "0.01";
        const signedOrder = await client.createOrder({
            tokenID: params.tokenId,
            price: params.price,
            side,
            size: params.size,
            feeRateBps: this.DEFAULT_FEE_RATE_BPS,
        }, tickSize);
        const resp = await client.postOrder(signedOrder, clob_client_1.OrderType.GTC);
        const r = resp;
        return {
            order_id: r?.orderID ?? r?.id,
            status: r?.status ?? "LIVE",
            message: r?.orderID ? `Order placed. ID: ${r.orderID}` : undefined,
        };
    }
    async placeMarketOrder(tokenId, amount, side, tickSize = "0.01", negRisk = false, sellSlippageFactor) {
        const client = await this.getClobClient();
        const tickSizeResolved = (tickSize === "0.1" || tickSize === "0.01" || tickSize === "0.001" || tickSize === "0.0001")
            ? tickSize
            : "0.01";
        let signedOrder;
        let price;
        let orderSize;
        if (side === "BUY") {
            // `amount` from scalper = number of shares desired.
            // createMarketBuyOrder needs USDC amount, so we fetch the ask price
            // and compute USDC = shares * askPrice.
            const askPrice = await this.getPrice(tokenId, "SELL");
            const usdcAmount = Math.max(1, Math.ceil(amount * askPrice * 100) / 100);
            // price MUST be passed explicitly — SDK defaults to 1.0 when omitted,
            // but Polymarket requires 0 < price < 1.
            const clampedPrice = Math.min(askPrice, 0.99);
            try {
                signedOrder = await client.createMarketBuyOrder({
                    tokenID: tokenId,
                    amount: usdcAmount,
                    price: clampedPrice,
                    feeRateBps: this.DEFAULT_FEE_RATE_BPS,
                }, tickSizeResolved);
            }
            catch (e) {
                throw new Error(`createMarketBuyOrder failed [BUY $${usdcAmount}@${clampedPrice} of ${tokenId.slice(0, 12)}]: ${this.extractErrorDetails(e)}`);
            }
            // Derive price/size from signed order's raw amounts (both 6-decimal)
            const makerAmt = Number(signedOrder?.makerAmount ?? 0);
            const takerAmt = Number(signedOrder?.takerAmount ?? 0);
            price = (makerAmt > 0 && takerAmt > 0) ? makerAmt / takerAmt : askPrice;
            orderSize = takerAmt > 0 ? takerAmt / 1000000 : amount;
        }
        else {
            // SELL: createOrder with aggressive pricing + FOK
            const bidPrice = await this.getPrice(tokenId, "BUY");
            const slippage = sellSlippageFactor ?? 0.01;
            price = Math.max(0.01, Math.round(bidPrice * (1 - slippage) * 100) / 100);
            orderSize = Math.round(amount * 10000) / 10000;
            // FOK precision: size * price product must have max 2 decimal places
            // (Polymarket backend requirement — GitHub Issue #121)
            const product = orderSize * price;
            const roundedProduct = Math.round(product * 100) / 100;
            if (Math.abs(product - roundedProduct) > 1e-9) {
                orderSize = Math.floor((roundedProduct / price) * 10000) / 10000;
            }
            try {
                signedOrder = await client.createOrder({
                    tokenID: tokenId,
                    price,
                    side: clob_client_1.Side.SELL,
                    size: orderSize,
                    feeRateBps: this.DEFAULT_FEE_RATE_BPS,
                }, tickSizeResolved);
            }
            catch (e) {
                throw new Error(`createOrder failed [SELL ${orderSize}@${price}]: ${this.extractErrorDetails(e)}`);
            }
        }
        // Post with FOK (Fill-Or-Kill): fills immediately and entirely, or is
        // cancelled. This prevents phantom "Until Cancelled" GTC orders sitting
        // on the book unfilled while the bot assumes the trade happened.
        let resp;
        try {
            resp = await client.postOrder(signedOrder, clob_client_1.OrderType.FOK);
        }
        catch (e) {
            throw new Error(`postOrder FOK failed [${side}]: ${this.extractErrorDetails(e)}`);
        }
        if (!resp) {
            throw new Error("postOrder returned empty response");
        }
        const success = resp.success !== false;
        const status = String(resp.status ?? "").toLowerCase();
        const orderId = resp.orderID;
        const errorMsg = resp.errorMsg || resp.error;
        if (!success || errorMsg) {
            throw new Error(String(errorMsg || "Order failed"));
        }
        // FOK: status MUST be "matched" — any other status means the order
        // was not filled and should be treated as a failure.
        if (status !== "matched") {
            if (orderId && (status === "live" || status === "delayed")) {
                try {
                    await client.cancelOrder({ orderID: orderId });
                }
                catch { }
                console.error(`[API] FOK returned status="${status}" — cancelled orphan order ${orderId}`);
            }
            throw new Error(`Order not filled (status="${status}"). FOK requires immediate full fill. ` +
                `No liquidity at current price.`);
        }
        const priceLabel = side === "SELL" ? "limitPrice" : "price";
        console.error(`[API] FOK ${side} matched: orderId=${orderId} ${priceLabel}=${price.toFixed(4)} size=${orderSize}`);
        return {
            order_id: orderId,
            status: "matched",
            message: orderId ? `FOK order matched. ID: ${orderId}` : undefined,
            actualPrice: price,
            actualSize: orderSize,
        };
    }
    async cancelAllOrders() {
        try {
            const client = await this.getClobClient();
            await client.cancelAll();
        }
        catch (e) {
            console.error(`[API] cancelAll failed: ${e}`);
        }
    }
    extractErrorDetails(e) {
        if (!e)
            return "Unknown error";
        const err = e;
        if (err.response && typeof err.response === "object") {
            const resp = err.response;
            const data = resp.data;
            if (data?.error)
                return String(data.error);
            if (resp.status)
                return `HTTP ${resp.status}: ${JSON.stringify(data ?? resp.statusText)}`;
        }
        if (err.data && typeof err.data === "object") {
            const data = err.data;
            if (data.error)
                return String(data.error);
        }
        return String(e);
    }
    async redeemTokens(conditionId, _tokenId, outcome) {
        const pk = this.config.privateKey;
        if (!pk)
            throw new Error("Private key required for redemption. Set PRIVATE_KEY in .env");
        const { ethers } = await Promise.resolve().then(() => __importStar(require("ethers")));
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(pk, provider);
        const conditionIdClean = conditionId.startsWith("0x") ? conditionId.slice(2) : conditionId;
        const conditionIdBytes32 = "0x" + conditionIdClean.padStart(64, "0").toLowerCase();
        const indexSet = outcome.toUpperCase().includes("UP") || outcome === "1"
            ? 1
            : 2;
        const parentCollectionId = "0x" + "0".repeat(64);
        const collateralTokenBytes32 = "0x" + "0".repeat(24) + USDC_ADDRESS.slice(2).toLowerCase();
        const arrayOffset = 32 * 4;
        const arrayLength = 1;
        const encoded = collateralTokenBytes32.slice(2).padStart(64, "0") +
            parentCollectionId.slice(2) +
            conditionIdBytes32.slice(2).padStart(64, "0") +
            ethers.BigNumber.from(arrayOffset).toHexString().slice(2).padStart(64, "0") +
            ethers.BigNumber.from(arrayLength).toHexString().slice(2).padStart(64, "0") +
            ethers.BigNumber.from(indexSet).toHexString().slice(2).padStart(64, "0");
        const tx = await wallet.sendTransaction({
            to: CTF_CONTRACT,
            data: "0x3d7d3f5a" + encoded,
            value: 0,
        });
        const receipt = await tx.wait();
        if (!receipt.status)
            throw new Error(`Redemption tx failed: ${tx.hash}`);
        return {
            success: true,
            message: `Redeemed. Tx: ${tx.hash}`,
            transaction_hash: tx.hash,
        };
    }
    async getUserFills(userAddress, conditionId, limit = 1000) {
        const dataApiUrl = "https://data-api.polymarket.com";
        const user = userAddress.startsWith("0x") ? userAddress : `0x${userAddress}`;
        const params = new URLSearchParams({
            limit: String(limit),
            sortBy: "TIMESTAMP",
            sortDirection: "DESC",
            user,
        });
        if (conditionId)
            params.set("market", conditionId);
        const url = `${dataApiUrl}/activity?${params}`;
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Failed to fetch activity (status: ${res.status})`);
        const json = (await res.json());
        const arr = Array.isArray(json) ? json : json?.data;
        if (!Array.isArray(arr))
            return [];
        return arr
            .filter((a) => a.type === "TRADE")
            .map((a) => ({
            id: a.id,
            tokenID: (a.tokenID ?? a.asset),
            asset: a.asset,
            tokenName: a.tokenName,
            side: String(a.side),
            size: Number(a.size),
            usdcSize: a.usdcSize != null ? Number(a.usdcSize) : undefined,
            price: Number(a.price),
            timestamp: Number(a.timestamp),
            orderID: a.orderID,
            user: a.user,
            proxyWallet: a.proxyWallet,
            maker: a.maker,
            taker: a.taker,
            fee: a.fee,
            conditionId: a.conditionId,
            outcomeIndex: a.outcomeIndex,
            outcome: a.outcome,
            type: a.type,
            transactionHash: a.transactionHash,
            title: a.title,
            slug: a.slug,
        }));
    }
}
exports.PolymarketApi = PolymarketApi;
//# sourceMappingURL=api.js.map