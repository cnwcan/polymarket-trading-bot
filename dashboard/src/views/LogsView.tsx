import { useState, useEffect, useRef } from "react";
import { fetchLogs } from "../api";
import { useToast } from "../App";

const istTime = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function LogsView() {
  const [lines, setLines] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const toast = useToast();

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchLogs();
        if (data.length !== lastCount.current) {
          lastCount.current = data.length;
          setLines(data);
        }
      } catch { /* ignore */ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (auto && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, auto]);

  const clear = () => { setLines([]); lastCount.current = 0; toast("Logs cleared (display only)", "info"); };

  return (
    <div className="log-box fade-in">
      <div className="log-bar">
        <span className="ctrl-label">Live Logs</span>
        <label className="log-check">
          <input
            type="checkbox"
            className="log-check-input"
            checked={auto}
            onChange={e => setAuto(e.target.checked)}
          />
          <span className="log-check-box" aria-hidden="true" />
          <span className="log-check-text">Auto-scroll</span>
        </label>
        <button className="btn" style={{ fontSize: ".56rem", padding: "3px 8px" }} onClick={clear}>Clear</button>
      </div>
      <div className="log-scroll" ref={scrollRef}>
        {lines.map((line, i) => {
          const spIdx = line.indexOf(" ");
          const ts = spIdx > 0 ? line.slice(0, spIdx) : "";
          const msg = spIdx > 0 ? line.slice(spIdx + 1) : line;
          let tsOut = "";
          if (ts) { const dt = new Date(ts); tsOut = isNaN(dt.getTime()) ? ts : istTime.format(dt); }
          let colorCls = "";
          if (msg.includes("ENTRY SIGNAL") || msg.includes("BUY")) colorCls = "c-entry";
          else if (msg.includes("SELL") || msg.includes("EXIT") || msg.includes("exit")) colorCls = "c-exit";
          else if (msg.includes("FAIL") || msg.includes("Error") || msg.includes("error")) colorCls = "c-err";
          else if (msg.includes("[Status]")) colorCls = "c-status";
          return (
            <div key={i} className="log-line">
              <span className="ts">{tsOut}</span>{" "}
              <span className={colorCls} dangerouslySetInnerHTML={{ __html: esc(msg) }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
