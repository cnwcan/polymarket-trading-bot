export interface StatusData {
  mode: "SIMULATION" | "PRODUCTION";
  running: boolean;
  uptimeSeconds: number;
  asset: string;
  btcPrice: number;
  phase: string;
  currentMarket: string | null;
  periodRemainingSec: number;
  /** ISO timestamp when the current DB session row was created; null if no active session. */
  sessionStartedAt: string | null;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  startingBalance: number;
  currentBalance: number;
  totalProfit: number;
  dailyProfit: number;
  dailyLoss: number;
  tradeCount: number;
  openPosition: { side: string; entryPrice: number; shares: number; entryTime: number } | null;
  minPositionUsdc: number;
  maxPositionUsdc: number;
  autoScale: boolean;
  autoScaleBaseMin: number;
  autoScaleBaseMax: number;
  effectiveMin: number;
  effectiveMax: number;
  activeSessionId: number | null;
}

export interface Trade {
  tsExitIso?: string;
  side?: string;
  entryPrice?: number;
  exitBid?: number;
  costBasis?: number;
  proceeds?: number;
  grossPnlUsd?: number;
  grossPnlPercent?: number;
  exitReason?: string;
  balanceAfter?: number;
}

export interface Session {
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

export interface SessionTrade {
  id: number;
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

export interface PnlPoint {
  t: string;
  pnl: number;
}

export async function fetchStatus(): Promise<StatusData> {
  const r = await fetch("/api/status");
  return r.json();
}

export async function fetchTrades(): Promise<Trade[]> {
  const r = await fetch("/api/trades");
  return r.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  return r.json();
}

export async function fetchSessionTrades(id: number): Promise<SessionTrade[]> {
  const r = await fetch(`/api/sessions/${id}/trades`);
  return r.json();
}

export async function fetchPnlChart(sessionId?: number): Promise<PnlPoint[]> {
  const url = sessionId ? `/api/pnl-chart?session=${sessionId}` : "/api/pnl-chart";
  const r = await fetch(url);
  return r.json();
}

export async function fetchLogs(): Promise<string[]> {
  const r = await fetch("/api/logs");
  return r.json();
}

export async function postControl(body: Record<string, unknown>): Promise<{ ok?: boolean; message?: string; error?: string }> {
  const r = await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}
