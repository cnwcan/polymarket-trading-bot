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
exports.Scalper = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const telegram_1 = require("./telegram");
class Scalper {
    constructor(api, binance, polyFeed, config, simulation) {
        this.market = null;
        this._marketGeneration = 0;
        this.phase = { kind: "Idle" };
        this.openPositionCount = 0;
        this.dailyLoss = 0;
        this.dailyProfit = 0;
        this.totalProfit = 0;
        this.dailyResetDate = this.todayStr();
        this.tickInterval = null;
        this.paperTradeSeq = 0;
        this.lastScalperDebugAt = 0;
        this.sellRetryCount = 0;
        this.MAX_SELL_INNER_RETRIES = 3;
        this.MAX_SELL_STUCK_RETRIES = 5;
        this.BUY_FEE_BUFFER = 1.025;
        this.minOrderSizeShares = 1;
        this.isPlacingBuy = false;
        this.isExitingPosition = false;
        this._tickRunning = false;
        this.geoBlockedUntil = 0;
        this.stuckSellShares = null;
        this.onTradeCallback = null;
        this._autoScale = false;
        this._autoScaleBaseMin = 1;
        this._autoScaleBaseMax = 5;
        this._startingBalance = 20;
        this.liveStartingBalance = null;
        this.liveCurrentBalance = null;
        this._lastPeriodicSyncAt = 0;
        this.PERIODIC_SYNC_INTERVAL_MS = 60000;
        this.api = api;
        this.binance = binance;
        this.polyFeed = polyFeed;
        this.config = config;
        this.simulation = simulation;
    }
    onTrade(cb) {
        this.onTradeCallback = cb;
    }
    async setMarket(info) {
        if (this.phase.kind === "InPosition") {
            // Period rollover while still in position — force sell.
            // We never hold to resolution because 5-min tokens don't
            // auto-redeem to USDC, leaving orphaned tokens.
            (0, logger_1.logPrintln)("[Scalper] Period rollover while in position — attempting sell before market switch");
            await this.forceExitWithSell();
        }
        this.market = info;
        this._marketGeneration++;
        this.phase = { kind: "Idle" };
        this.sellRetryCount = 0;
        this.stuckSellShares = null;
        this.polyFeed.updateSubscription([info.upTokenId, info.downTokenId]);
        (0, logger_1.logPrintln)(`[Scalper] Market set: ${info.slug} | Up: ${info.upTokenId.slice(0, 12)}... | Down: ${info.downTokenId.slice(0, 12)}...`);
    }
    get isRunning() {
        return this.tickInterval !== null;
    }
    get isSimulation() {
        return this.simulation;
    }
    setSimulationMode(sim) {
        this.simulation = sim;
        (0, logger_1.logPrintln)(`[Scalper] Mode switched to ${sim ? "SIMULATION" : "PRODUCTION"}`);
    }
    setPositionRange(min, max) {
        const lo = Math.max(1, Math.min(min, max));
        const hi = Math.max(lo, Math.min(max, 100));
        this.config.minPositionUsdc = lo;
        this.config.maxPositionUsdc = hi;
        (0, logger_1.logPrintln)(`[Scalper] Position range set: $${lo}-$${hi}`);
    }
    setMinOrderSizeShares(minShares) {
        const v = Number(minShares);
        this.minOrderSizeShares = Number.isFinite(v) && v > 0 ? v : 1;
        (0, logger_1.logPrintln)(`[Scalper] Market min order size: ${this.minOrderSizeShares} shares`);
    }
    setStartingBalance(bal) {
        this._startingBalance = bal;
        // When we set starting balance manually (SIM or config), keep display consistent.
        if (this.simulation) {
            this.liveStartingBalance = bal;
            this.liveCurrentBalance = bal + this.totalProfit;
        }
    }
    setAutoScale(enabled, baseMin, baseMax) {
        this._autoScale = enabled;
        this._autoScaleBaseMin = Math.max(1, baseMin);
        this._autoScaleBaseMax = Math.max(this._autoScaleBaseMin, Math.min(baseMax, 100));
        (0, logger_1.logPrintln)(`[Scalper] Auto-scale ${enabled ? "ON" : "OFF"}: base $${this._autoScaleBaseMin}-$${this._autoScaleBaseMax}`);
    }
    getEffectiveRange() {
        if (!this._autoScale) {
            return { min: this.config.minPositionUsdc, max: this.config.maxPositionUsdc };
        }
        const currentBalance = !this.simulation && this.liveCurrentBalance != null
            ? this.liveCurrentBalance
            : this._startingBalance + this.totalProfit;
        const ratio = Math.max(1, currentBalance / this._startingBalance);
        const scaledMin = Math.max(1, Math.min(100, Math.round(this._autoScaleBaseMin * ratio)));
        const scaledMax = Math.max(scaledMin, Math.min(100, Math.round(this._autoScaleBaseMax * ratio)));
        return { min: scaledMin, max: scaledMax };
    }
    async syncStartingBalanceFromPolymarket() {
        if (this.simulation)
            return this._startingBalance;
        try {
            const bal = await this.api.getCollateralBalance();
            this._startingBalance = bal > 0 ? bal : this._startingBalance;
            this.liveStartingBalance = this._startingBalance;
            this.liveCurrentBalance = this._startingBalance;
            (0, logger_1.logPrintln)(`[Scalper] Live sync starting balance: $${this._startingBalance.toFixed(2)}`);
            return this._startingBalance;
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Scalper] Live sync starting balance FAILED: ${e}`);
            return this._startingBalance;
        }
    }
    async syncCurrentBalanceFromPolymarket() {
        if (this.simulation)
            return this._startingBalance + this.totalProfit;
        try {
            const bal = await this.api.getCollateralBalance();
            const newBal = bal > 0 ? bal : (this.liveCurrentBalance ?? (this._startingBalance + this.totalProfit));
            this.liveCurrentBalance = newBal;
            return newBal;
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Scalper] Live sync current balance FAILED: ${e}`);
            return this.liveCurrentBalance ?? (this._startingBalance + this.totalProfit);
        }
    }
    start() {
        if (this.tickInterval)
            return;
        this.tickInterval = setInterval(() => this.tick(), 500);
        (0, logger_1.logPrintln)("[Scalper] Started (500ms tick)");
    }
    stop() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
        (0, logger_1.logPrintln)("[Scalper] Stopped");
    }
    async tick() {
        if (this._tickRunning)
            return;
        this._tickRunning = true;
        try {
            await this._tickInner();
        }
        finally {
            this._tickRunning = false;
        }
    }
    async _tickInner() {
        if (!this.market)
            return;
        if (this.isExitingPosition)
            return;
        this.checkDailyReset();
        if (!this.simulation && Date.now() - this._lastPeriodicSyncAt > this.PERIODIC_SYNC_INTERVAL_MS) {
            this._lastPeriodicSyncAt = Date.now();
            try {
                await this.syncCurrentBalanceFromPolymarket();
            }
            catch { /* best-effort */ }
        }
        if (this.dailyLoss >= this.config.dailyLossLimit) {
            this.maybeLogScalperDebug(`Durdu: günlük zarar limiti ($${this.dailyLoss.toFixed(2)} ≥ $${this.config.dailyLossLimit}).`);
            if (this.phase.kind === "InPosition") {
                await this.exitPosition("daily_loss_limit");
            }
            return;
        }
        const now = Math.floor(Date.now() / 1000);
        const timeToClose = this.market.periodEndTimestamp - now;
        if (this.phase.kind === "InPosition") {
            if (timeToClose <= this.config.exitBeforeCloseSeconds) {
                if (this.sellRetryCount > 0) {
                    (0, logger_1.logPrintln)(`[Scalper] Period ending while sell stuck — abandoning (retries won't help, market will resolve)`);
                    await this.abandonCurrentPosition("period_ending_sell_stuck");
                    return;
                }
                // Always sell before period ends. Hold-to-resolution is disabled
                // because 5-min market tokens don't auto-redeem to USDC — they
                // get stuck and require manual intervention.
                await this.exitPosition("period_ending");
                return;
            }
            if (this.sellRetryCount > 0 && !this.simulation) {
                if (this.sellRetryCount >= this.MAX_SELL_STUCK_RETRIES) {
                    (0, logger_1.logPrintln)(`[Scalper] SELL ABANDONED after ${this.sellRetryCount} stuck retries — position will resolve at market expiry. ` +
                        `Accepting loss and moving on.`);
                    await this.abandonCurrentPosition("sell_abandoned");
                    return;
                }
                (0, logger_1.logPrintln)(`[Scalper] Retrying stuck SELL (attempt ${this.sellRetryCount + 1}/${this.MAX_SELL_STUCK_RETRIES})`);
                await this.exitPosition("stuck_retry");
                return;
            }
            await this.checkExitConditions();
            return;
        }
        if (this.phase.kind === "Cooldown") {
            if (now >= this.phase.until) {
                this.phase = { kind: "Idle" };
            }
            return;
        }
        if (this.openPositionCount >= this.config.maxOpenPositions) {
            this.maybeLogScalperDebug(`Giriş yok: açık pozisyon limiti (${this.openPositionCount}/${this.config.maxOpenPositions}).`);
            return;
        }
        if (this.config.lateEntryEnabled && timeToClose <= this.config.lateEntryWindowSeconds && timeToClose > this.config.exitBeforeCloseSeconds + 5) {
            await this.checkLateEntrySignal(timeToClose);
            return;
        }
        if (timeToClose <= this.config.exitBeforeCloseSeconds + 15) {
            this.maybeLogScalperDebug(`Giriş yok: periyot sonuna çok yakın (${timeToClose}s ≤ ${this.config.exitBeforeCloseSeconds + 15}s tampon; yeni pozisyon açılmıyor).`);
            return;
        }
        await this.checkEntrySignal();
    }
    maybeLogScalperDebug(message) {
        const iv = this.config.entryDebugLogIntervalMs;
        if (iv <= 0)
            return;
        const now = Date.now();
        if (now - this.lastScalperDebugAt < iv)
            return;
        this.lastScalperDebugAt = now;
        (0, logger_1.logPrintln)(`[Scalper][debug] ${message}`);
    }
    /**
     * Momentum / latency arbitrage entry:
     * Binance spot moves → Polymarket lags 30-90s → buy in the SAME direction.
     *   spot ↑  →  buy Up   (Polymarket Up odds haven't caught up yet)
     *   spot ↓  →  buy Down (Polymarket Down odds haven't caught up yet)
     */
    async checkEntrySignal() {
        if (!this.market)
            return;
        const windowMs = this.config.momentumWindowMs;
        const windowSec = Math.round(windowMs / 1000);
        const spotChange = this.binance.getRecentChange(windowMs);
        const threshold = this.config.entryThresholdPercent / 100;
        const snapshot = () => {
            const upAsk = this.polyFeed.bestAsks.get(this.market.upTokenId) ?? 0;
            const downAsk = this.polyFeed.bestAsks.get(this.market.downTokenId) ?? 0;
            return (`BTC~$${this.binance.lastPrice.toFixed(0)} | upAsk=$${upAsk.toFixed(2)} downAsk=$${downAsk.toFixed(2)} | ` +
                `Δ${windowSec}s=${(spotChange * 100).toFixed(4)}% | eşik±${this.config.entryThresholdPercent}%`);
        };
        if (this.binance.lastPrice <= 0) {
            this.maybeLogScalperDebug(`Binance spot henüz yok veya 0.`);
            return;
        }
        const upAsk = this.polyFeed.bestAsks.get(this.market.upTokenId) ?? 0;
        const downAsk = this.polyFeed.bestAsks.get(this.market.downTokenId) ?? 0;
        if (upAsk <= 0 || downAsk <= 0) {
            this.maybeLogScalperDebug(`Orderbook ask eksik (0). ${snapshot()}`);
            return;
        }
        let side = null;
        let tokenId = "";
        let entryPrice = 0;
        const maxAsk = this.config.maxEntryAsk;
        const minAsk = this.config.minEntryAsk;
        if (spotChange > threshold) {
            if (upAsk >= minAsk && upAsk < maxAsk) {
                side = "Up";
                tokenId = this.market.upTokenId;
                entryPrice = upAsk;
            }
        }
        else if (spotChange < -threshold) {
            if (downAsk >= minAsk && downAsk < maxAsk) {
                side = "Down";
                tokenId = this.market.downTokenId;
                entryPrice = downAsk;
            }
        }
        // Direction-based cooldown: skip if same direction within cooldown window
        if (side && this.phase.kind === "Cooldown") {
            if (side === this.phase.lastDirection && Math.floor(Date.now() / 1000) < this.phase.until) {
                this.maybeLogScalperDebug(`Signal guard: ${side} yönünde cooldown aktif (${this.phase.until - Math.floor(Date.now() / 1000)}s kaldı). ${snapshot()}`);
                return;
            }
            this.phase = { kind: "Idle" };
        }
        if (!side || !tokenId || entryPrice <= 0) {
            const rallyCond = spotChange > threshold;
            const dipCond = spotChange < -threshold;
            let reason;
            if (!rallyCond && !dipCond) {
                reason =
                    `Momentum eşiği tutmuyor: |Δ${windowSec}s|=${(Math.abs(spotChange) * 100).toFixed(4)}% < ${this.config.entryThresholdPercent}% ` +
                        `(${windowSec}s pencerede ±${this.config.entryThresholdPercent}% gerekli).`;
            }
            else if (rallyCond && upAsk >= maxAsk) {
                reason = `Yükseliş sinyali var ama upAsk=$${upAsk.toFixed(2)} ≥ $${maxAsk.toFixed(2)} — çok pahalı.`;
            }
            else if (dipCond && downAsk >= maxAsk) {
                reason = `Düşüş sinyali var ama downAsk=$${downAsk.toFixed(2)} ≥ $${maxAsk.toFixed(2)} — çok pahalı.`;
            }
            else if (rallyCond && upAsk < minAsk) {
                reason = `Yükseliş sinyali var ama upAsk=$${upAsk.toFixed(2)} < $${minAsk.toFixed(2)} — çok ucuz/düşük olasılık.`;
            }
            else if (dipCond && downAsk < minAsk) {
                reason = `Düşüş sinyali var ama downAsk=$${downAsk.toFixed(2)} < $${minAsk.toFixed(2)} — çok ucuz/düşük olasılık.`;
            }
            else {
                reason = `Giriş üretilemedi (rally=${rallyCond} dip=${dipCond}).`;
            }
            this.maybeLogScalperDebug(`${reason} | ${snapshot()}`);
            return;
        }
        if (this.dailyLoss >= this.config.dailyLossLimit) {
            this.maybeLogScalperDebug(`Günlük zarar limitine ulaşıldı ($${this.dailyLoss.toFixed(2)} ≥ $${this.config.dailyLossLimit}). | ${snapshot()}`);
            return;
        }
        // --- Whale / spike protection (configurable via env) ---
        const SPIKE_WINDOW_MS = 5000;
        const SPIKE_THRESHOLD = this.config.whaleGuardSpikeThreshold;
        const SPREAD_EXPANSION_LIMIT = this.config.whaleGuardSpreadLimit;
        const btcSwing5s = this.binance.getMaxSwing(SPIKE_WINDOW_MS);
        if (btcSwing5s > SPIKE_THRESHOLD) {
            (0, logger_1.logPrintln)(`[Scalper] WHALE GUARD: BTC spike ${(btcSwing5s * 100).toFixed(3)}% in ${SPIKE_WINDOW_MS / 1000}s ` +
                `(limit ${(SPIKE_THRESHOLD * 100).toFixed(2)}%) — skipping entry`);
            return;
        }
        const targetTokenId = side === "Up" ? this.market.upTokenId : this.market.downTokenId;
        const spreadExpansion = this.polyFeed.getSpreadExpansion(targetTokenId, 10000);
        if (spreadExpansion > SPREAD_EXPANSION_LIMIT) {
            (0, logger_1.logPrintln)(`[Scalper] WHALE GUARD: ${side} spread expanded ${spreadExpansion.toFixed(1)}x vs median ` +
                `(limit ${SPREAD_EXPANSION_LIMIT}x) — liquidity vacuum, skipping entry`);
            return;
        }
        const sizing = this.computeSmartPositionSize(Math.abs(spotChange), threshold, entryPrice, side, upAsk, downAsk);
        let positionUsdc = sizing.positionUsdc;
        let shares = Math.floor((positionUsdc / entryPrice) * 100) / 100;
        if (shares * entryPrice < 1.0) {
            shares = Math.ceil((1.0 / entryPrice) * 100) / 100;
            positionUsdc = shares * entryPrice;
        }
        if (shares < 1) {
            this.maybeLogScalperDebug(`Pay adedi < 1: ${shares.toFixed(2)} pay. Position=$${positionUsdc} | ${snapshot()}`);
            return;
        }
        if (shares < this.minOrderSizeShares) {
            const candidateShares = Math.ceil(this.minOrderSizeShares * this.BUY_FEE_BUFFER * 100) / 100;
            const candidateUsd = candidateShares * entryPrice;
            // In production, FOK retries may fill at higher prices; add slippage buffer
            const slippageBuffer = this.simulation ? 1.0 : 1.15;
            const candidateUsdWithBuffer = candidateUsd * slippageBuffer;
            const eff = this.getEffectiveRange();
            const availableBalance = this.liveCurrentBalance ?? (this._startingBalance + this.totalProfit);
            const maxAllowed = Math.min(eff.max, availableBalance);
            if (candidateUsdWithBuffer <= maxAllowed + 1e-9) {
                shares = candidateShares;
                positionUsdc = candidateUsd;
            }
            else {
                this.maybeLogScalperDebug(`Min shares constraint prevents entry: need ${candidateShares} shares ($${candidateUsd.toFixed(2)}, ` +
                    `with slippage buffer: $${candidateUsdWithBuffer.toFixed(2)}) ` +
                    `but maxAllowed=$${maxAllowed.toFixed(2)} (effMax=$${eff.max.toFixed(0)}, balance=$${availableBalance.toFixed(2)}). Skip. | ${snapshot()}`);
                return;
            }
        }
        const thrPct = this.config.entryThresholdPercent;
        const entryRuleSummary = side === "Up"
            ? `Spot ${windowSec}s: +${(spotChange * 100).toFixed(3)}% (eşik: +${thrPct}%) → Up al $${positionUsdc} [güven:${(sizing.confidence * 100).toFixed(0)}% kelly:${(sizing.kellyFraction * 100).toFixed(0)}% spread:${(sizing.spreadQuality * 100).toFixed(0)}%]`
            : `Spot ${windowSec}s: ${(spotChange * 100).toFixed(3)}% (eşik: -${thrPct}%) → Down al $${positionUsdc} [güven:${(sizing.confidence * 100).toFixed(0)}% kelly:${(sizing.kellyFraction * 100).toFixed(0)}% spread:${(sizing.spreadQuality * 100).toFixed(0)}%]`;
        (0, logger_1.logPrintln)(`[Scalper] ENTRY SIGNAL: ${side} | Spot Δ${windowSec}s: ${(spotChange * 100).toFixed(3)}% | ` +
            `Ask: $${entryPrice.toFixed(4)} | Size: $${positionUsdc} (${(sizing.confidence * 100).toFixed(0)}% conf) | Shares: ${shares}`);
        await this.executeBuy(side, tokenId, shares, entryPrice, entryRuleSummary);
    }
    async checkLateEntrySignal(timeToClose) {
        if (!this.market)
            return;
        const upAsk = this.polyFeed.bestAsks.get(this.market.upTokenId) ?? 0;
        const downAsk = this.polyFeed.bestAsks.get(this.market.downTokenId) ?? 0;
        if (upAsk <= 0 || downAsk <= 0)
            return;
        const lateMinAsk = this.config.lateEntryMinAsk;
        const LATE_MAX_ASK = 0.96;
        let side = null;
        let tokenId = "";
        let entryPrice = 0;
        if (upAsk >= lateMinAsk && upAsk <= LATE_MAX_ASK && downAsk < (1 - lateMinAsk + 0.05)) {
            side = "Up";
            tokenId = this.market.upTokenId;
            entryPrice = upAsk;
        }
        else if (downAsk >= lateMinAsk && downAsk <= LATE_MAX_ASK && upAsk < (1 - lateMinAsk + 0.05)) {
            side = "Down";
            tokenId = this.market.downTokenId;
            entryPrice = downAsk;
        }
        if (!side || !tokenId || entryPrice <= 0) {
            this.maybeLogScalperDebug(`Late entry: no clear direction (upAsk=$${upAsk.toFixed(2)} downAsk=$${downAsk.toFixed(2)}, need >= $${lateMinAsk.toFixed(2)})`);
            return;
        }
        // Whale protection for late entries too
        const btcSwing5s = this.binance.getMaxSwing(5000);
        if (btcSwing5s > 0.0015) {
            (0, logger_1.logPrintln)(`[Scalper] WHALE GUARD (late): BTC spike ${(btcSwing5s * 100).toFixed(3)}% in 5s — skipping late entry`);
            return;
        }
        const impliedProb = entryPrice;
        const eff = this.getEffectiveRange();
        const maxLatePos = Math.min(this.config.lateEntryMaxPositionUsdc, eff.max);
        const availableBalance = this.liveCurrentBalance ?? (this._startingBalance + this.totalProfit);
        const positionUsdc = Math.min(maxLatePos, availableBalance * 0.8);
        if (positionUsdc < eff.min)
            return;
        let shares = Math.floor((positionUsdc / entryPrice) * 100) / 100;
        if (shares < this.minOrderSizeShares) {
            const bufferedShares = Math.ceil(this.minOrderSizeShares * this.BUY_FEE_BUFFER * 100) / 100;
            const candidateUsd = bufferedShares * entryPrice;
            if (candidateUsd <= eff.max && candidateUsd <= availableBalance) {
                shares = bufferedShares;
            }
            else {
                this.maybeLogScalperDebug(`Late entry: minOrderSize ${bufferedShares} shares ($${candidateUsd.toFixed(2)}) exceeds ` +
                    `maxPosition $${eff.max.toFixed(0)} or balance $${availableBalance.toFixed(2)}. Skip.`);
                return;
            }
        }
        const minCost = shares * entryPrice;
        if (minCost > availableBalance || minCost > eff.max) {
            this.maybeLogScalperDebug(`Late entry: cost $${minCost.toFixed(2)} exceeds limit (balance=$${availableBalance.toFixed(2)}, max=$${eff.max.toFixed(0)})`);
            return;
        }
        const expectedReturn = (1.0 / entryPrice - 1) * 100;
        const entryRuleSummary = `LATE ENTRY ${timeToClose}s left: ${side} @ $${entryPrice.toFixed(2)} (${(impliedProb * 100).toFixed(0)}% implied) | ` +
            `Expected ROI: +${expectedReturn.toFixed(1)}% | Position: $${(shares * entryPrice).toFixed(2)}`;
        (0, logger_1.logPrintln)(`[Scalper] LATE ENTRY: ${side} | Ask: $${entryPrice.toFixed(2)} | ` +
            `${timeToClose}s left | Expected ROI: +${expectedReturn.toFixed(1)}% | Shares: ${shares}`);
        await this.executeBuy(side, tokenId, shares, entryPrice, entryRuleSummary);
    }
    /**
     * Smart position sizing using three proven quant factors:
     *
     * 1. Fractional Kelly Criterion (prediction market variant):
     *    f* = (p - c) / (1 - c)  where p = estimated win prob, c = entry cost
     *    We use Half-Kelly (f=0.5) for safety — captures ~75% of optimal growth
     *    with 50% less variance. (Standard in professional trading)
     *
     * 2. Momentum signal strength:
     *    How far above the threshold the signal is. A signal that is 3x the
     *    threshold is much more reliable than one barely crossing it.
     *    Normalized to [0, 1] with a cap at 5x threshold.
     *
     * 3. Spread quality:
     *    Tight bid/ask spread = reliable price data = higher confidence.
     *    Wide spread = uncertain pricing = reduce position.
     */
    computeSmartPositionSize(absSpotChange, threshold, entryPrice, side, upAsk, downAsk) {
        const range = this.getEffectiveRange();
        const minPos = range.min;
        const maxPos = range.max;
        // --- Factor 1: Momentum strength (0 to 1) ---
        const momentumRatio = absSpotChange / threshold;
        const momentumScore = Math.min(1, (momentumRatio - 1) / 4);
        // --- Factor 2: Fractional Kelly for prediction markets ---
        // p = estimated prob this trade wins. Base: our historical 64% win rate.
        // Adjust by momentum strength: weak signal → 55%, strong → 72%
        const baseWinRate = 0.64;
        const adjustedWinRate = Math.min(0.80, baseWinRate + momentumScore * 0.08);
        // Kelly: f* = (p - c) / (1 - c), where c = entry price (cost per share)
        const kellyRaw = (adjustedWinRate - entryPrice) / (1 - entryPrice);
        // Half-Kelly for safety, clamped to [0, 1]
        const kellyFraction = Math.max(0, Math.min(1, kellyRaw * 0.5));
        // --- Factor 3: Spread quality (0 to 1) ---
        const tokenId = side === "Up" ? this.market.upTokenId : this.market.downTokenId;
        const bid = this.polyFeed.bestBids.get(tokenId) ?? 0;
        const ask = side === "Up" ? upAsk : downAsk;
        let spreadQuality = 1;
        if (bid > 0 && ask > 0) {
            const spread = ask - bid;
            // Ideal spread: ≤0.02 → quality=1.  Bad: ≥0.15 → quality→0.2
            spreadQuality = Math.max(0.2, Math.min(1, 1 - (spread - 0.02) / 0.16));
        }
        // --- Combined confidence: geometric mean of all factors ---
        const confidence = Math.cbrt(kellyFraction * (0.3 + 0.7 * momentumScore) * spreadQuality);
        const clampedConfidence = Math.max(0, Math.min(1, confidence));
        // Map confidence to position range — enforce Polymarket's $1.00 minimum
        const rawPos = minPos + clampedConfidence * (maxPos - minPos);
        const positionUsdc = Math.max(1, Math.max(minPos, Math.min(maxPos, Math.round(rawPos))));
        return { positionUsdc, confidence: clampedConfidence, kellyFraction, spreadQuality };
    }
    async executeBuy(side, tokenId, shares, price, entryRuleSummary) {
        if (this.isPlacingBuy)
            return;
        if (!this.simulation && Date.now() < this.geoBlockedUntil) {
            this.phase = { kind: "Cooldown", until: Math.floor(this.geoBlockedUntil / 1000), lastDirection: side };
            return;
        }
        this.isPlacingBuy = true;
        const genAtStart = this._marketGeneration;
        try {
            const tradeId = ++this.paperTradeSeq;
            let cost = shares * price;
            const slug = this.market?.slug ?? "?";
            (0, logger_1.logPrintln)(`[Scalper] BUY ${side} ${shares} shares @ $${price.toFixed(4)}`);
            let actualBuyCostUsdc;
            if (this.simulation) {
                this.logPaperBuyBlock(tradeId, slug, side, shares, price, cost, entryRuleSummary);
            }
            else {
                try {
                    const bal = await this.syncCurrentBalanceFromPolymarket();
                    if (bal < cost * 0.95) {
                        (0, logger_1.logPrintln)(`[Scalper] BUY skipped: insufficient balance ($${bal.toFixed(2)} < $${cost.toFixed(2)} cost)`);
                        this.phase = { kind: "Cooldown", until: Math.floor(Date.now() / 1000) + 30, lastDirection: side };
                        return;
                    }
                }
                catch (e) {
                    (0, logger_1.logPrintln)(`[Scalper] Balance pre-check failed, proceeding: ${e}`);
                }
                const MAX_BUY_SLIPPAGE = 0.15; // max 15% above original ask
                const originalAsk = price;
                const maxAttempts = 3;
                const delays = [0, 500, 1000];
                let placed = false;
                let fillPrice = price;
                let fillShares = shares;
                for (let i = 0; i < maxAttempts; i++) {
                    if (i > 0) {
                        await this.sleep(delays[i]);
                        // Pre-retry slippage check: if current ask already too high, stop retrying
                        const currentAsk = this.polyFeed.bestAsks.get(tokenId) ?? 0;
                        if (currentAsk > 0 && currentAsk > originalAsk * (1 + MAX_BUY_SLIPPAGE)) {
                            (0, logger_1.logPrintln)(`[Scalper] BUY RETRY ABORTED: ask moved $${originalAsk.toFixed(4)} → $${currentAsk.toFixed(4)} ` +
                                `(+${(((currentAsk - originalAsk) / originalAsk) * 100).toFixed(1)}% > ${MAX_BUY_SLIPPAGE * 100}% slippage cap)`);
                            break;
                        }
                        // Pre-retry balance check: ensure we can still afford the order at current price
                        try {
                            const freshBal = await this.syncCurrentBalanceFromPolymarket();
                            const estimatedCost = (currentAsk > 0 ? currentAsk : originalAsk) * shares;
                            if (estimatedCost > freshBal * 0.90) {
                                (0, logger_1.logPrintln)(`[Scalper] BUY RETRY ABORTED: cost $${estimatedCost.toFixed(2)} > 90% balance $${(freshBal * 0.90).toFixed(2)}`);
                                break;
                            }
                        }
                        catch (e) {
                            (0, logger_1.logPrintln)(`[Scalper] Pre-retry balance check failed, proceeding: ${e}`);
                        }
                    }
                    try {
                        const result = await this.api.placeMarketOrder(tokenId, shares, "BUY");
                        if (result.actualPrice !== undefined)
                            fillPrice = result.actualPrice;
                        if (result.actualSize !== undefined)
                            fillShares = result.actualSize;
                        (0, logger_1.logPrintln)(`[Scalper] REAL: Buy order placed${i > 0 ? ` (attempt ${i + 1})` : ""} — fillPrice=$${fillPrice.toFixed(4)} fillShares=${fillShares}`);
                        placed = true;
                        break;
                    }
                    catch (e) {
                        if (this.isGeoBlockedError(e)) {
                            const mins = 15;
                            this.geoBlockedUntil = Date.now() + mins * 60000;
                            this.phase = { kind: "Cooldown", until: Math.floor(this.geoBlockedUntil / 1000), lastDirection: side };
                            (0, logger_1.logPrintln)(`[Scalper] GEO-BLOCKED (403). Live order flow paused for ${mins} minutes. Switch to SIM mode or run from an allowed region.`);
                            return;
                        }
                        (0, logger_1.logPrintln)(`[Scalper] BUY FAILED (attempt ${i + 1}/${maxAttempts}): ${e}`);
                    }
                }
                if (!placed) {
                    (0, logger_1.logPrintln)("[Scalper] BUY ABANDONED after 3 attempts — entering 60s cooldown");
                    this.phase = { kind: "Cooldown", until: Math.floor(Date.now() / 1000) + 60, lastDirection: side };
                    return;
                }
                // Post-fill slippage guard: if actual fill price is too far above original ask, reverse
                const slippage = (fillPrice - originalAsk) / originalAsk;
                if (slippage > MAX_BUY_SLIPPAGE) {
                    (0, logger_1.logPrintln)(`[Scalper] SLIPPAGE REJECT: filled @ $${fillPrice.toFixed(4)} vs signal ask $${originalAsk.toFixed(4)} ` +
                        `(+${(slippage * 100).toFixed(1)}% > ${MAX_BUY_SLIPPAGE * 100}% cap) — selling immediately`);
                    // Wait for settlement then sell
                    await this.sleep(3000);
                    try {
                        const bal = await this.api.getConditionalTokenBalance(tokenId);
                        if (bal > 0) {
                            await this.api.placeMarketOrder(tokenId, bal, "SELL", "0.01", false, 0.20);
                            (0, logger_1.logPrintln)(`[Scalper] SLIPPAGE reversal SELL placed (${bal.toFixed(4)} shares)`);
                        }
                    }
                    catch (e) {
                        (0, logger_1.logPrintln)(`[Scalper] SLIPPAGE reversal SELL failed: ${e}`);
                    }
                    this.phase = { kind: "Cooldown", until: Math.floor(Date.now() / 1000) + 60, lastDirection: side };
                    return;
                }
                price = fillPrice;
                shares = fillShares;
                cost = shares * price;
                try {
                    const verified = await this.verifyFillFromPolymarket("BUY", tokenId, fillPrice, fillShares);
                    if (verified) {
                        (0, logger_1.logPrintln)(`[Scalper] BUY FILL VERIFIED via Polymarket: ${verified.size} shares @ $${verified.price.toFixed(4)} ` +
                            `(order: ${fillShares} @ $${fillPrice.toFixed(4)})` +
                            (verified.usdcSize != null ? ` | USDC: $${verified.usdcSize.toFixed(2)}` : ""));
                        fillPrice = verified.price;
                        fillShares = verified.size;
                        if (verified.usdcSize != null && verified.usdcSize > 0) {
                            actualBuyCostUsdc = verified.usdcSize;
                        }
                    }
                    else {
                        (0, logger_1.logPrintln)(`[Scalper] BUY fill not found in Polymarket history (using order price)`);
                    }
                }
                catch (e) {
                    (0, logger_1.logPrintln)(`[Scalper] BUY fill verification failed: ${e}`);
                }
                // MANDATORY balance gate: verify we actually received tokens.
                // On-chain settlement can take several seconds after the CLOB reports
                // "matched". We retry with delays and also compare against expected
                // amount — if balance is way below expected, settlement is still in
                // progress and we keep waiting.
                let actualBalance = 0;
                const expectedShares = shares * 0.95; // allow ~5% fee/rounding
                const BALANCE_CHECK_DELAYS = [3000, 3000, 4000, 5000];
                for (let attempt = 0; attempt < BALANCE_CHECK_DELAYS.length; attempt++) {
                    await this.sleep(BALANCE_CHECK_DELAYS[attempt]);
                    try {
                        actualBalance = await this.api.getConditionalTokenBalance(tokenId);
                    }
                    catch (e) {
                        (0, logger_1.logPrintln)(`[Scalper] Post-buy balance check failed (attempt ${attempt + 1}): ${e}`);
                    }
                    if (actualBalance >= expectedShares) {
                        (0, logger_1.logPrintln)(`[Scalper] Token balance confirmed: ${actualBalance.toFixed(6)} shares` +
                            (attempt > 0 ? ` (after ${attempt + 1} checks)` : ""));
                        break;
                    }
                    if (actualBalance > 0 && actualBalance < expectedShares) {
                        (0, logger_1.logPrintln)(`[Scalper] Partial settlement: ${actualBalance.toFixed(6)} / ~${shares.toFixed(4)} expected — ` +
                            `waiting for full settlement (attempt ${attempt + 1}/${BALANCE_CHECK_DELAYS.length})...`);
                    }
                    else if (actualBalance <= 0) {
                        (0, logger_1.logPrintln)(`[Scalper] Balance still 0 — waiting (attempt ${attempt + 1}/${BALANCE_CHECK_DELAYS.length})...`);
                    }
                }
                if (actualBalance <= 0) {
                    (0, logger_1.logPrintln)(`[Scalper] BUY PHANTOM DETECTED: order reported success but token balance is 0 ` +
                        `after ${BALANCE_CHECK_DELAYS.length} checks (~${(BALANCE_CHECK_DELAYS.reduce((a, b) => a + b, 0) / 1000)}s total). ` +
                        `The order was NOT filled. Cancelling any open orders and entering cooldown.`);
                    try {
                        await this.api.cancelAllOrders();
                    }
                    catch { }
                    this.phase = { kind: "Cooldown", until: Math.floor(Date.now() / 1000) + 60, lastDirection: side };
                    return;
                }
                if (actualBalance < shares) {
                    (0, logger_1.logPrintln)(`[Scalper] Post-buy balance: ordered ${shares.toFixed(4)} → settled ${actualBalance.toFixed(6)} (fee/settlement adjustment)`);
                    shares = actualBalance;
                    cost = shares * price;
                }
                if (this._marketGeneration !== genAtStart) {
                    (0, logger_1.logPrintln)(`[Scalper] BUY completed but market changed during order — attempting immediate sell to avoid orphaned position`);
                    try {
                        await this.api.placeMarketOrder(tokenId, shares, "SELL", "0.01", false, 0.20);
                        (0, logger_1.logPrintln)(`[Scalper] Orphan prevention SELL succeeded`);
                    }
                    catch (e) {
                        (0, logger_1.logPrintln)(`[Scalper] Orphan prevention SELL failed: ${e} — tokens will resolve at market expiry`);
                    }
                    this.phase = { kind: "Cooldown", until: Math.floor(Date.now() / 1000) + 60, lastDirection: side };
                    return;
                }
            }
            this.phase = {
                kind: "InPosition",
                tradeId,
                side,
                tokenId,
                entryPrice: price,
                shares,
                entryTime: Math.floor(Date.now() / 1000),
                entryRuleSummary,
                actualCostUsdc: this.simulation ? undefined : actualBuyCostUsdc,
            };
            this.openPositionCount++;
            this.sellRetryCount = 0;
            this.stuckSellShares = null;
        }
        finally {
            this.isPlacingBuy = false;
        }
    }
    async verifyFillFromPolymarket(side, tokenId, expectedPrice, expectedShares) {
        const wallet = this.api.getWalletAddress();
        if (!wallet || !this.market)
            return null;
        try {
            await this.sleep(1500);
            const fills = await this.api.getUserFills(wallet, this.market.conditionId, 10);
            const now = Date.now();
            const match = fills.find(f => {
                const sideMatch = f.side.toUpperCase() === side;
                const tokenMatch = (f.tokenID === tokenId || f.asset === tokenId);
                const recent = (now - f.timestamp * 1000) < 30000;
                return sideMatch && tokenMatch && recent;
            });
            if (match) {
                return { price: match.price, size: match.size, usdcSize: match.usdcSize };
            }
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Scalper] Fill verification query failed: ${e}`);
        }
        return null;
    }
    async reconcileBalanceWithPolymarket() {
        if (this.simulation)
            return;
        try {
            const realBalance = await this.syncCurrentBalanceFromPolymarket();
            if (realBalance <= 0)
                return;
            // Only update liveCurrentBalance — never touch liveStartingBalance
            // or totalProfit. Settlement timing causes temporary balance swings
            // that would create oscillating drift if we rebased.
            this.liveCurrentBalance = realBalance;
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Scalper] Balance reconciliation failed: ${e}`);
        }
    }
    computeSafeSellShares(available, wanted) {
        if (available <= 0)
            return wanted;
        // Sell ALL available tokens to prevent share leak (GitHub Issue #245).
        // Settlement often delivers slightly more or fewer shares than ordered.
        if (available >= wanted - 0.0001)
            return Math.floor(available * 1000000) / 1000000;
        return Math.floor(available * 1000000) / 1000000;
    }
    emitTrade(data) {
        if (this.onTradeCallback) {
            try {
                this.onTradeCallback(data);
            }
            catch { /* ignore */ }
        }
        const currentBalance = this.simulation
            ? this._startingBalance + this.totalProfit
            : (this.liveCurrentBalance ?? this._startingBalance + this.totalProfit);
        const startingBalance = this.liveStartingBalance ?? this._startingBalance;
        (0, telegram_1.sendTradeAlert)({
            ...data,
            startingBalance,
            currentBalance,
            totalProfit: this.totalProfit,
            simulation: this.simulation,
        }).catch(() => { });
    }
    isGeoBlockedError(e) {
        const msg = String(e ?? "").toLowerCase();
        return msg.includes("trading restricted in your region") || msg.includes("geoblock");
    }
    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    logPaperBuyBlock(tradeId, slug, side, shares, price, cost, entryRuleSummary) {
        (0, logger_1.logPrintln)("");
        (0, logger_1.logPrintln)(`---------- SIMÜLASYON | ÖRNEK ALIM #${tradeId} ----------`);
        (0, logger_1.logPrintln)(`Piyasa (slug): ${slug}`);
        (0, logger_1.logPrintln)(`Algoritma özeti: ${entryRuleSummary}`);
        (0, logger_1.logPrintln)(`Taraf: ${side} | Pay (shares): ${shares} | Giriş fiyatı (sipariş defteri ask): $${price.toFixed(4)}`);
        (0, logger_1.logPrintln)(`Tahmini maliyet (kağıt): $${cost.toFixed(2)}  (= ${shares} × $${price.toFixed(4)})`);
        (0, logger_1.logPrintln)("Polymarket'e gerçek BUY emri gönderilmedi; sadece strateji + canlı orderbook ile kağıt pozisyon açıldı.");
        (0, logger_1.logPrintln)("Çıkış: take-profit / stop-loss / periyot sonu kuralları bid fiyatına göre hesaplanır.");
        (0, logger_1.logPrintln)("-----------------------------------------------------------");
        (0, logger_1.logPrintln)("");
    }
    resolveSellReferencePrice(tokenId) {
        const bid = this.polyFeed.bestBids.get(tokenId) ?? 0;
        const ask = this.polyFeed.bestAsks.get(tokenId) ?? 0;
        if (bid <= 0)
            return null;
        if (ask > 0 && ask - bid > 0.5) {
            return (bid + ask) / 2;
        }
        return bid;
    }
    async checkExitConditions() {
        if (this.phase.kind !== "InPosition")
            return;
        const tid = this.phase.tokenId;
        const exitPx = this.resolveSellReferencePrice(tid);
        if (exitPx === null)
            return;
        const pnlPercent = (exitPx - this.phase.entryPrice) / this.phase.entryPrice;
        const heldSeconds = Math.floor(Date.now() / 1000) - this.phase.entryTime;
        if (pnlPercent >= this.config.takeProfitPercent) {
            await this.exitPosition("take_profit");
            return;
        }
        // Rapid reversal guard: catastrophic drop within first seconds → manipulation or flash crash.
        // In production, balance settlement takes 3-15s, so real market exposure starts earlier
        // than heldSeconds suggests. Use a wider window and stricter threshold.
        const rapidWindow = this.simulation ? 3 : 10;
        const rapidThreshold = this.simulation ? -0.30 : -0.40;
        if (heldSeconds <= rapidWindow && pnlPercent <= rapidThreshold) {
            (0, logger_1.logPrintln)(`[Scalper] RAPID REVERSAL detected: ${(pnlPercent * 100).toFixed(1)}% in ${heldSeconds}s — emergency exit`);
            await this.exitPosition("rapid_reversal");
            return;
        }
        if (pnlPercent <= -this.config.stopLossPercent) {
            await this.exitPosition("stop_loss");
            return;
        }
    }
    async exitPosition(reason) {
        if (this.phase.kind !== "InPosition")
            return;
        if (this.isExitingPosition)
            return;
        this.isExitingPosition = true;
        try {
            await this.exitPositionInner(reason);
        }
        finally {
            this.isExitingPosition = false;
        }
    }
    async exitPositionInner(reason) {
        if (this.phase.kind !== "InPosition")
            return;
        const phase = this.phase;
        const exitRef = this.resolveSellReferencePrice(phase.tokenId) ?? this.polyFeed.bestBids.get(phase.tokenId) ?? phase.entryPrice;
        const currentBid = exitRef;
        const pnlPerShare = currentBid - phase.entryPrice;
        let totalPnl = pnlPerShare * phase.shares;
        let pnlPercent = phase.entryPrice > 0 ? (pnlPerShare / phase.entryPrice) * 100 : 0;
        let costBasis = phase.shares * phase.entryPrice;
        let proceeds = phase.shares * currentBid;
        (0, logger_1.logPrintln)(`[Scalper] SELL ${phase.side} ${phase.shares} shares @ $${currentBid.toFixed(4)} | ` +
            `Reason: ${reason} | P&L: $${totalPnl.toFixed(2)} (${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(1)}%)`);
        let actualSellPrice;
        if (this.simulation) {
            const slug = this.market?.slug ?? "?";
            const reasonTr = this.describeExitReason(reason);
            (0, logger_1.logPrintln)("");
            (0, logger_1.logPrintln)(`---------- SIMÜLASYON | ÖRNEK SATIŞ / KAPANIŞ #${phase.tradeId} ----------`);
            (0, logger_1.logPrintln)(`Piyasa: ${slug}`);
            (0, logger_1.logPrintln)(`Giriş özeti: ${phase.entryRuleSummary}`);
            (0, logger_1.logPrintln)(`Giriş (kağıt): ${phase.shares} pay × $${phase.entryPrice.toFixed(4)} = $${costBasis.toFixed(2)} maliyet`);
            (0, logger_1.logPrintln)(`Çıkış (canlı bid): ${phase.shares} pay × $${currentBid.toFixed(4)} = $${proceeds.toFixed(2)} tahmini tahsilat`);
            (0, logger_1.logPrintln)(`Çıkış nedeni: ${reasonTr} (${reason})`);
            (0, logger_1.logPrintln)(`Brüt K/Z (ücret düşülmeden, bid/ask spread modeli): $${totalPnl.toFixed(2)} ` +
                `(${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}% giriş fiyatına göre)`);
            (0, logger_1.logPrintln)("Not: Girişte best ask, çıkışta best bid kullanılır. Gerçek hesapta taker ücreti, kısmi dolma ve slippage bu K/Z'yi değiştirir.");
            (0, logger_1.logPrintln)("Polymarket'e gerçek SELL emri gönderilmedi.");
            (0, logger_1.logPrintln)("------------------------------------------------------------------");
            (0, logger_1.logPrintln)("");
            this.appendSimulationTradeJsonl({
                tradeId: phase.tradeId,
                slug,
                side: phase.side,
                entryPrice: phase.entryPrice,
                exitBid: currentBid,
                shares: phase.shares,
                costBasis,
                proceeds,
                grossPnlUsd: totalPnl,
                grossPnlPercent: pnlPercent,
                exitReason: reason,
                exitReasonTr: reasonTr,
                simulation: true,
                tsExitIso: new Date().toISOString(),
            });
        }
        else {
            // ---- PRODUCTION SELL FLOW (hardened) ----
            // Snapshot USDC balance before sell so we can measure actual
            // proceeds via balance delta (FOK limit price != fill price).
            let preSellBalance = 0;
            try {
                preSellBalance = await this.api.getCollateralBalance();
            }
            catch { /* best-effort */ }
            // Use persisted stuckSellShares from previous retry if available
            let sellShares = this.stuckSellShares ?? phase.shares;
            // Only query balance on fresh sell (not stuck retries, where we already know the amount)
            if (this.stuckSellShares == null) {
                try {
                    const available = await this.api.getConditionalTokenBalance(phase.tokenId);
                    (0, logger_1.logPrintln)(`[Scalper] SELL balance query: available=${available.toFixed(6)}, phase.shares=${phase.shares}`);
                    sellShares = this.computeSafeSellShares(available, phase.shares);
                }
                catch (e) {
                    (0, logger_1.logPrintln)(`[Scalper] SELL balance check failed (using phase.shares=${phase.shares}): ${e}`);
                }
            }
            if (sellShares > 0 && sellShares < this.minOrderSizeShares && this.minOrderSizeShares > 1) {
                (0, logger_1.logPrintln)(`[Scalper] SELL shares ${sellShares.toFixed(4)} < minOrderSize ${this.minOrderSizeShares} — ` +
                    `attempting sell anyway (CLOB may allow closing positions below min)`);
            }
            if (sellShares <= 0) {
                (0, logger_1.logPrintln)("[Scalper] SELL skipped: zero balance. Position settled or dust.");
                await this.abandonCurrentPosition("zero_balance");
                return;
            }
            // Wider slippage tolerance for urgent exits where getting out trumps price
            const panicReasons = ["rapid_reversal", "force_exit_rollover", "stuck_retry", "period_ending"];
            const sellSlippage = panicReasons.includes(reason) ? 0.20 : 0.03;
            // Inner retry loop
            const maxAttempts = this.MAX_SELL_INNER_RETRIES;
            const delays = [0, 500, 1000];
            let sold = false;
            for (let i = 0; i < maxAttempts; i++) {
                if (i > 0)
                    await this.sleep(delays[i]);
                try {
                    const result = await this.api.placeMarketOrder(phase.tokenId, sellShares, "SELL", "0.01", false, sellSlippage);
                    if (result.actualPrice !== undefined)
                        actualSellPrice = result.actualPrice;
                    (0, logger_1.logPrintln)(`[Scalper] REAL: Sell placed (${sellShares.toFixed(4)} shares @ $${(actualSellPrice ?? currentBid).toFixed(4)})${i > 0 ? ` attempt ${i + 1}` : ""}`);
                    sold = true;
                    break;
                }
                catch (e) {
                    const errMsg = String(e ?? "");
                    // Extract actual balance from the error details
                    const parsed = this.tryParseInsufficientBalance(errMsg);
                    if (parsed) {
                        const reduced = this.computeSafeSellShares(parsed.balance, sellShares);
                        if (reduced > 0 && reduced < sellShares) {
                            (0, logger_1.logPrintln)(`[Scalper] SELL size reduced: ${sellShares.toFixed(4)} → ${reduced.toFixed(4)} ` +
                                `(CLOB says balance=${parsed.balance.toFixed(6)}, wanted=${parsed.requested.toFixed(6)})`);
                            sellShares = reduced;
                            if (sellShares < this.minOrderSizeShares && this.minOrderSizeShares > 1) {
                                (0, logger_1.logPrintln)(`[Scalper] Reduced size ${sellShares.toFixed(4)} < minOrderSize ${this.minOrderSizeShares} — trying sell anyway`);
                            }
                            continue;
                        }
                        if (reduced <= 0) {
                            (0, logger_1.logPrintln)("[Scalper] CLOB reports zero available balance. Abandoning position.");
                            await this.abandonCurrentPosition("clob_zero_balance");
                            return;
                        }
                    }
                    // "Size lower than minimum" → position too small to sell
                    const minMatch = errMsg.match(/Size\s*\([\d.]+\)\s*lower than the minimum:\s*(\d+)/i);
                    if (minMatch) {
                        const clobMin = Number(minMatch[1]);
                        if (sellShares < clobMin) {
                            (0, logger_1.logPrintln)(`[Scalper] SELL impossible: ${sellShares.toFixed(4)} < CLOB min ${clobMin} shares. Abandoning.`);
                            await this.abandonCurrentPosition("below_clob_minimum");
                            return;
                        }
                    }
                    (0, logger_1.logPrintln)(`[Scalper] SELL FAILED (attempt ${i + 1}/${maxAttempts}): ${e}`);
                }
            }
            if (!sold) {
                this.sellRetryCount++;
                this.stuckSellShares = sellShares;
                (0, logger_1.logPrintln)(`[Scalper] SELL STUCK — retry #${this.sellRetryCount}/${this.MAX_SELL_STUCK_RETRIES} ` +
                    `(preserved sellShares=${sellShares.toFixed(4)} for next tick)`);
                return;
            }
            this.sellRetryCount = 0;
            this.stuckSellShares = null;
            // Determine actual proceeds via balance delta.
            // FOK SELL limit price != actual fill price — the CLOB fills at
            // the best available bids, which can be much higher than the limit.
            let actualSellUsdcSize;
            // Wait for on-chain settlement, then measure USDC balance change
            const SELL_SETTLE_DELAYS = [3000, 3000, 4000];
            if (preSellBalance > 0) {
                for (let attempt = 0; attempt < SELL_SETTLE_DELAYS.length; attempt++) {
                    await this.sleep(SELL_SETTLE_DELAYS[attempt]);
                    try {
                        const postBalance = await this.api.getCollateralBalance();
                        const delta = postBalance - preSellBalance;
                        if (delta > 0.001) {
                            actualSellUsdcSize = delta;
                            const impliedPrice = delta / sellShares;
                            (0, logger_1.logPrintln)(`[Scalper] SELL PROCEEDS (balance delta): $${delta.toFixed(2)} ` +
                                `(pre=$${preSellBalance.toFixed(2)} post=$${postBalance.toFixed(2)}) ` +
                                `implied fill @ $${impliedPrice.toFixed(4)}`);
                            // Update liveCurrentBalance while we have a fresh reading
                            this.liveCurrentBalance = postBalance;
                            break;
                        }
                        if (attempt < SELL_SETTLE_DELAYS.length - 1) {
                            (0, logger_1.logPrintln)(`[Scalper] SELL settlement pending (delta=$${delta.toFixed(4)}) — waiting...`);
                        }
                    }
                    catch (e) {
                        (0, logger_1.logPrintln)(`[Scalper] Post-sell balance check failed: ${e}`);
                    }
                }
            }
            // Fallback: try Polymarket fill history if balance-delta didn't work
            if (actualSellUsdcSize == null) {
                try {
                    const verified = await this.verifyFillFromPolymarket("SELL", phase.tokenId, actualSellPrice ?? currentBid, sellShares);
                    if (verified) {
                        (0, logger_1.logPrintln)(`[Scalper] SELL FILL VERIFIED via Polymarket: ${verified.size} shares @ $${verified.price.toFixed(4)} ` +
                            `(order: ${sellShares} @ $${(actualSellPrice ?? currentBid).toFixed(4)})` +
                            (verified.usdcSize != null ? ` | USDC: $${verified.usdcSize.toFixed(2)}` : ""));
                        actualSellPrice = verified.price;
                        sellShares = verified.size;
                        if (verified.usdcSize != null && verified.usdcSize > 0) {
                            actualSellUsdcSize = verified.usdcSize;
                        }
                    }
                    else {
                        (0, logger_1.logPrintln)(`[Scalper] SELL fill not found in Polymarket history (using order limit price)`);
                    }
                }
                catch (e) {
                    (0, logger_1.logPrintln)(`[Scalper] SELL fill verification failed: ${e}`);
                }
            }
            // Recalculate P&L using actual proceeds (balance delta or verified fill)
            const actualExitPx = actualSellUsdcSize != null
                ? actualSellUsdcSize / sellShares
                : (actualSellPrice ?? currentBid);
            const realCost = phase.actualCostUsdc ?? (phase.shares * phase.entryPrice);
            const realProceeds = actualSellUsdcSize ?? (sellShares * actualExitPx);
            const realPnl = realProceeds - realCost;
            const realPnlPct = realCost > 0 ? (realPnl / realCost) * 100 : 0;
            if (Math.abs(realPnl - totalPnl) > 0.001) {
                (0, logger_1.logPrintln)(`[Scalper] P&L CORRECTED: estimated $${totalPnl.toFixed(2)} → actual $${realPnl.toFixed(2)} ` +
                    `(cost=$${realCost.toFixed(2)}, proceeds=$${realProceeds.toFixed(2)}, ` +
                    `sold ${sellShares.toFixed(4)} shares @ $${actualExitPx.toFixed(4)})`);
            }
            totalPnl = realPnl;
            pnlPercent = realPnlPct;
            costBasis = realCost;
            proceeds = realProceeds;
        }
        if (totalPnl < 0) {
            this.dailyLoss += Math.abs(totalPnl);
        }
        else {
            this.dailyProfit += totalPnl;
        }
        this.totalProfit += totalPnl;
        this.openPositionCount = Math.max(0, this.openPositionCount - 1);
        this.emitTrade({
            side: phase.side, entryPrice: phase.entryPrice, exitPrice: actualSellPrice ?? currentBid,
            shares: phase.shares, costBasis, proceeds, pnlUsd: totalPnl,
            pnlPercent, exitReason: reason,
        });
        (0, logger_1.logPrintln)(`[Scalper] ${this.simulation ? "Kağıt özet" : "Özet"} — bugün: +$${this.dailyProfit.toFixed(2)} / -$${this.dailyLoss.toFixed(2)} | ` +
            `Toplam: $${this.totalProfit.toFixed(2)} | Günlük zarar: $${this.dailyLoss.toFixed(2)}/$${this.config.dailyLossLimit}`);
        await this.reconcileBalanceWithPolymarket();
        // Extended cooldown after catastrophic exits to avoid re-entering a manipulated market
        const cooldownSec = reason === "rapid_reversal"
            ? 120
            : this.config.scalpCooldownSeconds;
        this.phase = {
            kind: "Cooldown",
            until: Math.floor(Date.now() / 1000) + cooldownSec,
            lastDirection: phase.side,
        };
    }
    tryParseInsufficientBalance(errMsg) {
        // Pattern 1: "balance: 1166740, order amount: 1660000"
        const m1 = errMsg.match(/balance:\s*(\d+)[^]*?order\s*amount:\s*(\d+)/i);
        if (m1) {
            const bal = Number(m1[1]);
            const req = Number(m1[2]);
            if (Number.isFinite(bal) && Number.isFinite(req)) {
                return { balance: bal / 1000000, requested: req / 1000000 };
            }
        }
        // Pattern 2: "balance: 1166740, sum of matched orders: X, order amount: Y"
        const m2 = errMsg.match(/balance:\s*(\d+)/i);
        if (m2) {
            const bal = Number(m2[1]);
            const reqMatch = errMsg.match(/order\s*amount:\s*(\d+)/i);
            const req = reqMatch ? Number(reqMatch[1]) : bal + 1;
            if (Number.isFinite(bal)) {
                return { balance: bal / 1000000, requested: Number.isFinite(req) ? req / 1000000 : (bal + 1) / 1000000 };
            }
        }
        return null;
    }
    describeExitReason(reason) {
        switch (reason) {
            case "take_profit":
                return "Kar al (take-profit eşiği)";
            case "stop_loss":
                return "Zarar durdur (stop-loss eşiği)";
            case "period_ending":
                return "Periyot bitmeden çıkış (EXIT_BEFORE_CLOSE_SECONDS)";
            case "daily_loss_limit":
                return "Günlük zarar limiti";
            case "rapid_reversal":
                return "Hızlı tersine dönüş (manipulation koruması)";
            case "stuck_retry":
                return "Önceki satış başarısız — yeniden deneme";
            case "sell_abandoned":
                return "Satış başarısız — pozisyon terk edildi, market süresi dolacak";
            case "below_min_order_size":
                return "Pozisyon minimum pay sayısının altında — satılamaz, market sonunda çözülecek";
            case "zero_balance":
                return "CLOB bakiye sıfır — pozisyon zaten çözülmüş veya yetersiz";
            case "reduced_below_min":
                return "Bakiye düzeltme sonrası minimum altına düştü — terk edildi";
            case "clob_zero_balance":
                return "CLOB sıfır bakiye bildirdi — terk edildi";
            case "below_clob_minimum":
                return "CLOB minimum sipariş boyutunun altında — terk edildi";
            case "late_entry":
                return "Geç giriş stratejisi — yüksek olasılık";
            case "hold_to_resolution":
                return "Kazanç pozisyonunda — çözüme kadar tutuluyor";
            default:
                return reason;
        }
    }
    appendSimulationTradeJsonl(record) {
        if (!this.simulation)
            return;
        const file = path.join(process.cwd(), "simulation_trades.jsonl");
        try {
            fs.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8" });
        }
        catch (e) {
            (0, logger_1.logPrintln)(`[Scalper] simulation_trades.jsonl yazılamadı: ${e}`);
        }
    }
    async abandonCurrentPosition(reason) {
        if (this.phase.kind !== "InPosition")
            return;
        const phase = this.phase;
        // Check actual balance to determine if this was a phantom trade.
        // If we hold 0 tokens, the buy never actually filled — do NOT record
        // any P&L (no money moved).
        let isPhantom = false;
        if (!this.simulation) {
            try {
                const bal = await this.api.getConditionalTokenBalance(phase.tokenId);
                if (bal <= 0) {
                    isPhantom = true;
                    (0, logger_1.logPrintln)(`[Scalper] PHANTOM TRADE DETECTED on abandon (${reason}): token balance is 0. ` +
                        `No P&L recorded — the buy never actually filled.`);
                }
            }
            catch (e) {
                (0, logger_1.logPrintln)(`[Scalper] Balance check in abandon failed: ${e}`);
            }
        }
        const exitRef = this.resolveSellReferencePrice(phase.tokenId) ?? phase.entryPrice;
        const pnlPerShare = exitRef - phase.entryPrice;
        const totalPnl = isPhantom ? 0 : pnlPerShare * phase.shares;
        const costBasis = isPhantom ? 0 : phase.shares * phase.entryPrice;
        const proceeds = isPhantom ? 0 : phase.shares * exitRef;
        const pnlPct = phase.entryPrice > 0 ? (pnlPerShare / phase.entryPrice) * 100 : 0;
        (0, logger_1.logPrintln)(`[Scalper] POSITION ABANDONED (${reason}): ${phase.side} ${phase.shares} shares | ` +
            `Entry: $${phase.entryPrice.toFixed(4)} | Est exit: $${exitRef.toFixed(4)} | ` +
            (isPhantom
                ? `PHANTOM — no P&L recorded`
                : `Est P&L: $${totalPnl.toFixed(2)} — tokens will resolve at market expiry`));
        if (!isPhantom) {
            if (totalPnl < 0) {
                this.dailyLoss += Math.abs(totalPnl);
            }
            else {
                this.dailyProfit += totalPnl;
            }
            this.totalProfit += totalPnl;
            this.emitTrade({
                side: phase.side, entryPrice: phase.entryPrice, exitPrice: exitRef,
                shares: phase.shares, costBasis, proceeds, pnlUsd: totalPnl,
                pnlPercent: pnlPct, exitReason: reason,
            });
        }
        this.openPositionCount = Math.max(0, this.openPositionCount - 1);
        this.sellRetryCount = 0;
        this.stuckSellShares = null;
        this.phase = {
            kind: "Cooldown",
            until: Math.floor(Date.now() / 1000) + this.config.scalpCooldownSeconds * 2,
            lastDirection: phase.side,
        };
    }
    async forceExitWithSell() {
        if (this.phase.kind !== "InPosition")
            return;
        const phase = this.phase;
        (0, logger_1.logPrintln)(`[Scalper] Force exit — position: ${phase.side} ${phase.shares} shares`);
        let actualExitPrice;
        let actualProceeds;
        if (!this.simulation) {
            let preSellBalance = 0;
            try {
                preSellBalance = await this.api.getCollateralBalance();
            }
            catch { /* best-effort */ }
            let sold = false;
            let sellShares = phase.shares;
            try {
                const available = await this.api.getConditionalTokenBalance(phase.tokenId);
                sellShares = this.computeSafeSellShares(available, phase.shares);
                if (sellShares > 0) {
                    const result = await this.api.placeMarketOrder(phase.tokenId, sellShares, "SELL", "0.01", false, 0.20);
                    actualExitPrice = result.actualPrice;
                    (0, logger_1.logPrintln)(`[Scalper] Force exit SELL placed: ${sellShares} shares @ $${(actualExitPrice ?? 0).toFixed(4)} (limit)`);
                    sold = true;
                }
            }
            catch (e) {
                (0, logger_1.logPrintln)(`[Scalper] Force exit SELL failed: ${e}`);
            }
            // Measure actual proceeds via balance delta
            if (sold && preSellBalance > 0) {
                await this.sleep(3000);
                try {
                    const postBalance = await this.api.getCollateralBalance();
                    const delta = postBalance - preSellBalance;
                    if (delta > 0.001) {
                        actualProceeds = delta;
                        actualExitPrice = delta / sellShares;
                        (0, logger_1.logPrintln)(`[Scalper] Force exit PROCEEDS (balance delta): $${delta.toFixed(2)} ` +
                            `implied fill @ $${actualExitPrice.toFixed(4)}`);
                        this.liveCurrentBalance = postBalance;
                    }
                }
                catch { /* best-effort */ }
            }
            if (!sold && this.market) {
                try {
                    (0, logger_1.logPrintln)(`[Scalper] Attempting token redemption for ${this.market.conditionId.slice(0, 16)}...`);
                    await this.api.redeemTokens(this.market.conditionId, phase.tokenId, phase.side);
                    (0, logger_1.logPrintln)(`[Scalper] Redemption successful`);
                }
                catch (e) {
                    (0, logger_1.logPrintln)(`[Scalper] Redemption failed (tokens may resolve at expiry): ${e}`);
                }
            }
        }
        const exitPx = actualExitPrice
            ?? this.resolveSellReferencePrice(phase.tokenId)
            ?? phase.entryPrice;
        const realCost = phase.actualCostUsdc ?? (phase.shares * phase.entryPrice);
        const realProceeds = actualProceeds ?? (phase.shares * exitPx);
        const totalPnl = realProceeds - realCost;
        if (totalPnl < 0) {
            this.dailyLoss += Math.abs(totalPnl);
        }
        else {
            this.dailyProfit += totalPnl;
        }
        this.totalProfit += totalPnl;
        const pnlPct = realCost > 0 ? (totalPnl / realCost) * 100 : 0;
        (0, logger_1.logPrintln)(`[Scalper] Force exit P&L: $${totalPnl.toFixed(2)} (cost=$${realCost.toFixed(2)} proceeds=$${realProceeds.toFixed(2)})`);
        this.emitTrade({
            side: phase.side, entryPrice: phase.entryPrice, exitPrice: exitPx,
            shares: phase.shares, costBasis: realCost,
            proceeds: realProceeds, pnlUsd: totalPnl,
            pnlPercent: pnlPct,
            exitReason: "force_exit_rollover",
        });
        this.openPositionCount = Math.max(0, this.openPositionCount - 1);
        this.sellRetryCount = 0;
        this.stuckSellShares = null;
        this.phase = { kind: "Idle" };
    }
    checkDailyReset() {
        const today = this.todayStr();
        if (today !== this.dailyResetDate) {
            (0, logger_1.logPrintln)(`[Scalper] New day: ${today} | Yesterday P&L: +$${this.dailyProfit.toFixed(2)} / -$${this.dailyLoss.toFixed(2)}`);
            this.dailyLoss = 0;
            this.dailyProfit = 0;
            this.dailyResetDate = today;
        }
    }
    todayStr() {
        return new Date().toISOString().slice(0, 10);
    }
    getStats() {
        return {
            totalProfit: this.totalProfit,
            dailyProfit: this.dailyProfit,
            dailyLoss: this.dailyLoss,
            phase: this.phase.kind,
        };
    }
    getSnapshot() {
        const pos = this.phase.kind === "InPosition" ? {
            side: this.phase.side,
            entryPrice: this.phase.entryPrice,
            shares: this.phase.shares,
            entryTime: this.phase.entryTime,
        } : null;
        const eff = this.getEffectiveRange();
        const displayStarting = this.liveStartingBalance ?? this._startingBalance;
        const displayCurrent = this.simulation
            ? this._startingBalance + this.totalProfit
            : (this.liveCurrentBalance ?? this._startingBalance + this.totalProfit);
        return {
            ...this.getStats(),
            running: this.isRunning,
            simulation: this.simulation,
            tradeCount: this.paperTradeSeq,
            marketSlug: this.market?.slug ?? null,
            periodEndTs: this.market?.periodEndTimestamp ?? 0,
            openPosition: pos,
            minPositionUsdc: this.config.minPositionUsdc,
            maxPositionUsdc: this.config.maxPositionUsdc,
            autoScale: this._autoScale,
            autoScaleBaseMin: this._autoScaleBaseMin,
            autoScaleBaseMax: this._autoScaleBaseMax,
            effectiveMin: eff.min,
            effectiveMax: eff.max,
            startingBalance: displayStarting,
            currentBalance: displayCurrent,
        };
    }
}
exports.Scalper = Scalper;
//# sourceMappingURL=scalper.js.map