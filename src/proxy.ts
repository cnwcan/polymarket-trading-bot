import type { Agent } from "http";

let _active = false;

export function setupProxy(proxyUrl: string): void {
  if (!proxyUrl || _active) return;
  _active = true;

  try {
    const axios = require("axios");
    const HttpsProxyAgent = require("https-proxy-agent");
    const agent = new HttpsProxyAgent(proxyUrl);

    axios.defaults.httpsAgent = agent;
    axios.defaults.proxy = false;

    console.error(`[Proxy] HTTPS proxy agent active → ${maskUrl(proxyUrl)}`);
  } catch (e) {
    console.error(`[Proxy] FATAL: failed to configure proxy agent: ${e}`);
    console.error(`[Proxy] CLOB API calls may be geo-blocked.`);
    return;
  }

  console.error(`[Proxy] CLOB API (clob.polymarket.com) → proxied`);
  console.error(`[Proxy] WebSocket / Binance / Gamma API: DIRECT`);
}

export function getPolymarketWsAgent(): Agent | undefined {
  return undefined;
}

export function getProxyUrl(): string | null {
  return null;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username && u.username.length > 4) {
      u.username = u.username.slice(0, 4) + "***";
    }
    return u.toString();
  } catch {
    return "***";
  }
}
