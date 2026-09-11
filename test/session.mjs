// Fake pi host: boots the extension, logs delivered user messages.
import plugin from "./plugin.mjs";

const NAME = process.argv[2];
const handlers = new Map();
const commands = new Map();
const tools = new Map();
const log = (o) => console.log(JSON.stringify({ s: NAME, ...o }));

const pi = {
  on: (ev, h) => { (handlers.get(ev) ?? handlers.set(ev, []).get(ev)).push(h); },
  registerCommand: (n, c) => commands.set(n, c),
  registerTool: (t) => tools.set(t.name, t),
  getSessionName: () => NAME,
  setSessionName: () => {},
  sendUserMessage: (text, opts) => {
    if (/msg-\d+$/.test(text)) { globalThis.__bulk = (globalThis.__bulk ?? 0) + 1; }
    else log({ ev: "delivered", text, deliverAs: opts?.deliverAs });
    // emulate pi: injected message fires an input event with source "extension"
    fire("input", { text, source: "extension" });
  },
};
const ctx = { hasUI: true, ui: { notify: (m) => log({ ev: "notify", m }), setStatus: () => {} } };
function fire(ev, payload) { for (const h of handlers.get(ev) ?? []) h(payload, ctx); }

plugin(pi);
fire("session_start", { reason: "new" });

process.on("message", async (m) => {
  if (m.cmd) { await commands.get(m.cmd).handler(m.args ?? "", ctx); }
  if (m.tool) { log({ ev: "tool", r: await tools.get(m.tool).execute("id", m.params) }); }
  if (m.assistant) { fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: m.assistant }] } }); }
  if (m.localPrompt) { fire("input", { text: m.localPrompt, source: "interactive" }); }
  if (m.bulk) { log({ ev: "bulkCount", n: globalThis.__bulk ?? 0 }); }
  if (m.shutdown) { fire("session_shutdown", {}); process.exit(0); }
  process.send?.({ ack: true });
});
process.send?.({ ready: true, name: NAME });
setInterval(() => {}, 1 << 30);
