import { useState, useEffect, useCallback, useMemo } from "react";
import type { Session, SessionTrade } from "../api";
import { fetchSessions, fetchSessionTrades } from "../api";

function money(v: number) { return (v >= 0 ? "+" : "") + "$" + v.toFixed(2); }
function cls(v: number) { return v >= 0 ? "positive" : "negative"; }

const istTime = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const sessionDateFmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function fmtDurationSec(totalSec: number): string {
  if (totalSec < 0) totalSec = 0;
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

export default function HistoryView() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [trades, setTrades] = useState<Record<number, SessionTrade[]>>({});

  useEffect(() => { fetchSessions().then(setSessions).catch(() => {}); }, []);

  const toggle = useCallback(async (id: number) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!trades[id]) {
      try {
        const t = await fetchSessionTrades(id);
        setTrades(prev => ({ ...prev, [id]: t }));
      } catch { /* ignore */ }
    }
  }, [openId, trades]);

  const onCardKey = useCallback((e: React.KeyboardEvent, id: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void toggle(id);
    }
  }, [toggle]);

  const sorted = useMemo(() => [...sessions].sort((a, b) => b.id - a.id), [sessions]);

  if (!sessions.length) {
    return (
      <div className="hist-empty fade-in">
        <div className="hist-empty-title">No sessions yet</div>
        <p className="hist-empty-hint">Start the engine from the dashboard; completed runs appear here with P&amp;L and trades.</p>
      </div>
    );
  }

  return (
    <div className="hist-root fade-in">
      <p className="hist-lead">Past runs (newest first). Expand a row to load trades.</p>
      <div className="hist-list">
        {sorted.map(s => {
          const isOpen = openId === s.id;
          const isSim = s.mode === "simulation";
          const startedAt = new Date(s.started_at);
          const endedAt = s.ended_at ? new Date(s.ended_at) : null;
          const isActive = !endedAt;
          const durationSec = endedAt
            ? Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
            : null;
          const pnl = s.total_pnl ?? 0;
          const st = trades[s.id];
          const tc = s.trade_count ?? 0;

          return (
            <div
              key={s.id}
              className={`sess-card${isOpen ? " open" : ""}`}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => { void toggle(s.id); }}
              onKeyDown={e => onCardKey(e, s.id)}
            >
              <div className="sess-card-head">
                <div className="sess-badges">
                  <span className={`sess-chip${isSim ? " sess-chip--sim" : " sess-chip--prod"}`}>
                    {isSim ? "Simulation" : "Production"}
                  </span>
                  <span className="sess-num">#{s.id}</span>
                </div>
                <div className="sess-head-right">
                  <span className={`sess-pill${isActive ? " sess-pill--live" : " sess-pill--done"}`}>
                    {isActive ? "Open" : "Closed"}
                  </span>
                  <span className="sess-chevron" aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
                </div>
              </div>

              <div className="sess-body">
                <div className="sess-meta">
                  <div className="sess-meta-row">
                    <span className="sess-meta-k">Started</span>
                    <span className="sess-meta-v">{sessionDateFmt.format(startedAt)}</span>
                  </div>
                  <div className="sess-meta-row">
                    <span className="sess-meta-k">{endedAt ? "Ended" : "Status"}</span>
                    <span className="sess-meta-v">
                      {endedAt ? sessionDateFmt.format(endedAt) : "Still running"}
                    </span>
                  </div>
                  {durationSec != null && (
                    <div className="sess-duration">
                      <span className="sess-duration-label">Duration</span>
                      <span className="sess-duration-val">{fmtDurationSec(durationSec)}</span>
                    </div>
                  )}
                </div>

                <div className="sess-metrics" aria-label="Session stats">
                  <div className="sess-metric">
                    <span className="sess-metric-k">P&amp;L</span>
                    <span className={`sess-metric-v ${cls(pnl)}`}>{money(pnl)}</span>
                  </div>
                  <div className="sess-metric">
                    <span className="sess-metric-k">Trades</span>
                    <span className="sess-metric-v">{tc}</span>
                  </div>
                  <div className="sess-metric">
                    <span className="sess-metric-k">Size range</span>
                    <span className="sess-metric-v">${s.min_position} – ${s.max_position}</span>
                  </div>
                </div>
              </div>

              {isOpen && (
                <div className="sess-inner" onClick={e => e.stopPropagation()}>
                  <div className="sess-inner-head">Trades in this session</div>
                  {!st ? (
                    <div className="empty-msg sess-loading">Loading…</div>
                  ) : !st.length ? (
                    <div className="empty-msg sess-loading">No trades in this session.</div>
                  ) : (
                    <div className="tbl-scroll">
                      <table className="tbl-data">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Side</th>
                            <th>Entry</th>
                            <th>Exit</th>
                            <th>P&amp;L</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {st.map(t => (
                            <tr key={t.id}>
                              <td>{istTime.format(new Date(t.created_at))}</td>
                              <td>{t.side}</td>
                              <td>${t.entry_price.toFixed(4)}</td>
                              <td>${t.exit_price.toFixed(4)}</td>
                              <td className={cls(t.pnl_usd)}>
                                {money(t.pnl_usd)} ({t.pnl_percent >= 0 ? "+" : ""}{t.pnl_percent.toFixed(1)}%)
                              </td>
                              <td>{t.exit_reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
