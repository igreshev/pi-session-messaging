/**
 * Cross-session messaging plugin for pi (peer-to-peer, no server).
 *
 * - Peer discovery via ~/.pi/messages/*.peer
 * - Transport: one file per message in ~/.pi/messages/<mailbox>.d/, written
 *   temp-then-rename so delivery is atomic and concurrent senders never
 *   clobber each other (no read-modify-write of a shared file).
 * - Queueing with deliverAs: "followUp" so busy sessions never drop messages
 * - Auto-reply is opt-in (/autoreply on) and correlated to the turn that the
 *   incoming message actually triggered, so local prompts never leak to peers.
 * - Both UI commands (/send, /peers, /mset, /inbox, /autoreply) and LLM tools
 *   (send_session_message, list_session_peers)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAIL_DIR = process.env.PI_MESSAGES_DIR || path.join(os.homedir(), ".pi", "messages");
const POLL_MS = 1000;
/** Auto-reply chain limit. Each step costs an LLM turn in both sessions. */
const MAX_AUTO_DEPTH = 4;
const MAX_AUTO_REPLY_CHARS = 4000;
/** Hard cap on any single message, enforced on send and on receive. */
const MAX_MESSAGE_CHARS = 32_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const WIRE_VERSION = 1;

interface Envelope {
	v: number;
	to: string;
	from: string;
	depth: number;
	kind: "user" | "auto";
	text: string;
}

let myMailbox: string | null = null;
/** Opt-in: auto-replying spends tokens in both sessions, so default off. */
let autoReplyEnabled = false;

/** Peer we owe a reply to for the turn currently in flight. */
let armedReply: { peer: string; depth: number } | null = null;
/** Deliveries injected but not yet claimed by their `input` event. */
const pendingDeliveries = new Map<string, { peer: string; depth: number }>();

let currentCtx: ExtensionContext | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let seq = 0;

function defaultMailbox(): string {
	return `sess-${process.pid}`;
}

function sanitize(s: string): string {
	const c = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-._]+|[-._]+$/g, "");
	return c || defaultMailbox();
}

function boxDir(mailbox: string): string {
	return path.join(MAIL_DIR, `${mailbox}.d`);
}

function peerFile(mailbox: string): string {
	return path.join(MAIL_DIR, `${mailbox}.peer`);
}

/**
 * Create the mail root with owner-only permissions. Messages are injected into
 * the agent as user text, so a world-writable spool would be a prompt-injection
 * vector for any other local process.
 */
function ensureDir(): boolean {
	try {
		fs.mkdirSync(MAIL_DIR, { recursive: true, mode: DIR_MODE });
	} catch {
		/* ignore */
	}
	try {
		const st = fs.statSync(MAIL_DIR);
		const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
		if (st.uid !== uid) return false;
		if ((st.mode & 0o077) !== 0) {
			try {
				fs.chmodSync(MAIL_DIR, DIR_MODE);
			} catch {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function writePresence(): void {
	if (!myMailbox) return;
	if (!ensureDir()) return;
	try {
		fs.writeFileSync(peerFile(myMailbox), `${myMailbox}\t${process.pid}\t${os.hostname()}\n`, {
			encoding: "utf8",
			mode: FILE_MODE,
		});
	} catch {
		/* ignore */
	}
}

function removeTree(p: string): void {
	try {
		fs.rmSync(p, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

/**
 * List all live peers. Liveness is checked with process.kill(pid, 0) so closed
 * terminals are pruned immediately instead of after a timeout. EPERM counts as
 * alive (process exists, different owner).
 */
function listPeers(): string[] {
	if (!ensureDir()) return [];
	const out: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(MAIL_DIR);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".peer")) continue;
		const mbox = name.slice(0, -".peer".length);
		if (mbox === myMailbox) continue;
		const p = peerFile(mbox);
		try {
			const parts = fs.readFileSync(p, "utf8").trim().split("\t");
			const pid = Number(parts[1]);
			const host = parts[2];
			if (host === os.hostname() && Number.isFinite(pid) && pid > 0) {
				try {
					process.kill(pid, 0);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code === "ESRCH") {
						try {
							fs.unlinkSync(p);
						} catch {
							/* ignore */
						}
						removeTree(boxDir(mbox));
						continue;
					}
				}
			}
		} catch {
			continue;
		}
		out.push(mbox);
	}
	return out.sort();
}

function sendMessage(
	to: string,
	text: string,
	depth = 0,
	kind: Envelope["kind"] = "user",
): { ok: boolean; error?: string } {
	if (!to) return { ok: false, error: "No recipient mailbox given." };
	if (!text.trim()) return { ok: false, error: "Message body is empty." };
	if (text.length > MAX_MESSAGE_CHARS) {
		return { ok: false, error: `Message too large (${text.length} > ${MAX_MESSAGE_CHARS} chars).` };
	}
	if (!ensureDir()) return { ok: false, error: `Mail dir ${MAIL_DIR} is not owner-private.` };

	const dir = boxDir(to);
	try {
		fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	} catch (e) {
		return { ok: false, error: String(e) };
	}

	const env: Envelope = { v: WIRE_VERSION, to, from: myMailbox ?? defaultMailbox(), depth, kind, text };
	const stamp = `${Date.now()}-${process.pid}-${(seq++).toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
	const tmp = path.join(dir, `.tmp-${stamp}`);
	const final = path.join(dir, `${stamp}.msg`);
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(env)}\n`, { encoding: "utf8", mode: FILE_MODE });
		// Atomic publish: readers only ever observe a complete message file.
		fs.renameSync(tmp, final);
		return { ok: true };
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		return { ok: false, error: String(e) };
	}
}

function parseEnvelope(raw: string): Envelope | null {
	try {
		const o = JSON.parse(raw) as Partial<Envelope>;
		if (!o || typeof o.text !== "string") return null;
		return {
			v: typeof o.v === "number" ? o.v : WIRE_VERSION,
			to: typeof o.to === "string" ? o.to : "",
			from: typeof o.from === "string" ? o.from : "",
			depth: Number.isFinite(o.depth) ? Number(o.depth) : 0,
			kind: o.kind === "auto" ? "auto" : "user",
			text: o.text,
		};
	} catch {
		return null;
	}
}

/** Peek without consuming. */
function peekInbox(): Envelope[] {
	if (!myMailbox) return [];
	const dir = boxDir(myMailbox);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".msg")).sort();
	} catch {
		return [];
	}
	const out: Envelope[] = [];
	for (const n of names) {
		try {
			const env = parseEnvelope(fs.readFileSync(path.join(dir, n), "utf8"));
			if (env) out.push(env);
		} catch {
			/* ignore */
		}
	}
	return out;
}

function drainInbox(pi: ExtensionAPI): void {
	if (!myMailbox) return;
	const dir = boxDir(myMailbox);
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".msg")).sort();
	} catch {
		return;
	}

	for (const name of names) {
		const src = path.join(dir, name);
		// Claim by rename: exactly one drainer (timer vs. command vs. stale
		// instance) can win, so a message is never delivered twice.
		const claimed = path.join(dir, `.claim-${process.pid}-${name}`);
		try {
			fs.renameSync(src, claimed);
		} catch {
			continue;
		}

		let env: Envelope | null = null;
		try {
			env = parseEnvelope(fs.readFileSync(claimed, "utf8"));
		} catch {
			/* ignore */
		}
		if (!env || !env.text.trim() || (env.to && env.to !== myMailbox)) {
			try {
				fs.unlinkSync(claimed);
			} catch {
				/* ignore */
			}
			continue;
		}

		const body =
			env.text.length > MAX_MESSAGE_CHARS ? `${env.text.slice(0, MAX_MESSAGE_CHARS)}\n\n[truncated]` : env.text;
		const label = env.from ? `@${env.from}` : "@peer";
		// Without an explicit routing hint the model answers in its own terminal
		// and the sender never hears back. Only add it when a reply is possible
		// and would not be sent automatically.
		const hint =
			env.from && env.from !== myMailbox && !autoReplyEnabled && env.kind !== "auto"
				? `\n\n(To answer ${label}, call send_session_message with peer="${env.from}". Text you write here is NOT visible to them.)`
				: "";
		const display = `[message from ${label}] ${body.trim()}${hint}`;

		// Register the pending auto-reply *before* injecting: the `input` event
		// fires during sendUserMessage, so arming afterwards would always lose
		// the race and no reply would ever be sent.
		const wantsReply =
			autoReplyEnabled && env.kind !== "auto" && env.depth < MAX_AUTO_DEPTH && !!env.from && env.from !== myMailbox;
		if (wantsReply) {
			pendingDeliveries.set(display, { peer: env.from, depth: env.depth + 1 });
		}

		try {
			pi.sendUserMessage(display, { deliverAs: "followUp" });
		} catch {
			pendingDeliveries.delete(display);
			// Put it back so the next poll retries instead of losing it.
			try {
				fs.renameSync(claimed, src);
			} catch {
				/* ignore */
			}
			continue;
		}

		try {
			fs.unlinkSync(claimed);
		} catch {
			/* ignore */
		}

		if (currentCtx?.hasUI) {
			const preview = body.length > 50 ? `${body.slice(0, 50)}...` : body;
			currentCtx.ui.notify(`[${env.from}] ${preview}`, "info");
		}
	}
}

/**
 * Remove spool dirs whose owning session no longer publishes presence, plus
 * legacy `<mailbox>.in` files left behind by the pre-1.1 single-file transport.
 */
function pruneOrphanBoxes(): void {
	if (!ensureDir()) return;
	let names: string[];
	try {
		names = fs.readdirSync(MAIL_DIR);
	} catch {
		return;
	}
	for (const name of names) {
		if (name.endsWith(".in")) {
			try {
				fs.unlinkSync(path.join(MAIL_DIR, name));
			} catch {
				/* ignore */
			}
			continue;
		}
		if (!name.endsWith(".d")) continue;
		const mbox = name.slice(0, -".d".length);
		if (mbox === myMailbox) continue;
		if (fs.existsSync(peerFile(mbox))) continue;
		removeTree(path.join(MAIL_DIR, name));
	}
}

function startWatcher(pi: ExtensionAPI): void {
	if (watchTimer) return;
	ensureDir();
	watchTimer = setInterval(() => {
		writePresence();
		drainInbox(pi);
	}, POLL_MS);
	watchTimer.unref();
}

function stopWatcher(): void {
	if (watchTimer) {
		clearInterval(watchTimer);
		watchTimer = null;
	}
}

function splitAddress(args: string): { head: string; rest: string } {
	const t = args.trim();
	const sp = t.indexOf(" ");
	if (sp < 0) return { head: t, rest: "" };
	return { head: t.slice(0, sp), rest: t.slice(sp + 1).trim() };
}

/** Trim on a newline/space boundary so code fences and surrogate pairs survive. */
function clampReply(text: string): string {
	if (text.length <= MAX_AUTO_REPLY_CHARS) return text;
	let cut = text.slice(0, MAX_AUTO_REPLY_CHARS);
	const nl = cut.lastIndexOf("\n");
	if (nl > MAX_AUTO_REPLY_CHARS * 0.5) cut = cut.slice(0, nl);
	const fences = (cut.match(/```/g) ?? []).length;
	if (fences % 2 === 1) cut += "\n```";
	return `${cut}\n\n[truncated...]`;
}

export default function (pi: ExtensionAPI) {
	ensureDir();

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		if (!myMailbox) {
			const name = pi.getSessionName?.() as string | undefined;
			myMailbox = sanitize(name && name.trim() ? name : defaultMailbox());
			writePresence();
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus("mailbox", `mailbox: ${myMailbox}`);
		}
		pruneOrphanBoxes();
		startWatcher(pi);
	});

	pi.on("session_info_changed", (event, ctx) => {
		currentCtx = ctx;
		if (event.name && event.name.trim()) {
			const next = sanitize(event.name);
			if (next !== myMailbox) {
				if (myMailbox) {
					try {
						fs.unlinkSync(peerFile(myMailbox));
					} catch {
						/* ignore */
					}
				}
				myMailbox = next;
				writePresence();
			}
			if (ctx.hasUI) {
				ctx.ui.setStatus("mailbox", `mailbox: ${myMailbox}`);
			}
		}
	});

	pi.on("session_shutdown", () => {
		stopWatcher();
		armedReply = null;
		pendingDeliveries.clear();
		currentCtx = null;
		if (myMailbox) {
			try {
				fs.unlinkSync(peerFile(myMailbox));
			} catch {
				/* ignore */
			}
			removeTree(boxDir(myMailbox));
		}
	});

	// Correlate the auto-reply with the turn the incoming message triggered.
	// A locally typed prompt disarms it, so private answers never go out.
	pi.on("input", (event) => {
		if (event.source === "extension") {
			const hit = pendingDeliveries.get(event.text);
			if (hit) {
				pendingDeliveries.delete(event.text);
				armedReply = hit;
			}
			return;
		}
		armedReply = null;
		pendingDeliveries.clear();
	});

	// Forward assistant replies back to the sender
	pi.on("message_end", (event) => {
		if (!armedReply) return;
		const msg = (event as any).message as any;
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason && msg.stopReason !== "stop") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				armedReply = null;
			}
			return;
		}

		const text = Array.isArray(msg.content)
			? msg.content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n")
			: "";
		if (!text.trim()) return;

		const { peer, depth } = armedReply;
		armedReply = null;
		if (peer === myMailbox) return;
		sendMessage(peer, clampReply(text.trim()), depth, "auto");
	});

	// --- Commands ---

	pi.registerCommand("mset", {
		description: "Set this session's mailbox name (e.g. /mset alice)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const label = args.trim();
			if (!label) {
				ctx.ui.notify(`Current mailbox: ${myMailbox ?? "(unset)"}`, "info");
				return;
			}
			const next = sanitize(label);
			if (myMailbox && myMailbox !== next) {
				try {
					fs.unlinkSync(peerFile(myMailbox));
				} catch {
					/* ignore */
				}
				removeTree(boxDir(myMailbox));
			}
			myMailbox = next;
			writePresence();
			if (ctx.hasUI) {
				ctx.ui.setStatus("mailbox", `mailbox: ${myMailbox}`);
			}
			ctx.ui.notify(`Mailbox set to ${myMailbox}`, "info");
			try {
				pi.setSessionName(myMailbox);
			} catch {
				/* ignore */
			}
		},
	});

	pi.registerCommand("send", {
		description: "Send a message to another session (usage: /send <mailbox> <message>)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const { head, rest } = splitAddress(args);
			if (!head || !rest) {
				ctx.ui.notify("Usage: /send <mailbox> <message>", "error");
				return;
			}
			if (!myMailbox) {
				myMailbox = sanitize(pi.getSessionName?.() || defaultMailbox());
				writePresence();
			}
			const to = sanitize(head);
			if (!listPeers().includes(to)) {
				ctx.ui.notify(`No live session named @${to}. Use /peers to list active sessions.`, "error");
				return;
			}
			const res = sendMessage(to, rest, 0);
			ctx.ui.notify(res.ok ? `Sent to @${to}` : `Send failed: ${res.error}`, res.ok ? "info" : "error");
		},
	});

	pi.registerCommand("peers", {
		description: "List reachable pi sessions",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const peers = listPeers();
			if (peers.length === 0) {
				ctx.ui.notify("No other active sessions found.", "info");
				return;
			}
			ctx.ui.notify(`Active peers: ${peers.map((p) => `@${p}`).join(", ")}`, "info");
		},
	});

	pi.registerCommand("inbox", {
		description: "Peek at messages still waiting in your mailbox (does not consume them)",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			const msgs = peekInbox();
			if (msgs.length === 0) {
				ctx.ui.notify("Inbox empty", "info");
				return;
			}
			const decoded = msgs.map((m) => `From @${m.from || "peer"}: ${m.text}`);
			ctx.ui.notify(`Inbox (${msgs.length}):\n${decoded.join("\n")}`, "info");
		},
	});

	pi.registerCommand("autoreply", {
		description: "Toggle auto-replying to incoming session messages (on/off)",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const a = args.trim().toLowerCase();
			if (a === "on") autoReplyEnabled = true;
			else if (a === "off") autoReplyEnabled = false;
			else autoReplyEnabled = !autoReplyEnabled;
			if (!autoReplyEnabled) {
				armedReply = null;
				pendingDeliveries.clear();
			}
			ctx.ui.notify(
				`Auto-reply is now ${autoReplyEnabled ? `ON (max ${MAX_AUTO_DEPTH} chained turns)` : "OFF"}`,
				"info",
			);
		},
	});

	// --- LLM Tools ---

	pi.registerTool({
		name: "send_session_message",
		label: "Send Session Message",
		description:
			"Send a message to another active pi session on this machine. Use list_session_peers to find active sessions. The recipient session receives the message and will respond.",
		parameters: Type.Object({
			peer: Type.String({ description: "Target session name (e.g. 'alice', 'bob')" }),
			message: Type.String({ description: "The message to send" }),
		}),
		async execute(_id, params) {
			const to = sanitize(params.peer);
			if (!listPeers().includes(to)) {
				return {
					content: [
						{ type: "text", text: `No live session named @${to}. Call list_session_peers for current peers.` },
					],
					isError: true,
				};
			}
			const res = sendMessage(to, params.message, 0);
			if (!res.ok) {
				return {
					content: [{ type: "text", text: `Failed to send to ${to}: ${res.error}` }],
					isError: true,
				};
			}
			if (armedReply?.peer === to) armedReply = null;
			return { content: [{ type: "text", text: `Message sent to @${to}.` }] };
		},
	});

	pi.registerTool({
		name: "list_session_peers",
		label: "List Session Peers",
		description: "List other active pi sessions available for message exchange.",
		parameters: Type.Object({}),
		async execute() {
			const peers = listPeers();
			if (peers.length === 0) {
				return { content: [{ type: "text", text: "No other active sessions currently reachable." }] };
			}
			return {
				content: [{ type: "text", text: `Available sessions: ${peers.map((p) => `@${p}`).join(", ")}` }],
				details: { peers },
			};
		},
	});
}
