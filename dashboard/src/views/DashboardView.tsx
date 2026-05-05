import { useState, useEffect, useRef, useMemo } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement,
  Filler, Tooltip,
} from "chart.js";
import type { StatusData, Trade, PnlPoint, SessionTrade } from "../api";
import { fetchPnlChart, fetchSessionTrades } from "../api";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

function money(v: number) { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function cls(v: number) { return v >= 0 ? "positive" : "negative"; }
function fmtSec(sec: number) {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + "m " + s + "s";
}
function tradeRowClass(pnl: number) {
  if (pnl > 0) return "tbl-row--win";
  if (pnl < 0) return "tbl-row--loss";
  return "tbl-row--flat";
}
function tradeSideCellClass(side: string | undefined) {
  const base = "tbl-cell-side";
  if (!side) return base;
  const s = side.toLowerCase();
  if (s === "up") return `${base} tbl-cell-side--up`;
  if (s === "down") return `${base} tbl-cell-side--down`;
  return base;
}

const istTime = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export default function DashboardView({ status: s }: { status: StatusData | null }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [pnl, setPnl] = useState<PnlPoint[]>([]);
  const chartRef = useRef<ChartJS<"line"> | null>(null);

  useEffect(() => {
    // Clear UI immediately when stopping.
    if (s && !s.running) {
      setTrades([]);
      setPnl([]);
    }
  }, [s?.running]);

  useEffect(() => {
    // Only poll while bot is running, so Stop keeps UI empty.
    if (!s?.running || !s.activeSessionId) return;

    const load = () => {
      fetchSessionTrades(s.activeSessionId!)
        .then((rows: SessionTrade[]) => {
          let cumulative = 0;
          const mappedAll: Trade[] = rows.map(r => {
            cumulative += r.pnl_usd;
            return {
              tsExitIso: r.created_at,
              side: r.side,
              entryPrice: r.entry_price,
              exitBid: r.exit_price,
              costBasis: r.cost_basis,
              proceeds: r.proceeds,
              grossPnlUsd: r.pnl_usd,
              grossPnlPercent: r.pnl_percent,
              exitReason: r.exit_reason,
              balanceAfter: s.startingBalance + cumulative,
            };
          });
          setTrades(mappedAll);
        })
        .catch(() => {});

      fetchPnlChart(s.activeSessionId!).then(setPnl).catch(() => {});
    };
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [s?.running]);

  const view = useMemo(() => {
    if (!s) return null;
    if (!s.running) {
      return {
        ...s,
        phase: "STOPPED",
        totalProfit: 0,
        dailyProfit: 0,
        dailyLoss: 0,
        tradeCount: 0,
        currentBalance: s.startingBalance,
      };
    }

    // Session-scoped display values derived from session DB data (stable, no flicker).
    const sessionTotal = pnl.length ? pnl[pnl.length - 1].pnl : 0;
    const sessionDailyProfit = trades.reduce((acc, t) => acc + Math.max(0, t.grossPnlUsd ?? 0), 0);
    const sessionDailyLoss = trades.reduce((acc, t) => acc + Math.max(0, -(t.grossPnlUsd ?? 0)), 0);
    const sessionTrades = trades.length;

    return {
      ...s,
      totalProfit: sessionTotal,
      dailyProfit: sessionDailyProfit,
      dailyLoss: sessionDailyLoss,
      tradeCount: sessionTrades,
      currentBalance: s.startingBalance + sessionTotal,
    };
  }, [s, pnl, trades]);

  if (!view) return <div className="empty-msg">Connecting...</div>;

  const last = pnl.length ? pnl[pnl.length - 1].pnl : 0;
  const lineColor = last >= 0 ? "#10b981" : "#ef4444";
  const fillColor = last >= 0 ? "rgba(16,185,129,.06)" : "rgba(239,68,68,.06)";

  const chartData = {
    labels: pnl.map(p => p.t),
    datasets: [{
      data: pnl.map(p => p.pnl),
      borderColor: lineColor, backgroundColor: fillColor,
      borderWidth: 2, fill: true, tension: .35, pointRadius: 0,
    }],
  };
  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    layout: { padding: { bottom: 4 } },
    plugins: { legend: { display: false }, tooltip: { enabled: true, mode: "nearest" as const, intersect: false } },
    scales: {
      x: { display: false },
      y: {
        grid: { color: "rgba(39,39,42,.2)", drawBorder: false },
        ticks: { color: "#71717a", font: { size: 10, family: "JetBrains Mono" }, callback: (v: unknown) => "$" + v, maxTicksLimit: 6 },
        border: { display: false },
      },
    },
  };

  const rev = trades.slice().reverse();
  const wins = trades.filter(t => (t.grossPnlUsd ?? 0) > 0).length;
  const losses = trades.filter(t => (t.grossPnlUsd ?? 0) < 0).length;
  const lastTradePnl = trades.length ? (trades[trades.length - 1].grossPnlUsd ?? 0) : null;

  return (
    <div className="fade-in">
      {/* Balance */}
      <div className="bal-row">
        <div className="bal-card start">
          <div className="bal-label">Starting Balance</div>
          <div className="bal-value" style={{ color: "var(--text2)" }}>${view.startingBalance.toFixed(2)}</div>
        </div>
        <div className={`bal-card ${view.currentBalance >= view.startingBalance ? "up" : "down"}`}>
          <div className="bal-head">
            <div className="bal-label">Current Balance</div>
            <div className={`bal-last ${lastTradePnl == null ? "" : (lastTradePnl >= 0 ? "positive" : "negative")}`}>
              {lastTradePnl == null ? "" : `Last: ${money(lastTradePnl)}`}
            </div>
          </div>
          <div className={`bal-value ${view.currentBalance >= view.startingBalance ? "positive" : "negative"}`}>
            ${view.currentBalance.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Metrics: row 1 = market / period; row 2 = P&L + trades */}
      <div className="metrics">
        <div className="metrics-row">
          <Metric label="BTC / USDT" value={"$" + view.btcPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} />
          <Metric label="Up (Bid / Ask)" value={view.upBid.toFixed(2) + " / " + view.upAsk.toFixed(2)} />
          <Metric label="Down (Bid / Ask)" value={view.downBid.toFixed(2) + " / " + view.downAsk.toFixed(2)} />
          <Metric label="Period Left" value={fmtSec(view.periodRemainingSec)} />
        </div>
        <div className="metrics-row">
          <Metric label="Total P&L" value={money(view.totalProfit)} cls={cls(view.totalProfit)} />
          <Metric label="Daily Profit" value={"+" + "$" + view.dailyProfit.toFixed(2)} cls="positive" />
          <Metric label="Daily Loss" value={"-$" + view.dailyLoss.toFixed(2)} cls="negative" />
          <div className="metric">
            <div className="m-label">Trades</div>
            <div className="m-val m-val--trades">
              <span className="m-val-total">{String(view.tradeCount)}</span>
              <span className="m-val-wl" title="Wins / losses">
                <span className="positive">{view.running ? wins : 0}</span>
                <span className="m-val-slash">/</span>
                <span className="negative">{view.running ? losses : 0}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="chart-box">
        <div className="chart-title">Cumulative P&amp;L</div>
        <div className="chart-inner">
          <Line ref={chartRef} data={chartData} options={chartOpts} />
        </div>
      </div>

      {/* Recent Trades */}
      <div className="tbl-box tbl-box--trades">
        <div className="tbl-head">
          <span className="tbl-head-title">Recent Trades</span>
          {rev.length > 0 && <span className="tbl-count">{rev.length} trades</span>}
        </div>
        {!rev.length ? (
          <div className="empty-msg tbl-empty">No trades yet</div>
        ) : (
          <div className="tbl-scroll tbl-scroll--trades">
            <table className="tbl-data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Cost</th>
                  <th>Proceeds</th>
                  <th>P&amp;L</th>
                  <th>Reason</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rev.map((t, i) => {
                  const pnlV = t.grossPnlUsd ?? 0;
                  const pctV = t.grossPnlPercent ?? 0;
                  const time = t.tsExitIso ? istTime.format(new Date(t.tsExitIso)) : "--";
                  const cost = t.costBasis ?? null;
                  const proceeds = t.proceeds ?? null;
                  const balAfter = t.balanceAfter ?? null;
                  return (
                    <tr key={i} className={tradeRowClass(pnlV)}>
                      <td className="tbl-cell-time">{time}</td>
                      <td className={tradeSideCellClass(t.side)}>{t.side || "—"}</td>
                      <td>${t.entryPrice?.toFixed(4) ?? "--"}</td>
                      <td>${t.exitBid?.toFixed(4) ?? "--"}</td>
                      <td>{cost == null ? "—" : "$" + cost.toFixed(2)}</td>
                      <td>{proceeds == null ? "—" : "$" + proceeds.toFixed(2)}</td>
                      <td className={`tbl-cell-pnl ${cls(pnlV)}`}>
                        <span className="tbl-pnl-val">{money(pnlV)}</span>
                        <span className="tbl-pnl-pct">{pctV >= 0 ? "+" : ""}{pctV.toFixed(1)}%</span>
                      </td>
                      <td className="tbl-cell-reason">{t.exitReason || "—"}</td>
                      <td>{balAfter == null ? "—" : "$" + balAfter.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, cls: c }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="metric">
      <div className="m-label">{label}</div>
      <div className={`m-val${c ? " " + c : ""}`}>{value}</div>
      {sub && <div className="m-sub">{sub}</div>}
    </div>
  );
}
