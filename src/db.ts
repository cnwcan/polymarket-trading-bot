import Database from "better-sqlite3";
import * as path from "path";

let db: Database.Database;

export function initDb(): void {
  const dbPath = path.join(process.cwd(), "sessions.db");
  db = new Database(dbPath);
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

export function getDb(): Database.Database {
  return db;
}

export interface SessionRow {
  id: number;
  mode: string;
  started_at: string;
  ended_at: string | null;
  starting_balance: number;
  ending_balance: number | null;
  total_pnl: number;
  trade_count: number;
  min_position: number;
  max_position: number;
}

export interface TradeRow {
  id: number;
  session_id: number;
  side: string;
  entry_price: number;
  exit_price: number;
  shares: number;
  cost_basis: number;
  proceeds: number;
  pnl_usd: number;
  pnl_percent: number;
  exit_reason: string;
  created_at: string;
}

export function createSession(
  mode: string,
  startingBalance: number,
  minPosition: number,
  maxPosition: number
): number {
  const stmt = db.prepare(
    `INSERT INTO sessions (mode, started_at, starting_balance, min_position, max_position)
     VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(mode, new Date().toISOString(), startingBalance, minPosition, maxPosition);
  return result.lastInsertRowid as number;
}

export function updateSessionRange(id: number, minPos: number, maxPos: number): void {
  db.prepare(`UPDATE sessions SET min_position = ?, max_position = ? WHERE id = ?`).run(minPos, maxPos, id);
}

export function endSession(
  id: number,
  endingBalance: number,
  totalPnl: number,
  tradeCount: number
): void {
  db.prepare(
    `UPDATE sessions SET ended_at = ?, ending_balance = ?, total_pnl = ?, trade_count = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), endingBalance, totalPnl, tradeCount, id);
}

export function recordTrade(
  sessionId: number,
  data: {
    side: string;
    entryPrice: number;
    exitPrice: number;
    shares: number;
    costBasis: number;
    proceeds: number;
    pnlUsd: number;
    pnlPercent: number;
    exitReason: string;
  }
): void {
  db.prepare(
    `INSERT INTO trades (session_id, side, entry_price, exit_price, shares, cost_basis, proceeds, pnl_usd, pnl_percent, exit_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, data.side, data.entryPrice, data.exitPrice, data.shares,
    data.costBasis, data.proceeds, data.pnlUsd, data.pnlPercent,
    data.exitReason, new Date().toISOString()
  );
}

export function getSessionById(id: number): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function getSessions(limit = 50): SessionRow[] {
  return db.prepare(
    `SELECT * FROM sessions ORDER BY id DESC LIMIT ?`
  ).all(limit) as SessionRow[];
}

export function getSessionTrades(sessionId: number): TradeRow[] {
  return db.prepare(
    `SELECT * FROM trades WHERE session_id = ? ORDER BY id ASC`
  ).all(sessionId) as TradeRow[];
}

export function getPnlTimeline(sessionId?: number): { t: string; pnl: number }[] {
  let rows: TradeRow[];
  if (sessionId) {
    rows = db.prepare(
      `SELECT * FROM trades WHERE session_id = ? ORDER BY id ASC`
    ).all(sessionId) as TradeRow[];
  } else {
    rows = db.prepare(
      `SELECT * FROM trades ORDER BY id ASC LIMIT 500`
    ).all() as TradeRow[];
  }
  let cumulative = 0;
  return rows.map(r => {
    cumulative += r.pnl_usd;
    return { t: r.created_at, pnl: Math.round(cumulative * 100) / 100 };
  });
}
