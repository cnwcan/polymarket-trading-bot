import * as fs from "fs";

let historyStream: fs.WriteStream | null = null;
const LOG_RING_MAX = 500;
const logRing: string[] = [];

export function initHistoryLog(path: string = "history.toml"): void {
  if (historyStream) return;
  historyStream = fs.createWriteStream(path, { flags: "a" });
}

export function getLogRing(): string[] {
  return logRing;
}

export function logToHistory(message: string): void {
  process.stderr.write(message);
  if (historyStream) {
    historyStream.write(message);
    historyStream.emit("drain");
  }
}

export function logPrintln(...args: unknown[]): void {
  const message = args.map(String).join(" ");
  const trimmed = message.trim();
  if (trimmed.length > 0) {
    logRing.push(new Date().toISOString() + " " + trimmed);
    if (logRing.length > LOG_RING_MAX) logRing.splice(0, logRing.length - LOG_RING_MAX);
  }
  logToHistory(message + "\n");
}
