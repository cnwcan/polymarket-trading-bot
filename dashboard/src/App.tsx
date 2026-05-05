import { useState, useEffect, useCallback, createContext, useContext, useRef, useMemo } from "react";
import type { StatusData } from "./api";
import { fetchStatus, postControl } from "./api";
import DashboardView from "./views/DashboardView";
import HistoryView from "./views/HistoryView";
import LogsView from "./views/LogsView";

type ToastType = "ok" | "err" | "info";
interface Toast { id: number; msg: string; type: ToastType }
const ToastCtx = createContext<(msg: string, type?: ToastType) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

type Tab = "dashboard" | "history" | "logs";

function getTheme(): "dark" | "light" {
  const s = localStorage.getItem("ui_theme");
  if (s === "light" || s === "dark") return s;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [theme, setTheme] = useState(getTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [status, setStatus] = useState<StatusData | null>(null);

  const addToast = useCallback((msg: string, type: ToastType = "info") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3200);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ui_theme", theme);
  }, [theme]);

  useEffect(() => {
    const load = () => fetchStatus().then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  const ctrl = useCallback(async (body: Record<string, unknown>) => {
    try {
      const data = await postControl(body);
      if (data.ok) addToast(data.message || "Done", "ok");
      else addToast(data.error || "Error", "err");
    } catch { addToast("Network error", "err"); }
  }, [addToast]);

  const s = status;

  const sessionActive = Boolean(s?.running && s.activeSessionId != null);
  const [sessionTick, setSessionTick] = useState(0);

  useEffect(() => {
    if (!sessionActive || !s?.sessionStartedAt) return;
    const id = window.setInterval(() => setSessionTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [sessionActive, s?.sessionStartedAt]);

  const sessionElapsedSec = useMemo(() => {
    if (!sessionActive || !s?.sessionStartedAt) return 0;
    const started = Date.parse(s.sessionStartedAt);
    if (Number.isNaN(started)) return 0;
    return Math.max(0, Math.floor((Date.now() - started) / 1000));
  }, [sessionActive, s?.sessionStartedAt, sessionTick]);

  return (
    <ToastCtx.Provider value={addToast}>
      <div className="shell">
        <nav className="app-navbar" aria-label="Primary">
          <div className="app-navbar-inner">
            <div className="header">
              <div className="logo">Poly<span>Scalper</span></div>
              <span className={`pill ${s?.running ? "on" : "off"}`}>
                <span className="dot" />
                {s?.running ? (
                  <span className="pill-inner">
                    <span className="pill-label">Running</span>
                    {sessionActive && s?.sessionStartedAt && (
                      <>
                        <span className="pill-sep" aria-hidden="true">|</span>
                        <span className="pill-timer mono" title="Session duration">{fmtSessionDuration(sessionElapsedSec)}</span>
                      </>
                    )}
                  </span>
                ) : (
                  "Stopped"
                )}
              </span>
              <span className={`chip ${s?.mode === "SIMULATION" ? "sim" : "prod"}`}>
                {s?.mode === "SIMULATION" ? "SIM" : "PROD"}
              </span>
              <div className="hdr-right">
                <button className="icon-btn" onClick={() => { setTheme(t => t === "dark" ? "light" : "dark"); addToast("Theme updated", "info"); }} title="Toggle theme">
                  {theme === "dark" ? "☾" : "☀"}
                </button>
              </div>
            </div>

            <div className="tabs" role="tablist" aria-label="Main navigation">
              {(["dashboard", "history", "logs"] as Tab[]).map(t => {
                const label = t.charAt(0).toUpperCase() + t.slice(1);
                const selected = tab === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`tab${selected ? " active" : ""}`}
                    onClick={() => setTab(t)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Controls + open position directly under ops bar */}
        {tab === "dashboard" && <ControlsDropdown status={s} ctrl={ctrl} />}
        {tab === "dashboard" && s?.openPosition && <OpenPositionCard position={s.openPosition} />}

        {/* Views */}
        {tab === "dashboard" && <DashboardView status={s} />}
        {tab === "history" && <HistoryView />}
        {tab === "logs" && <LogsView />}
      </div>

      {/* Toasts */}
      <div className="toast-rack">
        {toasts.map(t => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

function ControlsDropdown({ status, ctrl }: { status: StatusData | null; ctrl: (b: Record<string, unknown>) => void }) {
  const [minVal, setMinVal] = useState("1");
  const [maxVal, setMaxVal] = useState("20");
  const [autoOn, setAutoOn] = useState(false);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!status) return;
    if (document.activeElement?.tagName !== "INPUT") {
      setMinVal(String(status.minPositionUsdc));
      setMaxVal(String(status.maxPositionUsdc));
    }
    setAutoOn(status.autoScale);
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const applyRange = () => {
    const lo = parseInt(minVal) || 1;
    const hi = parseInt(maxVal) || 20;
    ctrl({ action: "set-range", minPos: Math.max(1, Math.min(lo, hi)), maxPos: Math.max(Math.max(lo, hi), 1) });
  };

  const clamp = (setter: (v: string) => void) => (e: React.FocusEvent<HTMLInputElement>) => {
    let v = parseInt(e.target.value) || 1;
    if (v < 1) v = 1;
    if (v > 100) v = 100;
    setter(String(v));
  };

  const runningTxt = status?.running ? "Running" : "Stopped";
  const modeTxt = status?.mode === "SIMULATION" ? "SIM" : "PROD";
  const eff = status ? `${status.effectiveMin}-${status.effectiveMax}` : "--";
  const range = status ? `${status.minPositionUsdc}-${status.maxPositionUsdc}` : "--";
  const phaseTxt = status ? (status.running ? status.phase : "STOPPED") : "--";
  const phaseCls = (() => {
    if (!status || !status.running) return "phase ph-stopped";
    const k = String(status.phase || "").toLowerCase();
    if (k === "idle") return "phase ph-idle";
    if (k === "inposition") return "phase ph-inposition";
    return "phase ph-cooldown";
  })();

  return (
    <div className="ops">
      <div className="opsbar">
        <div className="ops-left">
          <div className="ops-kv">
            <div className="ops-k">Engine</div>
            <div className="ops-v">{runningTxt}</div>
          </div>
          <div className="ops-kv">
            <div className="ops-k">Mode</div>
            <div className="ops-v">{modeTxt}</div>
          </div>
          <div className="ops-kv">
            <div className="ops-k">Range</div>
            <div className="ops-v">${range}</div>
          </div>
          <div className="ops-kv">
            <div className="ops-k">Effective</div>
            <div className="ops-v">${eff}</div>
          </div>
          <div className="ops-kv">
            <div className="ops-k">Auto</div>
            <div className={`ops-v ${autoOn ? "ops-on" : ""}`}>{autoOn ? "ON" : "OFF"}</div>
          </div>
          <div className="ops-kv">
            <div className="ops-k">Phase</div>
            <div className="ops-v"><span className={phaseCls}>{phaseTxt}</span></div>
          </div>
        </div>
        <div className="ops-right">
          <button className="btn btn-mode" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            Controls {open ? "▴" : "▾"}
          </button>
        </div>
      </div>

      {open && <div className="ops-backdrop" />}

      {open && (
        <div
          className="ops-panel ops-modal"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Operations controls"
        >
          <div className="ops-panel-head">
            <div>
              <div className="ops-title">Operations</div>
              <div className="ops-sub">Trade range, mode, and engine</div>
            </div>
            <button className="icon-btn" onClick={() => setOpen(false)} title="Close">✕</button>
          </div>

          <div className="ops-grid ops-grid--modal">
            <section className="ops-section">
              <div className="ops-section-title">Trade range ($)</div>
              <div className="ops-row ops-row--range">
                <input className="range-input range-input--grow" type="number" value={minVal} onChange={e => setMinVal(e.target.value)} onBlur={clamp(setMinVal)} aria-label="Minimum USDC" />
                <span className="range-dash" aria-hidden="true">&mdash;</span>
                <input className="range-input range-input--grow" type="number" value={maxVal} onChange={e => setMaxVal(e.target.value)} onBlur={clamp(setMaxVal)} aria-label="Maximum USDC" />
                <button type="button" className="btn-apply btn-apply--range" onClick={applyRange}>Apply</button>
              </div>
            </section>

            <section className="ops-section">
              <div className="ops-section-title">Mode</div>
              <div className="ops-row ops-row--split">
                <button type="button" className={`btn btn-mode btn-mode--block${status?.mode === "SIMULATION" ? " active" : ""}`} onClick={() => ctrl({ action: "set-mode", mode: "simulation" })}>Sim</button>
                <button type="button" className={`btn btn-mode btn-mode--block${status?.mode !== "SIMULATION" ? " active" : ""}`} onClick={() => { if (confirm("Switch to PRODUCTION? Real orders will be placed.")) ctrl({ action: "set-mode", mode: "production" }); }}>Prod</button>
              </div>
            </section>

            <section className="ops-section">
              <div className="ops-section-title">Engine</div>
              <div className="ops-row ops-row--split">
                <button type="button" className="btn btn-go btn-engine" disabled={status?.running} onClick={() => ctrl({ action: "start" })}>Start</button>
                <button type="button" className="btn btn-stop btn-engine" disabled={!status?.running} onClick={() => ctrl({ action: "stop" })}>Stop</button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtHeld(sec: number) {
  if (sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  const parts: string[] = [];
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

function OpenPositionCard({ position }: { position: NonNullable<StatusData["openPosition"]> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [position.entryTime]);
  const heldSec = Math.floor(Date.now() / 1000) - position.entryTime;
  const cost = position.shares * position.entryPrice;
  return (
    <div className="pos-card">
      <div className="pos-head">Open Position</div>
      <div className="pos-grid">
        <div><div className="pos-lbl">Side</div><div className="pos-val">{position.side}</div></div>
        <div><div className="pos-lbl">Entry</div><div className="pos-val">${position.entryPrice.toFixed(4)}</div></div>
        <div><div className="pos-lbl">Shares</div><div className="pos-val">{position.shares}</div></div>
        <div><div className="pos-lbl">Cost</div><div className="pos-val">${cost.toFixed(2)}</div></div>
        <div><div className="pos-lbl">Held</div><div className="pos-val">{fmtHeld(heldSec)}</div></div>
      </div>
    </div>
  );
}

/** Elapsed time since session row was created (SIM or PROD). */
function fmtSessionDuration(sec: number): string {
  if (sec < 0) sec = 0;
  let rest = sec;
  const d = Math.floor(rest / 86400);
  rest %= 86400;
  const h = Math.floor(rest / 3600);
  rest %= 3600;
  const m = Math.floor(rest / 60);
  const s = rest % 60;
  const parts: string[] = [];
  if (d) parts.push(d + "d");
  if (h) parts.push(h + "h");
  if (m) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

