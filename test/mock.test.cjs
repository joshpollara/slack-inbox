// Loads the extension in Chromium and serves canned Slack responses for two workspaces.
// Run: NODE_PATH=<dir with playwright>/node_modules CHROME=<chromium binary> node test/mock.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const EXTENSION = path.resolve(__dirname, "../extension");
const SHOTS = process.env.SHOTS;

const MAIN = "acme.slack.com";
const COMMUNITY = "acme-community.slack.com";
const TOKENS = { [MAIN]: "xoxc-test-token", [COMMUNITY]: "xoxc-community-token" };
const NEVER_READ = "0000000000.000000";

const T = {
  c1Old: "1789999000.000100",
  c1Read: "1790000000.000100",
  c1Join: "1790000100.000100",
  c1First: "1790000200.000100",
  c1Latest: "1790000300.000100",
  d1Latest: "1790000250.000100",
  help: "1790000350.000100",
  root: "1789990000.000100",
  rootRead: "1790000050.000100",
  reply: "1790000400.000100",
  savedTop: "1789000000.000100",
  savedReply: "1788000000.000200",
  savedParent: "1787999000.000100",
};

const users = {
  [MAIN]: {
    U0ALICE: { profile: { display_name: "Alice" }, real_name: "Alice Example" },
    U0BOB: { profile: { display_name: "" }, real_name: "Bob" },
  },
  [COMMUNITY]: { U0CAROL: { profile: { display_name: "Carol" } } },
};

const channels = {
  [MAIN]: {
    C1: { id: "C1", name: "engineering", is_channel: true, is_member: true },
    C2: { id: "C2", name: "muted-noise", is_channel: true, is_member: true },
    C7: { id: "C7", name: "old-project", is_channel: true, is_member: true, is_archived: true },
    C9: { id: "C9", name: "random", is_channel: true, is_member: true },
    D1: { id: "D1", is_im: true, user: "U0ALICE" },
  },
  [COMMUNITY]: { C1: { id: "C1", name: "help", is_channel: true, is_member: true } },
};

const history = {
  [MAIN]: {
    C1: [
      { ts: T.c1Latest, user: "U0ALICE", text: "ping <@U0BOB> see <https://example.com/doc|the doc> &lt;script&gt;alert(1)&lt;/script&gt;" },
      { ts: T.c1First, user: "U0BOB", text: "deploy is done" },
      { ts: T.c1Join, user: "U0BOB", subtype: "channel_join", text: "<@U0BOB> has joined the channel" },
      { ts: T.c1Old, user: "U0BOB", text: "already read" },
    ],
    D1: [{ ts: T.d1Latest, user: "U0ALICE", text: "got a minute?" }],
  },
  [COMMUNITY]: { C1: [{ ts: T.help, user: "U0CAROL", text: "how do I import state?" }] },
};

const counts = {
  [MAIN]: {
    channels: [
      { id: "C1", last_read: T.c1Read, latest: T.c1Latest, mention_count: 1, has_unreads: true },
      { id: "C2", last_read: T.c1Read, latest: "1790000500.000100", mention_count: 0, has_unreads: true },
      { id: "C7", last_read: NEVER_READ, latest: "1780000000.000100", mention_count: 0, has_unreads: true },
      { id: "C9", last_read: T.c1Read, latest: T.c1Read, mention_count: 0, has_unreads: false },
    ],
    mpims: [],
    ims: [{ id: "D1", last_read: NEVER_READ, latest: T.d1Latest, mention_count: 1, has_unreads: true }],
    threads: { has_unreads: true, mention_count: 0 },
  },
  [COMMUNITY]: {
    channels: [{ id: "C1", last_read: NEVER_READ, latest: T.help, mention_count: 0, has_unreads: true }],
    mpims: [],
    ims: [],
    threads: { has_unreads: false, mention_count: 0 },
  },
};

function respond(calls, host, method, p) {
  const main = host === MAIN;
  switch (method) {
    case "auth.test":
      return { ok: true, team_id: main ? "T0TEST" : "T0COMM", user_id: "U0ME", team: main ? "Acme" : "Acme Community" };
    case "client.counts":
      return { ok: true, ...counts[host] };
    case "users.prefs.get":
      return {
        ok: true,
        prefs: { muted_channels: "", all_notifications_prefs: JSON.stringify({ channels: main ? { C2: { muted: true } } : {} }) },
      };
    case "conversations.info":
      return channels[host][p.channel] ? { ok: true, channel: channels[host][p.channel] } : { ok: false, error: "channel_not_found" };
    case "users.info":
      return users[host][p.user] ? { ok: true, user: users[host][p.user] } : { ok: false, error: "user_not_found" };
    case "conversations.history":
      if ("oldest" in p) return { ok: false, error: "invalid_ts_oldest" };
      if (p.latest === T.savedTop) return { ok: true, messages: [{ ts: T.savedTop, user: "U0BOB", text: "remember the runbook" }] };
      if (p.latest === T.savedReply) return { ok: true, messages: [{ ts: T.savedParent, user: "U0BOB", text: "parent" }] };
      return { ok: true, messages: history[host][p.channel] || [], has_more: false };
    case "conversations.replies":
      return { ok: true, messages: [{ ts: T.savedReply, thread_ts: T.savedParent, user: "U0ALICE", text: "saved thread reply" }] };
    case "subscriptions.thread.getView":
      return {
        ok: true,
        total_unread_replies: 1,
        has_more: false,
        threads: [
          {
            root_msg: { channel: "C1", ts: T.root, thread_ts: T.root, user: "U0BOB", text: "root question", last_read: T.rootRead, latest_reply: T.reply, subscribed: true },
            unread_replies: [{ ts: T.reply, thread_ts: T.root, user: "U0ALICE", text: "thread answer" }],
          },
          {
            root_msg: { channel: "C9", ts: "1789980000.000100", thread_ts: "1789980000.000100", user: "U0BOB", text: "read thread", last_read: "1789980100.000100", latest_reply: "1789980100.000100", subscribed: true },
            latest_replies: [{ ts: "1789980100.000100", user: "U0ALICE", text: "already read" }],
          },
        ],
      };
    case "saved.list":
      if (!main) return { ok: true, saved_items: [], response_metadata: { next_cursor: "" } };
      return {
        ok: true,
        saved_items: [
          { item_type: "message", item_id: "C1", ts: T.savedTop, state: "in_progress", date_created: 1789000500, date_due: 0 },
          { item_type: "message", item_id: "C9", ts: T.savedReply, state: "in_progress", date_created: 1788000500, date_due: 0 },
          { item_type: "reminder", item_id: "Rm1", ts: "0", state: "in_progress", date_created: 1788000600 },
        ],
        response_metadata: { next_cursor: "" },
      };
    case "conversations.mark":
      return p.channel === "D1" ? { ok: false, error: "channel_not_found" } : { ok: true };
    case "subscriptions.thread.mark":
    case "saved.update":
      return { ok: true };
    default:
      calls.push({ method: `UNHANDLED ${method}`, p, host });
      return { ok: false, error: "unknown_method" };
  }
}

async function main() {
  const calls = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "slack-inbox-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROME,
    viewport: { width: 1200, height: 760 },
    args: ["--headless=new", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });

  await context.route("https://*.slack.com/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/ssb/redirect" || url.pathname === "/customize/emoji") {
      const token = TOKENS[url.host];
      const body = token ? `<script>var boot = {"api_token":"${token}"};</script>` : "<html>Sign in</html>";
      return route.fulfill({ contentType: "text/html", body });
    }
    const method = url.pathname.replace("/api/", "");
    const p = Object.fromEntries(new URLSearchParams(request.postData() || ""));
    calls.push({ method, p, host: url.host });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(respond(calls, url.host, method, p)) });
  });

  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
  await page.goto(`chrome-extension://${id}/inbox.html`);

  // First run: no workspace, Settings opens, nothing is fetched
  await page.waitForSelector("#settings[open]");
  assert.equal(calls.length, 0);
  assert.equal(await page.locator("#list .empty").textContent(), "Add a workspace in Settings.");
  await page.fill("#ws", "acme, acme-community");
  await page.press("#ws", "Enter");

  const rows = page.locator("#list .row");
  const rowCount = (n) => page.waitForFunction((want) => document.querySelectorAll("#list .row").length === want, n);
  await rowCount(4);
  await page.waitForFunction(() => document.getElementById("n-saved").textContent === "2");
  const last = (method, host = MAIN) => calls.filter((c) => c.method === method && c.host === host).at(-1);
  const historyFor = (host, channel) => calls.filter((c) => c.method === "conversations.history" && c.host === host && c.p.channel === channel);

  // Each workspace uses its own session token
  assert.equal(await page.locator("#ws").isVisible(), false);
  await page.click("#settings-open");
  assert.equal(await page.inputValue("#ws"), "acme, acme-community");
  await page.click("#settings-cancel");
  assert.equal(await page.locator("#settings").isVisible(), false);
  assert.ok(calls.every((c) => c.p.token === TOKENS[c.host]), "every call carries its workspace token");
  assert.ok(calls.some((c) => c.host === COMMUNITY));
  assert.deepEqual(calls.filter((c) => c.method.startsWith("UNHANDLED")), []);

  // Unread window is computed locally; muted and archived channels are skipped
  assert.ok(!calls.some((c) => "oldest" in c.p), "no call sends oldest");
  assert.equal(historyFor(MAIN, "C2").length, 0, "muted channel is skipped");
  assert.equal(historyFor(MAIN, "C7").length, 0, "archived channel is skipped");
  assert.equal(await page.locator("#notice").isHidden(), true);

  // Inbox rows from both workspaces, newest first
  const keys = await rows.evaluateAll((els) => els.map((el) => el.dataset.key));
  assert.deepEqual(keys, [`acme/t:C1:${T.root}`, "acme-community/c:C1", "acme/c:C1", "acme/c:D1"]);
  const c1 = page.locator('[data-key="acme/c:C1"]');
  assert.equal(await c1.locator(".who").textContent(), "Alice, Bob");
  assert.equal(await c1.locator(".ws-chip").textContent(), "acme");
  assert.equal(await c1.locator(".label").textContent(), "#engineering");
  assert.equal(await c1.locator(".count").textContent(), "2");
  assert.equal(await c1.locator(".chip.hot").textContent(), "Mention");
  assert.match(await c1.locator(".snippet").textContent(), /ping @Bob see the doc <script>alert\(1\)<\/script>/);
  assert.equal(await c1.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0TEST/C1/${T.c1First}`);
  const d1 = page.locator('[data-key="acme/c:D1"]');
  assert.equal(await d1.locator(".who").textContent(), "Alice");
  assert.equal(await d1.locator(".label").textContent(), "Direct message");
  assert.equal(await d1.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0TEST/D1/${T.d1Latest}`);
  const help = page.locator('[data-key="acme-community/c:C1"]');
  assert.equal(await help.locator(".who").textContent(), "Carol");
  assert.equal(await help.locator(".ws-chip").textContent(), "acme-community");
  assert.equal(await help.locator(".label").textContent(), "#help");
  assert.equal(await help.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0COMM/C1/${T.help}`);
  const thread = page.locator(`[data-key="acme/t:C1:${T.root}"]`);
  assert.equal(await thread.locator(".chip:not(.ws-chip)").first().textContent(), "Thread");
  assert.equal(await thread.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0TEST/C1/thread/C1-${T.root}/${T.reply}`);
  assert.equal(await page.title(), "(4) Slack Inbox");
  assert.equal(await page.evaluate(() => chrome.action.getBadgeText({})), "4");

  // Open dropdown offers browser and desktop app for the row
  const menu = page.locator("#open-menu");
  assert.equal(await menu.isVisible(), false);
  await thread.locator(".row-head").hover();
  await thread.locator("button.caret").click();
  assert.deepEqual(await menu.locator(".menu-item").allTextContents(), ["Browser", "Desktop app"]);
  assert.deepEqual(
    await menu.locator(".menu-item").evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
    [`https://app.slack.com/client/T0TEST/C1/thread/C1-${T.root}/${T.reply}`, `slack://channel?team=T0TEST&id=C1&message=${T.reply}&thread_ts=${T.root}`],
  );
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "open-menu-light.png") });
  await page.keyboard.press("Escape");
  assert.equal(await menu.isVisible(), false);
  await help.locator(".row-head").hover();
  await help.locator("button.caret").click();
  assert.equal(await menu.locator(".menu-item").nth(1).getAttribute("href"), `slack://channel?team=T0COMM&id=C1&message=${T.help}`);
  await help.locator("button.caret").click();
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.locator(".row.sel").count(), 0, "the dropdown does not select or expand rows");

  // Expand: rich text, no markup injection
  await c1.locator(".row-head").click();
  assert.equal(await c1.locator(".msg").count(), 2);
  assert.equal(await c1.locator(".msg-text a").getAttribute("href"), "https://example.com/doc");
  assert.equal(await c1.locator(".msg-text .mention").textContent(), "@Bob");
  assert.equal(await c1.locator(".msg-text script").count(), 0);
  await thread.locator(".row-head").click();
  assert.equal(await thread.locator(".msg.root .msg-text").textContent(), "root question");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "inbox-light.png") });

  // Keyboard: j selects, e marks read
  await page.keyboard.press("j");
  assert.equal(await page.locator(".row.sel").getAttribute("data-key"), "acme-community/c:C1");
  await page.keyboard.press("k");
  await page.keyboard.press("e");
  await rowCount(3);
  assert.deepEqual(last("subscriptions.thread.mark").p, { channel: "C1", thread_ts: T.root, ts: T.reply, read: "1", token: TOKENS[MAIN] });

  // Mark read goes to the row's workspace
  await c1.locator(".row-head").hover();
  await c1.locator("button.act").click();
  await rowCount(2);
  assert.deepEqual(last("conversations.mark").p, { channel: "C1", ts: T.c1Latest, token: TOKENS[MAIN] });
  await help.locator(".row-head").hover();
  await help.locator("button.act").click();
  await rowCount(1);
  assert.deepEqual(last("conversations.mark", COMMUNITY).p, { channel: "C1", ts: T.help, token: TOKENS[COMMUNITY] });
  assert.equal(await page.title(), "(1) Slack Inbox");

  // A refused mark restores the row and reports the Slack error
  await d1.locator(".row-head").hover();
  await d1.locator("button.act").click();
  await page.waitForSelector("#toast:not([hidden])");
  assert.equal(await page.locator("#toast").textContent(), "acme.slack.com returned channel_not_found for conversations.mark.");
  assert.equal(await rows.count(), 1);

  // A refresh keeps marked rows out
  await page.keyboard.press("r");
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Updated"));
  assert.equal(await rows.count(), 1);

  // Saved view
  await page.keyboard.press("2");
  assert.equal(await rows.count(), 2);
  const savedTop = page.locator(`[data-key="acme/s:C1:${T.savedTop}"]`);
  const savedReply = page.locator(`[data-key="acme/s:C9:${T.savedReply}"]`);
  assert.equal(await savedTop.locator(".who").textContent(), "Bob");
  assert.match(await savedTop.locator(".snippet").textContent(), /remember the runbook/);
  assert.equal(await savedTop.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0TEST/C1/${T.savedTop}`);
  assert.equal(await savedReply.locator(".label").textContent(), "#random");
  assert.match(await savedReply.locator(".snippet").textContent(), /saved thread reply/);
  assert.equal(await savedReply.locator("a.act").getAttribute("href"), `https://app.slack.com/client/T0TEST/C9/thread/C9-${T.savedParent}/${T.savedReply}`);
  await page.emulateMedia({ colorScheme: "dark" });
  await savedTop.locator(".row-head").click();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "saved-dark.png") });
  await savedTop.locator("button.act").click();
  await rowCount(1);
  assert.deepEqual(last("saved.update").p, { item_type: "message", item_id: "C1", ts: T.savedTop, mark: "completed", date_due: "0", token: TOKENS[MAIN] });

  // Open in Slack reuses an open Slack tab
  const slackTab = await context.newPage();
  await context.route("https://app.slack.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Slack</title>" }));
  await slackTab.goto("https://app.slack.com/client/T0TEST/C1");
  await page.bringToFront();
  const tabsBefore = context.pages().length;
  await savedReply.locator(".row-head").hover();
  await savedReply.locator("button.caret").click();
  assert.equal(await menu.locator(".menu-item").nth(1).getAttribute("href"), `slack://channel?team=T0TEST&id=C9&message=${T.savedReply}&thread_ts=${T.savedParent}`);
  await menu.locator(".menu-item").first().click();
  assert.equal(await menu.isVisible(), false);
  await slackTab.waitForURL(`https://app.slack.com/client/T0TEST/C9/thread/C9-${T.savedParent}/${T.savedReply}`);
  assert.equal(context.pages().length, tabsBefore);

  // Toolbar button focuses the open inbox tab
  await worker.evaluate(() => chrome.action.onClicked.dispatch({}));
  await page.waitForFunction(() => document.visibilityState === "visible");
  assert.equal(context.pages().filter((p) => p.url().endsWith("/inbox.html")).length, 1);

  // A signed-out workspace reports its own error and leaves the other one working
  await page.click("#settings-open");
  await page.fill("#ws", "acme, signedout");
  await page.press("#ws", "Enter");
  assert.equal(await page.locator("#settings").isVisible(), false);
  await page.waitForSelector("#notice .notice-line.error");
  assert.match(await page.locator("#notice .notice-line.error").textContent(), /^Not signed in to signedout\.slack\.com in this browser\./);
  await rowCount(2);

  // Narrow layout has no horizontal scroll
  await page.click("#settings-open");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "settings-dark.png") });
  await page.fill("#ws", "acme acme-community.slack.com");
  await page.click('#ws-form button[type="submit"]');
  await page.click("#settings-open");
  assert.equal(await page.inputValue("#ws"), "acme, acme-community");
  await page.keyboard.press("Escape");
  await page.click('.nav-item[data-view="inbox"]');
  await rowCount(4);
  assert.equal(await page.locator("#notice").isHidden(), true);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "inbox-two-workspaces-dark.png") });
  await page.setViewportSize({ width: 420, height: 760 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 420px");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "inbox-narrow-dark.png") });

  assert.deepEqual(pageErrors, []);
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log("ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
