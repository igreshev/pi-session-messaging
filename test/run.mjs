import { fork } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const DIR = "/tmp/psm-test/mail";
fs.rmSync(DIR, { recursive: true, force: true });
const env = { ...process.env, PI_MESSAGES_DIR: DIR };

function boot(name) {
  const p = fork("./session.mjs", [name], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  return new Promise((res) => p.once("message", () => res(p)));
}
const say = (p, m) => new Promise((res) => {
  const t = setTimeout(() => res({ timeout: true }), 3000);
  p.once("message", (r) => { clearTimeout(t); res(r); });
  p.send(m);
});
const tell = (p, m) => { p.send(m); };

const alice = await boot("alice");
const bob = await boot("bob");
await sleep(1300);

console.log("### mode:", (fs.statSync(DIR).mode & 0o777).toString(8), "entries:", fs.readdirSync(DIR).sort().join(" "));

console.log("### T1 peers tool");
await say(alice, { tool: "list_session_peers" });

console.log("### T2 send + delivery");
await say(alice, { cmd: "send", args: "bob hello **bob**\nline2\t<tab>\n```js\nx=1\n```" });
await sleep(1300);

console.log("### T3 send to unknown peer rejected");
await say(alice, { cmd: "send", args: "nobody hi" });
await say(alice, { tool: "send_session_message", params: { peer: "ghost", message: "hi" } });

console.log("### T4 autoreply OFF by default: bob answers, alice must NOT receive");
await say(bob, { assistant: "bob's private answer" });
await sleep(1300);

console.log("### T5 autoreply ON -> reply flows back");
await say(bob, { cmd: "autoreply", args: "on" });
await say(alice, { cmd: "send", args: "bob ping?" });
await sleep(1300);
await say(bob, { assistant: "pong!" });
await sleep(1300);

console.log("### T6 local prompt disarms auto-reply (no leak)");
await say(alice, { cmd: "send", args: "bob question two" });
await sleep(1300);
await say(bob, { localPrompt: "unrelated local work" });
await say(bob, { assistant: "SECRET local answer" });
await sleep(1300);

console.log("### T7 concurrent senders: 200 msgs, none lost");
const dir = `${DIR}/bob.d`;
let sent = 0;
for (let i = 0; i < 200; i++) {
  const stamp = `x-${i}`;
  const tmp = `${dir}/.tmp-${stamp}`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, to: "bob", from: "alice", depth: 0, kind: "user", text: `msg-${i}` }) + "\n");
  fs.renameSync(tmp, `${dir}/${stamp}.msg`);
  sent++;
}
await sleep(2500);
await sleep(2000);
await say(bob, { bulk: true });
console.log("### sent:", sent, "remaining files:", fs.readdirSync(dir).length);

console.log("### T8 duplicate identical messages both delivered");
for (const n of ["d1", "d2"]) {
  fs.writeFileSync(`${dir}/${n}.msg`, JSON.stringify({ v: 1, to: "bob", from: "alice", depth: 0, kind: "user", text: "SAME TEXT" }) + "\n");
}
await sleep(1500);

console.log("### T9 legacy .in + orphan sweep");
fs.writeFileSync(`${DIR}/legacy.in`, "junk\n");
fs.mkdirSync(`${DIR}/ghostbox.d`, { recursive: true });
const carol = await boot("carol");
await sleep(1300);
console.log("### after carol:", fs.readdirSync(DIR).sort().join(" "));

console.log("### T10 shutdown cleans presence");
tell(bob, { shutdown: true });
await sleep(1500);
console.log("### entries:", fs.readdirSync(DIR).sort().join(" "));
await say(alice, { tool: "list_session_peers" });

alice.kill(); carol.kill(); process.exit(0);
