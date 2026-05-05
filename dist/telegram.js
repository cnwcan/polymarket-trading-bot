"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTradeAlert = sendTradeAlert;
const logger_1 = require("./logger");
const TELEGRAM_API = "https://api.telegram.org";
const REASON_LABELS = {
    take_profit: "Take Profit",
    stop_loss: "Stop Loss",
    period_ending: "Period Ending",
    hold_to_resolution: "Resolution Payout",
    force_exit_rollover: "Force Exit (Rollover)",
    rapid_reversal: "Rapid Reversal",
    daily_loss_limit: "Daily Loss Limit",
    sell_abandoned: "Sell Abandoned",
    below_clob_minimum: "Below CLOB Min",
    zero_balance: "Zero Balance",
    period_ending_sell_stuck: "Period End (Stuck)",
};
async function sendTradeAlert(data) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId)
        return;
    const isProfit = data.pnlUsd >= 0;
    const icon = isProfit ? "\u2705" : "\u274C";
    const modeTag = data.simulation ? "\uD83E\uDDEA SIM" : "\uD83D\uDD34 LIVE";
    const reasonLabel = REASON_LABELS[data.exitReason] ?? data.exitReason;
    const pnlSign = isProfit ? "+" : "";
    const totalSign = data.totalProfit >= 0 ? "+" : "";
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const text = `${icon} <b>${reasonLabel}</b> | ${modeTag}\n` +
        `\n` +
        `<b>Side:</b> ${data.side}\n` +
        `<b>Entry:</b> $${data.entryPrice.toFixed(4)}\n` +
        `<b>Exit:</b> $${data.exitPrice.toFixed(4)}\n` +
        `<b>Shares:</b> ${data.shares.toFixed(4)}\n` +
        `<b>Cost:</b> $${data.costBasis.toFixed(2)}\n` +
        `<b>Proceeds:</b> $${data.proceeds.toFixed(2)}\n` +
        `<b>P&L:</b> ${pnlSign}$${data.pnlUsd.toFixed(2)} (${pnlSign}${data.pnlPercent.toFixed(1)}%)\n` +
        `\n` +
        `<b>Starting:</b> $${data.startingBalance.toFixed(2)}\n` +
        `<b>Balance:</b> $${data.currentBalance.toFixed(2)}\n` +
        `<b>Total P&L:</b> ${totalSign}$${data.totalProfit.toFixed(2)}\n` +
        `\n` +
        `\u23F0 ${time}`;
    try {
        const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                disable_web_page_preview: true,
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            (0, logger_1.logPrintln)(`[Telegram] Send failed (${resp.status}): ${body}`);
        }
    }
    catch (e) {
        (0, logger_1.logPrintln)(`[Telegram] Send error: ${e}`);
    }
}
//# sourceMappingURL=telegram.js.map