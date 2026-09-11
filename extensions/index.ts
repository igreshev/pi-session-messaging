/**
 * Cross-session messaging plugin for pi (peer-to-peer, no server).
 *
 * Provides Claude Code-like cross-session communication:
 * - Peer discovery via ~/.pi/messages/*.peer
 * - Multi-line message passing using base64 payload
 * - Queueing with deliverAs: "followUp" so busy sessions never drop messages
 * - Chained dialogue / small-talk up to MAX_AUTO_DEPTH turns
 * - Turn numbering and echo-safe depth tracking
 * - Both UI commands (/send, /peers, /mset, /inbox, /autoreply) and LLM tools (send_session_message, list_session_peers)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAIL_DIR = process.env.PI_MESSAGES_DIR || path.join(os.homedir(), ".pi", "messages");
const POLL_MS = 1000;
const MAX_AUTO_DEPTH = 45; // allows 20+ roundtrips (40+ turns total)
const MAX_AUTO_REPLY_CHARS = 4000;

let myMailbox: string | null = null;
let autoReplyEnabled = true;

// Tracks who to auto-reply to after an incoming turn finishes
let pendingReplyTo: string | null = null;
let pendingReplyDepth = 0;

let currentCtx: ExtensionContext | null = null;

function defaultMailbox(): string {
	return `sess-${process.pid}`;
}

function sanitize(s: string): string {
	const c = s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-._]+|[-._]+$/g, "");
	return c || defaultMailbox();
}

function boxFile(mailbox: string): string {
	return path.join(MAIL_DIR, `${mailbox}.in`);
}

function peerFile(mailbox: string): string {
	return path.join(MAIL_DIR, `${mailbox}.peer`);
}

function ensureDir(): void {
	try {
		fs.mkdirSync(MAIL_DIR, { recursive: true });
	} catch {
		/* ignore */
	}
}

function writePresence(): void {
	if (!myMailbox) return;
	ensureDir();
	try {
		fs.writeFileSync(peerFile(myMailbox), `${myMailbox}\t${process.pid}\t${os.hostname()}\n`, "utf8");
	} catch {
		/* ignore */
	}
}

/**
 * List all live peers. Validates process liveness using process.kill(pid, 0)
 * to instantly clean up dead peer files without relying on timeouts.
 */
function listPeers(): string[] {
	ensureDir();
	const out: string[] = [];
	try {
		for (const name of fs.readdirSync(MAIL_DIR)) {
			if (!name.endsWith(".peer")) continue;
			const mbox = name.slice(0, -".peer".length);
			if (mbox === myMailbox) continue;
			const p = peerFile(mbox);
			try {
				const content = fs.readFileSync(p, "utf8").trim();
				const parts = content.split("\t");
				const pid = Number(parts[1]);
				const host = parts[2];

				// If on same host and PID is dead, remove immediately
				if (host === os.hostname() && pid > 0) {
					try {
						process.kill(pid, 0);
					} catch (e: any) {
						if (e.code === "ESRCH") {
							try { fs.unlinkSync(p); } catch {}
							try { fs.unlinkSync(boxFile(mbox)); } catch {}
							continue;
						}
					}
				}
			} catch {
				continue;
			}
			out.push(mbox);
		}
	} catch {
		/* ignore */
	}
	return out.sort();
}

function encodeBody(text: string): string {
	return `b64:${Buffer.from(text, "utf8").toString("base64")}`;
}

function decodeBody(raw: string): string {
	if (raw.startsWith("b64:")) {
		try {
			return Buffer.from(raw.slice(4), "base64").toString("utf8");
		} catch {
			return raw.slice(4);
		}
	}
	return raw;
}

function sendMessage(to: string, text: string, depth = 0): { ok: boolean; error?: string } {
	if (!to) return { ok: false, error: "No recipient mailbox given." };
	if (!text.trim()) return { ok: false, error: "Message body is empty." };
	ensureDir();
	try {
		const payload = encodeBody(text);
		const line = `${to}\t${myMailbox ?? defaultMailbox()}\t${depth}\t${payload}\n`;
		fs.appendFileSync(boxFile(to), line, "utf8");
		return { ok: true };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}

function drainInbox(pi: ExtensionAPI): void {
	if (!myMailbox) return;
	const file = boxFile(myMailbox);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return;
	}
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return;

	const delivered: string[] = [];
	for (const line of lines) {
		const parts = line.split("\t");
		const recipient = parts[0] ?? "";
		const from = parts[1] ?? "";
		let depth = 0;
		let rawBody = "";

		if (parts.length >= 4) {
			depth = Number(parts[2]) || 0;
			rawBody = parts.slice(3).join("\t");
		} else {
			rawBody = parts.slice(2).join("\t");
		}

		if (recipient !== myMailbox) continue;
		const body = decodeBody(rawBody);
		if (!body.trim()) continue;

		const cleanBody = body.replace(/^\(auto-reply\)\s*/i, "").trim();
		const label = from && from !== "unknown" ? `@${from}` : "@peer";
		const display = `[message from ${label}] ${cleanBody}`;

		try {
			pi.sendUserMessage(display, { deliverAs: "followUp" });
			delivered.push(line);

			if (currentCtx?.hasUI) {
				const preview = cleanBody.length > 50 ? `${cleanBody.slice(0, 50)}...` : cleanBody;
				currentCtx.ui.notify(`[${from}] ${preview}`, "info");
			}

			// Echo suppression: incoming auto-replies deliver the answer cleanly
			// without triggering another automatic reply loop.
			const isAutoReply = /^\(auto-reply\)/i.test(body.trim());
			if (autoReplyEnabled && depth < MAX_AUTO_DEPTH && !isAutoReply) {
				pendingReplyTo = from || null;
				pendingReplyDepth = depth + 1;
			} else {
				pendingReplyTo = null;
			}
		} catch {
			// If sendUserMessage threw synchronously, keep line in file to retry
		}
	}

	if (delivered.length === 0) return;
	const next = lines.filter((l) => !delivered.includes(l)).join("\n");
	try {
		fs.writeFileSync(file, next ? `${next}\n` : "", "utf8");
	} catch {
		/* ignore */
	}
}

function startWatcher(pi: ExtensionAPI): void {
	ensureDir();
	const timer = setInterval(() => {
		writePresence();
		drainInbox(pi);
	}, POLL_MS);
	timer.unref();
}

function splitAddress(args: string): { head: string; rest: string } {
	const t = args.trim();
	const sp = t.indexOf(" ");
	if (sp < 0) return { head: t.toLowerCase(), rest: "" };
	return { head: t.slice(0, sp).toLowerCase(), rest: t.slice(sp + 1).trim() };
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
	});

	pi.on("session_info_changed", (event, ctx) => {
		currentCtx = ctx;
		if (event.name && event.name.trim()) {
			myMailbox = sanitize(event.name);
			writePresence();
			if (ctx.hasUI) {
				ctx.ui.setStatus("mailbox", `mailbox: ${myMailbox}`);
			}
		}
	});

	pi.on("session_shutdown", () => {
		pendingReplyTo = null;
		if (myMailbox) {
			try { fs.unlinkSync(peerFile(myMailbox)); } catch {}
		}
	});

	// Forward assistant replies back to the sender
	pi.on("message_end", (event) => {
		if (!pendingReplyTo) return;
		const msg = (event as any).message as any;
		if (!msg || msg.role !== "assistant") return;
		if (msg.stopReason && msg.stopReason !== "stop") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				pendingReplyTo = null;
			}
			return;
		}

		let text = Array.isArray(msg.content)
			? msg.content
					.filter((c: any) => c?.type === "text" && typeof c.text === "string")
					.map((c: any) => c.text)
					.join("\n")
			: "";

		if (!text.trim()) return;

		if (text.length > MAX_AUTO_REPLY_CHARS) {
			text = `${text.slice(0, MAX_AUTO_REPLY_CHARS)}\n\n[truncated...]`;
		}

		const to = pendingReplyTo;
		const depth = pendingReplyDepth;
		pendingReplyTo = null;

		if (to === myMailbox) return;
		sendMessage(to, `(auto-reply) ${text.trim()}`, depth);
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
			if (myMailbox && myMailbox !== label) {
				try { fs.unlinkSync(peerFile(myMailbox)); } catch {}
			}
			myMailbox = sanitize(label);
			writePresence();
			if (ctx.hasUI) {
				ctx.ui.setStatus("mailbox", `mailbox: ${myMailbox}`);
			}
			ctx.ui.notify(`Mailbox set to ${myMailbox}`, "info");
			try {
				pi.setSessionName(myMailbox);
			} catch {}
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
			const res = sendMessage(head, rest, 0);
			if (res.ok) {
				ctx.ui.notify(`Sent to @${head}`, "info");
			} else {
				ctx.ui.notify(`Send failed: ${res.error}`, "error");
			}
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
		description: "Show messages waiting in your mailbox",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			drainInbox(pi);
			try {
				const raw = fs.readFileSync(boxFile(myMailbox ?? ""), "utf8").trim();
				if (!raw) {
					ctx.ui.notify("Inbox empty", "info");
					return;
				}
				const lines = raw.split("\n");
				const decoded = lines.map((l) => {
					const parts = l.split("\t");
					return `From @${parts[1]}: ${decodeBody(parts.slice(3).join("\t"))}`;
				});
				ctx.ui.notify(`Inbox:\n${decoded.join("\n")}`, "info");
			} catch {
				ctx.ui.notify("Inbox empty", "info");
			}
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
			ctx.ui.notify(`Auto-reply is now ${autoReplyEnabled ? "ON" : "OFF"}`, "info");
		},
	});

	// --- LLM Tools (Claude Code style) ---

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
			const res = sendMessage(params.peer, params.message, 0);
			if (!res.ok) {
				return {
					content: [{ type: "text", text: `Failed to send to ${params.peer}: ${res.error}` }],
					isError: true,
				};
			}
			if (pendingReplyTo === params.peer) {
				pendingReplyTo = null;
			}
			return {
				content: [{ type: "text", text: `Message sent to @${params.peer}.` }],
			};
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
				return {
					content: [{ type: "text", text: "No other active sessions currently reachable." }],
				};
			}
			return {
				content: [{ type: "text", text: `Available sessions: ${peers.map((p) => `@${p}`).join(", ")}` }],
			};
		},
	});

	startWatcher(pi);
}
