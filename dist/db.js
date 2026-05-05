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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
exports.getDb = getDb;
exports.createSession = createSession;
exports.updateSessionRange = updateSessionRange;
exports.endSession = endSession;
exports.recordTrade = recordTrade;
exports.getSessionById = getSessionById;
exports.getSessions = getSessions;
exports.getSessionTrades = getSessionTrades;
exports.getPnlTimeline = getPnlTimeline;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path = __importStar(require("path"));
let db;
function initDb() {
    const dbPath = path.join(process.cwd(), "sessions.db");
    db = new better_sqlite3_1.default(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");
    db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mode          TEXT    NOT NULL,
      started_at    TEXT    NOT NULL,
      ended_at      TEXT,
      starting_balance REAL NOT NULL DEFAULT 0,
      ending_balance   REAL,
      total_pnl     REAL    NOT NULL DEFAULT 0,
      trade_count   INTEGER NOT NULL DEFAULT 0,
      min_position  REAL    NOT NULL DEFAULT 1,
      max_position  REAL    NOT NULL DEFAULT 20
    );

    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL,
      side          TEXT    NOT NULL,
      entry_price   REAL    NOT NULL,
      exit_price    REAL    NOT NULL,
      shares        REAL    NOT NULL,
      cost_basis    REAL    NOT NULL,
      proceeds      REAL    NOT NULL,
      pnl_usd       REAL    NOT NULL,
      pnl_percent   REAL    NOT NULL,
      exit_reason   TEXT    NOT NULL,
      created_at    TEXT    NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
}
function getDb() {
    return db;
}
function createSession(mode, startingBalance, minPosition, maxPosition) {
    const stmt = db.prepare(`INSERT INTO sessions (mode, started_at, starting_balance, min_position, max_position)
     VALUES (?, ?, ?, ?, ?)`);
    const result = stmt.run(mode, new Date().toISOString(), startingBalance, minPosition, maxPosition);
    return result.lastInsertRowid;
}
function updateSessionRange(id, minPos, maxPos) {
    db.prepare(`UPDATE sessions SET min_position = ?, max_position = ? WHERE id = ?`).run(minPos, maxPos, id);
}
function endSession(id, endingBalance, totalPnl, tradeCount) {
    db.prepare(`UPDATE sessions SET ended_at = ?, ending_balance = ?, total_pnl = ?, trade_count = ?
     WHERE id = ?`).run(new Date().toISOString(), endingBalance, totalPnl, tradeCount, id);
}
function recordTrade(sessionId, data) {
    db.prepare(`INSERT INTO trades (session_id, side, entry_price, exit_price, shares, cost_basis, proceeds, pnl_usd, pnl_percent, exit_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, data.side, data.entryPrice, data.exitPrice, data.shares, data.costBasis, data.proceeds, data.pnlUsd, data.pnlPercent, data.exitReason, new Date().toISOString());
}
function getSessionById(id) {
    return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}
function getSessions(limit = 50) {
    return db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT ?`).all(limit);
}
function getSessionTrades(sessionId) {
    return db.prepare(`SELECT * FROM trades WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
}
function getPnlTimeline(sessionId) {
    let rows;
    if (sessionId) {
        rows = db.prepare(`SELECT * FROM trades WHERE session_id = ? ORDER BY id ASC`).all(sessionId);
    }
    else {
        rows = db.prepare(`SELECT * FROM trades ORDER BY id ASC LIMIT 500`).all();
    }
    let cumulative = 0;
    return rows.map(r => {
        cumulative += r.pnl_usd;
        return { t: r.created_at, pnl: Math.round(cumulative * 100) / 100 };
    });
}
//# sourceMappingURL=db.js.map