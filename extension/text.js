// Slack message markup to plain text or DOM nodes.

const REF = /<([^<>]+)>/g;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const BROADCASTS = new Set(["here", "channel", "everyone"]);

const decode = (s) => s.replace(/&(?:amp|lt|gt);/g, (m) => ENTITIES[m]);

function reference(inner, userName) {
  const bar = inner.indexOf("|");
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? "" : decode(inner.slice(bar + 1));
  if (target.startsWith("@")) {
    const id = target.slice(1);
    return { type: "mention", text: `@${label || userName(id) || id}` };
  }
  if (target.startsWith("#")) return { type: "mention", text: `#${label || target.slice(1)}` };
  if (target.startsWith("!")) {
    const name = target.slice(1);
    if (BROADCASTS.has(name)) return { type: "mention", text: `@${name}` };
    return { type: name.startsWith("subteam") ? "mention" : "text", text: label || `@${name}` };
  }
  if (/^(https?:\/\/|mailto:)/.test(target)) {
    const href = decode(target);
    return { type: "link", text: label || href, href };
  }
  return { type: "text", text: `<${decode(inner)}>` };
}

function parts(text, userName) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(REF)) {
    if (match.index > last) out.push({ type: "text", text: decode(text.slice(last, match.index)) });
    out.push(reference(match[1], userName));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: decode(text.slice(last)) });
  return out;
}

export function plain(text, userName) {
  return parts(text || "", userName)
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function rich(text, userName) {
  const fragment = document.createDocumentFragment();
  for (const p of parts(text || "", userName)) {
    if (p.type === "link") {
      const a = document.createElement("a");
      a.href = p.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = p.text;
      fragment.append(a);
    } else if (p.type === "mention") {
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = p.text;
      fragment.append(span);
    } else {
      fragment.append(p.text);
    }
  }
  return fragment;
}
