import { HISTORY_LIMIT } from "./config.js";
import { mapLimit } from "./slack.js";

const SKIP_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave"]);
const USER_REF = /<@([UW][A-Z0-9]+)/g;
const SAVED_PAGES = 5;
const MUTED_TTL_MS = 10 * 60_000;

const newer = (a, b) => Number(a) > Number(b);

function messageText(m) {
  if (m.text) return m.text;
  const attachment = (m.attachments || [])[0];
  if (attachment) return attachment.fallback || attachment.title || attachment.text || "";
  if (m.files?.length) return m.files.map((f) => `File: ${f.title || f.name}`).join("\n");
  return "";
}

export function createStore(client) {
  const cacheKey = `si.cache.${client.base}`;
  const today = new Date().toDateString();
  const names = loadNames();
  const pending = new Map();
  const convRows = new Map();
  const savedMessages = new Map();
  let selfPromise;
  let muted = new Set();
  let mutedAt = 0;

  function loadNames() {
    try {
      const stored = JSON.parse(localStorage.getItem(cacheKey));
      if (stored?.day === today) return stored;
    } catch {
      // Unreadable cache is rebuilt.
    }
    return { day: today, users: {}, convs: {} };
  }

  function saveNames() {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(names));
    } catch {
      // The cache is optional.
    }
  }

  function once(key, load) {
    if (!pending.has(key)) pending.set(key, load().finally(() => pending.delete(key)));
    return pending.get(key);
  }

  function self() {
    selfPromise ??= client
      .api("auth.test")
      .then((d) => ({ team: d.team_id, user: d.user_id, teamName: d.team }))
      .catch((e) => {
        selfPromise = undefined;
        throw e;
      });
    return selfPromise;
  }

  function userName(id) {
    if (names.users[id]) return Promise.resolve(names.users[id]);
    return once(`u:${id}`, () =>
      client
        .api("users.info", { user: id })
        .then((d) => {
          const u = d.user || {};
          const name = u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || id;
          names.users[id] = name;
          saveNames();
          return name;
        })
        .catch(() => id),
    );
  }

  function convInfo(id) {
    if (names.convs[id]) return Promise.resolve(names.convs[id]);
    return once(`c:${id}`, async () => {
      let info;
      try {
        const c = (await client.api("conversations.info", { channel: id })).channel || {};
        if (c.is_im) {
          info = { kind: "dm", label: "Direct message", person: await userName(c.user) };
        } else if (c.is_mpim) {
          const members = (c.name || "").replace(/^mpdm-/, "").replace(/-\d+$/, "").split("--");
          info = { kind: "group", label: members.join(", ") };
        } else {
          info = { kind: "channel", label: `#${c.name || id}` };
        }
        info.hidden = Boolean(c.is_archived) || c.is_member === false;
      } catch {
        return { kind: "channel", label: id };
      }
      names.convs[id] = info;
      saveNames();
      return info;
    });
  }

  async function author(m) {
    if (m.username) return m.username;
    if (m.user) return userName(m.user);
    return m.bot_profile?.name || "Unknown";
  }

  async function normalize(raw) {
    const mentioned = new Set();
    for (const m of raw) {
      for (const [, id] of (m.text || "").matchAll(USER_REF)) mentioned.add(id);
    }
    await mapLimit([...mentioned], 4, userName);
    return Promise.all(
      raw.map(async (m) => ({
        ts: m.ts,
        thread_ts: m.thread_ts,
        name: await author(m),
        text: messageText(m),
      })),
    );
  }

  function who(messages) {
    const seen = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (!seen.includes(messages[i].name)) seen.push(messages[i].name);
    }
    return seen.length > 3 ? `${seen.slice(0, 3).join(", ")} +${seen.length - 3}` : seen.join(", ");
  }

  async function mutedChannels() {
    if (Date.now() - mutedAt < MUTED_TTL_MS) return muted;
    try {
      const prefs = (await client.api("users.prefs.get")).prefs || {};
      const next = new Set();
      for (const id of (prefs.muted_channels || "").split(",")) if (id) next.add(id);
      const all = JSON.parse(prefs.all_notifications_prefs || "{}");
      for (const [id, p] of Object.entries(all.channels || {})) if (p?.muted) next.add(id);
      muted = next;
      mutedAt = Date.now();
    } catch {
      // Without prefs, muted channels are listed like any other.
    }
    return muted;
  }

  async function convRow(c) {
    const sig = `${c.last_read}:${c.latest}:${c.mention_count}`;
    const cached = convRows.get(c.id);
    if (cached?.sig === sig) return cached.row;

    const info = await convInfo(c.id);
    let row = null;
    let unread = [];
    let more = false;
    if (!info.hidden) {
      const lastRead = c.last_read || "0";
      const fetched = (await client.api("conversations.history", { channel: c.id, limit: String(HISTORY_LIMIT) })).messages || [];
      const fresh = fetched.filter((m) => newer(m.ts, lastRead));
      more = fetched.length === HISTORY_LIMIT && fresh.length === fetched.length;
      unread = fresh.filter((m) => !SKIP_SUBTYPES.has(m.subtype)).sort((a, b) => Number(a.ts) - Number(b.ts));
    }
    if (unread.length > 0) {
      const messages = await normalize(unread);
      const latest = messages[messages.length - 1];
      row = {
        key: `c:${c.id}`,
        kind: info.kind,
        channel: c.id,
        label: info.label,
        who: info.kind === "dm" ? info.person : who(messages),
        snippet: latest.text,
        count: messages.length,
        more,
        mention: info.kind === "channel" && c.mention_count > 0,
        time: latest.ts,
        markTs: c.latest && newer(c.latest, latest.ts) ? c.latest : latest.ts,
        messages,
      };
    }
    convRows.set(c.id, { sig, row });
    return row;
  }

  async function threadRows() {
    const view = await client.api("subscriptions.thread.getView", {
      limit: "25",
      fetch_threads_state: "true",
      priority_mode: "all",
    });
    const rows = await mapLimit(view.threads || [], 4, async (t) => {
      const root = t.root_msg;
      if (!root?.channel) return null;
      let unread = Array.isArray(t.unread_replies) ? t.unread_replies : [];
      if (unread.length === 0 && root.last_read) {
        unread = (t.latest_replies || []).filter((m) => newer(m.ts, root.last_read));
      }
      if (unread.length === 0) return null;
      unread = [...unread].sort((a, b) => Number(a.ts) - Number(b.ts));
      const [info, messages, [rootMessage]] = await Promise.all([
        convInfo(root.channel),
        normalize(unread),
        normalize([root]),
      ]);
      const latest = messages[messages.length - 1];
      const threadTs = root.thread_ts || root.ts;
      return {
        key: `t:${root.channel}:${threadTs}`,
        kind: "thread",
        channel: root.channel,
        thread_ts: threadTs,
        label: info.kind === "dm" ? info.person : info.label,
        who: who(messages),
        snippet: latest.text,
        count: messages.length,
        more: false,
        mention: false,
        time: latest.ts,
        markTs: latest.ts,
        root: rootMessage,
        messages,
      };
    });
    return rows.filter(Boolean);
  }

  async function loadInbox() {
    const warnings = new Set();
    const [counts, mutedIds] = await Promise.all([
      client.api("client.counts", {
        thread_counts_by_channel: "true",
        org_wide_aware: "true",
        include_file_channels: "true",
      }),
      mutedChannels(),
    ]);
    const convs = [...(counts.channels || []), ...(counts.mpims || []), ...(counts.ims || [])].filter(
      (c) => (c.has_unreads || c.mention_count > 0) && !(mutedIds.has(c.id) && !c.mention_count),
    );
    const rows = await mapLimit(convs, 4, (c) =>
      convRow(c).catch((e) => {
        console.warn("Slack Inbox: conversation failed to load", c, e);
        warnings.add(`Some conversations failed to load (${e.message}).`);
        return null;
      }),
    );
    let threads = [];
    if (counts.threads?.has_unreads) {
      threads = await threadRows().catch((e) => {
        warnings.add(`Thread replies failed to load (${e.message}).`);
        return [];
      });
    }
    return {
      rows: [...rows.filter(Boolean), ...threads].sort((a, b) => Number(b.time) - Number(a.time)),
      warnings: [...warnings],
    };
  }

  async function savedMessage(channel, ts) {
    const key = `${channel}:${ts}`;
    if (savedMessages.has(key)) return savedMessages.get(key);
    let raw;
    try {
      const hist = await client.api("conversations.history", { channel, latest: ts, inclusive: "true", limit: "1" });
      raw = (hist.messages || []).find((m) => m.ts === ts);
    } catch {
      // Thread replies are absent from channel history.
    }
    if (!raw) {
      try {
        const replies = await client.api("conversations.replies", { channel, ts, inclusive: "true", limit: "1" });
        raw = (replies.messages || []).find((m) => m.ts === ts);
      } catch {
        // The message is deleted or the channel is gone.
      }
    }
    if (!raw) return null;
    const [message] = await normalize([raw]);
    savedMessages.set(key, message);
    return message;
  }

  async function loadSaved() {
    const items = [];
    let cursor = "";
    for (let page = 0; page < SAVED_PAGES; page += 1) {
      const data = await client.api("saved.list", {
        filter: "saved",
        limit: "50",
        include_tombstones: "false",
        ...(cursor && { cursor }),
      });
      for (const item of data.saved_items || []) {
        const open = item.state !== "completed" && item.state !== "archived";
        if (item.item_type === "message" && item.item_id && item.ts && open) items.push(item);
      }
      cursor = data.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
    const rows = await mapLimit(items, 4, async (item) => {
      const [info, message] = await Promise.all([convInfo(item.item_id), savedMessage(item.item_id, item.ts)]);
      const inThread = message?.thread_ts && message.thread_ts !== message.ts;
      return {
        key: `s:${item.item_id}:${item.ts}`,
        kind: "saved",
        channel: item.item_id,
        ts: item.ts,
        thread_ts: inThread ? message.thread_ts : undefined,
        label: info.label,
        who: message?.name || (info.kind === "dm" ? info.person : "Unknown"),
        snippet: message?.text ?? "Message unavailable.",
        count: 1,
        more: false,
        mention: false,
        time: item.ts,
        savedAt: item.date_created,
        due: item.date_due > 0 ? item.date_due : undefined,
        messages: message ? [message] : [],
      };
    });
    return { rows, warnings: [] };
  }

  async function markRead(row) {
    if (row.kind === "thread") {
      await client.api("subscriptions.thread.mark", {
        channel: row.channel,
        thread_ts: row.thread_ts,
        ts: row.markTs,
        read: "1",
      });
    } else {
      await client.api("conversations.mark", { channel: row.channel, ts: row.markTs });
      convRows.delete(row.channel);
    }
  }

  async function completeSaved(row) {
    await client.api("saved.update", {
      item_type: "message",
      item_id: row.channel,
      ts: row.ts,
      mark: "completed",
      date_due: "0",
    });
  }

  const knownUser = (id) => names.users[id];

  return { self, loadInbox, loadSaved, markRead, completeSaved, knownUser };
}
