import { HISTORY_LIMIT, REFRESH_MS } from "./config.js";
import { createStore } from "./data.js";
import { SlackError, createClient } from "./slack.js";
import { plain, rich } from "./text.js";

const WORKSPACES_KEY = "si.workspaces";
const VIEWS = ["inbox", "saved"];

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const noticeEl = $("notice");
const statusEl = $("status");
const refreshEl = $("refresh");
const toastEl = $("toast");
const wsEl = $("ws");
const settingsEl = $("settings");
const menuEl = $("open-menu");

const emptyView = () => ({ rows: null, warnings: [], error: null });

const state = {
  view: "inbox",
  selected: null,
  expanded: new Set(),
  hidden: new Set(),
};

let spaces = [];
let busy = false;
let rerun = false;
let lastRefresh = 0;
let toastTimer;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value != null && value !== false) el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children);
  return el;
}

function parseWorkspaces(text) {
  const names = text
    .split(/[\s,]+/)
    .map((w) => w.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.slack\.com$/, "").toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

function savedWorkspaces() {
  try {
    return parseWorkspaces(localStorage.getItem(WORKSPACES_KEY) || "");
  } catch {
    return [];
  }
}

function connect(names) {
  spaces = names.map((name) => {
    const client = createClient(name);
    return { name, client, store: createStore(client), me: null, inbox: emptyView(), saved: emptyView() };
  });
  state.selected = null;
  state.expanded.clear();
  state.hidden.clear();
}

const hiddenKey = (row) => `${row.key}@${row.time}`;

const ORDER = {
  inbox: (a, b) => Number(b.time) - Number(a.time),
  saved: (a, b) => (b.savedAt || 0) - (a.savedAt || 0),
};

function visibleRows(view) {
  return spaces
    .flatMap((space) => space[view].rows || [])
    .filter((row) => !state.hidden.has(hiddenKey(row)))
    .sort(ORDER[view]);
}

function describe(error, space) {
  const host = new URL(space.client.base).host;
  if (error instanceof SlackError) {
    if (error.code === "not_authed") return `Not signed in to ${host} in this browser. Sign in to Slack, then refresh.`;
    if (error.code === "network") return `Cannot reach ${host}.`;
    return `${host} returned ${error.code} for ${error.method}.`;
  }
  return String(error?.message || error);
}

function fmtTime(ts) {
  const date = new Date(Number(ts) * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function slackUrl(row, target) {
  const { me, client } = row.space;
  // Saved rows target the saved message. Unread rows target the first unread message.
  const ts = row.ts || row.messages[0]?.ts || row.time;
  if (!me?.team) {
    const query = row.thread_ts ? `?thread_ts=${row.thread_ts}&cid=${row.channel}` : "";
    return `${client.base}/archives/${row.channel}/p${ts.replace(".", "")}${query}`;
  }
  if (target === "app") {
    const thread = row.thread_ts ? `&thread_ts=${row.thread_ts}` : "";
    return `slack://channel?team=${me.team}&id=${row.channel}&message=${ts}${thread}`;
  }
  // The web client accepts message timestamps only in the dotted form.
  const channel = `https://app.slack.com/client/${me.team}/${row.channel}`;
  if (row.thread_ts) return `${channel}/thread/${row.channel}-${row.thread_ts}/${ts}`;
  return `${channel}/${ts}`;
}

async function openInSlack(url) {
  if (url.startsWith("slack:")) {
    window.location.href = url;
    return;
  }
  if (!globalThis.chrome?.tabs) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const [tab] = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 6000);
}

function closeOpenMenu() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
  delete menuEl.dataset.key;
}

function openLinkEl(row, target, className, label) {
  const url = slackUrl(row, target);
  const link = h("a", { class: className, href: url }, label);
  link.addEventListener("click", (event) => {
    event.stopPropagation();
    closeOpenMenu();
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openInSlack(url);
  });
  return link;
}

function toggleOpenMenu(row, anchor) {
  if (menuEl.dataset.key === row.key) {
    closeOpenMenu();
    return;
  }
  const items = [openLinkEl(row, "web", "menu-item", "Browser"), openLinkEl(row, "app", "menu-item", "Desktop app")];
  for (const item of items) item.setAttribute("role", "menuitem");
  menuEl.replaceChildren(...items);
  menuEl.dataset.key = row.key;
  const box = anchor.getBoundingClientRect();
  menuEl.style.top = `${box.bottom + 4}px`;
  menuEl.style.right = `${document.documentElement.clientWidth - box.right}px`;
  menuEl.hidden = false;
  items[0].focus();
}

function messageEl(message, isRoot, userName) {
  return h(
    "div",
    { class: isRoot ? "msg root" : "msg" },
    h(
      "div",
      { class: "msg-head" },
      h("span", { class: "msg-name" }, message.name),
      h("span", { class: "msg-time" }, fmtTime(message.ts)),
    ),
    h("div", { class: "msg-text" }, rich(message.text, userName)),
  );
}

function bodyEl(row) {
  const userName = row.space.store.knownUser;
  const body = h("div", { class: "row-body" });
  if (row.root) body.append(messageEl(row.root, true, userName));
  for (const message of row.messages) body.append(messageEl(message, false, userName));
  if (row.messages.length === 0) body.append(h("div", { class: "meta" }, "Message unavailable."));
  if (row.more) body.append(h("div", { class: "meta" }, `Showing the latest ${HISTORY_LIMIT} unread messages.`));
  if (row.kind === "saved" && row.savedAt) {
    const due = row.due ? ` Due ${fmtTime(row.due)}.` : "";
    body.append(h("div", { class: "meta" }, `Saved ${fmtTime(row.savedAt)}.${due}`));
  }
  return body;
}

function rowEl(row) {
  const openLink = openLinkEl(row, "web", "btn act", "Open");
  openLink.title = "Open in browser (o)";
  const caret = h("button", { class: "btn caret", type: "button", title: "Open in", "aria-haspopup": "menu" }, "\u25be");
  caret.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleOpenMenu(row, caret);
  });
  const doneLabel = row.kind === "saved" ? "Complete" : "Mark read";
  const doneBtn = h("button", { class: "btn act", type: "button", title: `${doneLabel} (e)` }, doneLabel);
  doneBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    done(row);
  });

  const subject = h("span", { class: "subject" });
  if (spaces.length > 1) subject.append(h("span", { class: "chip ws-chip" }, row.space.name));
  if (row.kind === "thread") subject.append(h("span", { class: "chip" }, "Thread"));
  if (row.mention) subject.append(h("span", { class: "chip hot" }, "Mention"));
  subject.append(
    h("span", { class: "label" }, row.label),
    h("span", { class: "snippet" }, ` ${plain(row.snippet, row.space.store.knownUser)}`),
  );

  const countCell = h("span", { class: "count-cell" });
  if (row.count > 1) countCell.append(h("span", { class: "count" }, row.more ? `${HISTORY_LIMIT}+` : String(row.count)));

  const head = h(
    "div",
    { class: "row-head" },
    h("span", { class: "who" }, row.who),
    subject,
    countCell,
    h("span", { class: "time" }, fmtTime(row.time)),
    h("span", { class: "actions" }, h("span", { class: "split" }, openLink, caret), doneBtn),
  );
  head.addEventListener("click", () => {
    state.selected = row.key;
    toggle(row);
  });

  const classes = ["row"];
  if (row.kind === "saved") classes.push("saved");
  if (row.key === state.selected) classes.push("sel");
  const el = h("div", { class: classes.join(" "), role: "listitem", "data-key": row.key }, head);
  if (state.expanded.has(row.key)) el.append(bodyEl(row));
  return el;
}

function renderNotice() {
  const lines = [];
  for (const space of spaces) {
    const view = space[state.view];
    if (view.error) {
      const line = h("div", { class: "notice-line error" }, describe(view.error, space));
      if (view.error.code === "not_authed") {
        line.append(" ", h("a", { href: space.client.base, target: "_blank", rel: "noopener" }, "Open Slack sign in"));
      }
      lines.push(line);
    }
    for (const warning of view.warnings) {
      lines.push(h("div", { class: "notice-line" }, spaces.length > 1 ? `${space.name}: ${warning}` : warning));
    }
  }
  noticeEl.replaceChildren(...lines);
  noticeEl.hidden = lines.length === 0;
}

function render() {
  for (const button of document.querySelectorAll(".nav-item")) {
    if (button.dataset.view === state.view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const unread = visibleRows("inbox").length;
  $("n-inbox").textContent = unread || "";
  $("n-saved").textContent = visibleRows("saved").length || "";
  document.title = unread ? `(${unread}) Slack Inbox` : "Slack Inbox";
  globalThis.chrome?.action?.setBadgeText({ text: unread ? String(unread) : "" });

  const views = spaces.map((space) => space[state.view]);
  const rows = visibleRows(state.view);
  renderNotice();
  if (spaces.length === 0) {
    listEl.replaceChildren(h("div", { class: "empty" }, "Add a workspace in Settings."));
  } else if (rows.length > 0) {
    listEl.replaceChildren(...rows.map(rowEl));
  } else if (views.some((view) => view.rows === null && !view.error)) {
    listEl.replaceChildren(h("div", { class: "empty" }, "Loading."));
  } else if (views.every((view) => view.rows === null)) {
    listEl.replaceChildren();
  } else {
    const text = state.view === "inbox" ? "No unread messages." : "No saved messages.";
    listEl.replaceChildren(h("div", { class: "empty" }, text));
  }
}

function toggle(row) {
  if (!state.expanded.delete(row.key)) state.expanded.add(row.key);
  render();
}

function move(delta) {
  const rows = visibleRows(state.view);
  if (rows.length === 0) return;
  const index = rows.findIndex((row) => row.key === state.selected);
  const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
  state.selected = rows[next].key;
  render();
  listEl.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
}

async function done(row) {
  const rows = visibleRows(state.view);
  const index = rows.findIndex((r) => r.key === row.key);
  state.hidden.add(hiddenKey(row));
  if (state.selected === row.key) state.selected = (rows[index + 1] || rows[index - 1])?.key ?? null;
  render();
  try {
    await (row.kind === "saved" ? row.space.store.completeSaved(row) : row.space.store.markRead(row));
  } catch (error) {
    state.hidden.delete(hiddenKey(row));
    render();
    toast(describe(error, row.space));
  }
}

function show(view) {
  state.view = view;
  state.selected = null;
  render();
}

async function load(space, name) {
  let result;
  let error = null;
  try {
    space.me = await space.store.self();
    result = await (name === "inbox" ? space.store.loadInbox() : space.store.loadSaved());
  } catch (e) {
    error = e;
  }
  if (!spaces.includes(space)) return;
  const view = space[name];
  view.error = error;
  if (result) {
    view.rows = result.rows.map((row) => ({ ...row, key: `${space.name}/${row.key}`, space }));
    view.warnings = result.warnings;
  }
  render();
}

async function refresh() {
  if (busy) {
    rerun = true;
    return;
  }
  busy = true;
  refreshEl.disabled = true;
  statusEl.textContent = "Refreshing";
  const target = spaces;
  await Promise.all(target.flatMap((space) => VIEWS.map((name) => load(space, name))));
  if (target === spaces) {
    const live = new Set(spaces.flatMap((space) => VIEWS.flatMap((name) => (space[name].rows || []).map(hiddenKey))));
    for (const key of state.hidden) if (!live.has(key)) state.hidden.delete(key);
    lastRefresh = Date.now();
    const loaded = spaces.some((space) => VIEWS.some((name) => !space[name].error));
    statusEl.textContent = loaded ? `Updated ${fmtTime(lastRefresh / 1000)}` : "";
  }
  busy = false;
  refreshEl.disabled = false;
  if (rerun) {
    rerun = false;
    refresh();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (settingsEl.open || event.target.closest("input, textarea")) return;
  if (event.key === "Enter" && event.target.closest("button, a")) return;
  const menuOpen = !menuEl.hidden;
  closeOpenMenu();
  if (menuOpen && event.key === "Escape") return;
  const row = visibleRows(state.view).find((r) => r.key === state.selected);
  const keys = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    Enter: () => row && toggle(row),
    o: () => row && openInSlack(slackUrl(row, "web")),
    O: () => row && openInSlack(slackUrl(row, "app")),
    e: () => row && done(row),
    r: () => refresh(),
    1: () => show("inbox"),
    2: () => show("saved"),
  };
  const action = keys[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});

for (const button of document.querySelectorAll(".nav-item")) {
  button.addEventListener("click", () => show(button.dataset.view));
}

refreshEl.addEventListener("click", () => refresh());

document.addEventListener("click", closeOpenMenu);
window.addEventListener("resize", closeOpenMenu);
document.querySelector("main").addEventListener("scroll", closeOpenMenu);

$("ws-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const names = parseWorkspaces(wsEl.value);
  if (names.length === 0) return;
  try {
    localStorage.setItem(WORKSPACES_KEY, names.join(", "));
  } catch {
    // The list then lasts until the tab closes.
  }
  settingsEl.close();
  connect(names);
  render();
  refresh();
});

function openSettings() {
  wsEl.value = spaces.map((space) => space.name).join(", ");
  settingsEl.showModal();
}

$("settings-open").addEventListener("click", openSettings);

$("settings-cancel").addEventListener("click", () => settingsEl.close());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastRefresh > 15_000) refresh();
});

setInterval(refresh, REFRESH_MS);

connect(savedWorkspaces());
render();
if (spaces.length === 0) openSettings();
else refresh();
