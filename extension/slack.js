// Slack web API client. Requests carry the browser's existing Slack session cookie.

const TOKEN_RE = /"api_token":"(xoxc-[0-9A-Za-z-]+)"/;
const TOKEN_PAGES = ["/ssb/redirect", "/customize/emoji"];
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired"]);

export class SlackError extends Error {
  constructor(method, code) {
    super(`${method}: ${code}`);
    this.method = method;
    this.code = code;
  }
}

export function workspaceUrl(workspace) {
  const w = workspace.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://${w.endsWith(".slack.com") ? w : `${w}.slack.com`}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient(workspace) {
  const base = workspaceUrl(workspace);
  let token;

  async function fetchToken() {
    let reached = false;
    for (const path of TOKEN_PAGES) {
      let res;
      try {
        res = await fetch(base + path, { credentials: "include", cache: "no-store" });
      } catch {
        continue;
      }
      reached = true;
      if (!res.ok) continue;
      const match = TOKEN_RE.exec(await res.text());
      if (match) return match[1];
    }
    throw new SlackError("login", reached ? "not_authed" : "network");
  }

  async function post(method, args) {
    let res;
    try {
      res = await fetch(`${base}/api/${method}`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        body: new URLSearchParams({ ...args, token }),
      });
    } catch {
      throw new SlackError(method, "network");
    }
    return res;
  }

  async function api(method, args = {}) {
    for (let attempt = 0; ; attempt += 1) {
      token ??= await fetchToken();
      const res = await post(method, args);
      if (res.status === 429 && attempt === 0) {
        await sleep(Math.min(Number(res.headers.get("Retry-After")) || 2, 30) * 1000);
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new SlackError(method, `http_${res.status}`);
      }
      if (data.ok) return data;
      if (attempt === 0 && AUTH_ERRORS.has(data.error)) {
        token = undefined;
        continue;
      }
      throw new SlackError(method, data.error || "unknown_error");
    }
  }

  return { base, api };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
