// Presence / liveness tests: atomic heartbeat, v1 fallback, stale pruning,
// pid-reuse guard. Run after bundling plugin.mjs (see README.md).
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DIR = path.join(os.tmpdir(), "psm-presence");
fs.rmSync(DIR, { recursive: true, force: true });
const env = { ...process.env, PI_MESSAGES_DIR: DIR };
const HOST = os.hostname();
const STALE_MS = 5000 * 4;

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`${cond ? "ok  " : "FAIL"}  ${name}${extra ? ` ${extra}` : ""}`);
	if (!cond) failures++;
}

const boot = (n) =>
	new Promise((r) => {
		const p = fork(new URL("./session.mjs", import.meta.url), [n], {
			env,
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		p.once("message", () => r(p));
	});
const ask = (p, m) =>
	new Promise((res) => {
		const t = setTimeout(() => res({ timeout: true }), 3000);
		p.on("message", function h(x) {
			if (x?.ev === "tool") {
				clearTimeout(t);
				p.off("message", h);
				res(x);
			}
		});
		p.send(m);
	});

function writePeer(name, { pid, host = HOST, token = "tok-1", v2 = true, ageMs = 0 }) {
	const f = path.join(DIR, `${name}.peer`);
	fs.writeFileSync(f, v2 ? `v2\t${name}\t${pid}\t${host}\t${token}\n` : `${name}\t${pid}\t${host}\n`);
	if (ageMs > 0) {
		const t = (Date.now() - ageMs) / 1000;
		fs.utimesSync(f, t, t);
	}
	fs.mkdirSync(path.join(DIR, `${name}.d`), { recursive: true });
}

const peersOf = (r) => r?.r?.details?.peers ?? [];
const deadPid = 999_999; // unused high pid

const me = await boot("me");
await sleep(200);

// --- presence record format + atomicity -----------------------------------
const own = fs.readFileSync(path.join(DIR, "me.peer"), "utf8").trim().split("\t");
check("#17 presence record is v2 with 5 fields", own[0] === "v2" && own.length === 5, JSON.stringify(own));
check("#17 record carries a boot token", !!own[4] && own[4].includes("-"));
check(
	"#15 no .peertmp-* leftovers after atomic write",
	fs.readdirSync(DIR).filter((n) => n.startsWith(".peertmp-")).length === 0,
);

const mtime1 = fs.statSync(path.join(DIR, "me.peer")).mtimeMs;
await sleep(6000);
const mtime2 = fs.statSync(path.join(DIR, "me.peer")).mtimeMs;
check("#15 heartbeat refreshes on its own 5s timer", mtime2 > mtime1, `${mtime2 - mtime1}ms`);

// --- liveness ------------------------------------------------------------
writePeer("v1live", { pid: process.pid, v2: false });
writePeer("v2live", { pid: process.pid });
writePeer("v1dead", { pid: deadPid, v2: false });
writePeer("v2dead", { pid: deadPid });
let r = await ask(me, { tool: "list_session_peers" });
let p = peersOf(r);
check("v1 record with live pid is accepted (backward compat)", p.includes("v1live"), JSON.stringify(p));
check("v2 record with live pid is accepted", p.includes("v2live"));
check("dead pid pruned (v1)", !p.includes("v1dead") && !fs.existsSync(path.join(DIR, "v1dead.peer")));
check("dead pid pruned (v2)", !p.includes("v2dead"));
check("dead peer spool removed", !fs.existsSync(path.join(DIR, "v2dead.d")));

// --- #17 pid reuse -------------------------------------------------------
writePeer("recycled", { pid: process.pid, ageMs: STALE_MS + 2000 });
r = await ask(me, { tool: "list_session_peers" });
p = peersOf(r);
check("#17 live pid + stale heartbeat treated as recycled pid", !p.includes("recycled"), JSON.stringify(p));

// --- #16 cross-host staleness -------------------------------------------
writePeer("remotefresh", { pid: deadPid, host: "other-host", ageMs: 0 });
writePeer("remotestale", { pid: deadPid, host: "other-host", ageMs: STALE_MS + 2000 });
writePeer("remotev1", { pid: deadPid, host: "other-host", v2: false, ageMs: STALE_MS + 2000 });
r = await ask(me, { tool: "list_session_peers" });
p = peersOf(r);
check("#16 fresh cross-host peer kept (pid not probeable)", p.includes("remotefresh"), JSON.stringify(p));
check("#16 stale cross-host peer pruned by mtime", !p.includes("remotestale"));
check("#16 v1 cross-host peer given a longer grace window", p.includes("remotev1"));

// --- malformed records ---------------------------------------------------
fs.writeFileSync(path.join(DIR, "trunc.peer"), "v2\ttrunc\t");
fs.writeFileSync(path.join(DIR, "empty.peer"), "");
r = await ask(me, { tool: "list_session_peers" });
p = peersOf(r);
check("truncated record ignored, not reported as a peer", !p.includes("trunc") && !p.includes("empty"));

me.kill();
console.log(failures === 0 ? "\nall presence checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
