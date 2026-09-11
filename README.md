# pi-session-messaging 📬

> Peer-to-peer, cross-session messaging for [Pi CLI](https://github.com/earendil-works/pi-coding-agent) — inspired by Claude Code's cross-session collaboration.

Exchange messages between separate active `pi` terminal sessions with zero servers, zero network dependencies, and full multi-line markdown support.

[![pi-package](https://img.shields.io/badge/pi--package-ready-blue.svg)](https://pi.dev/packages)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/igreshev/pi-session-messaging/actions/workflows/ci.yml/badge.svg)](https://github.com/igreshev/pi-session-messaging/actions/workflows/ci.yml)

---

## ✨ Features

- ⚡ **Zero-Server P2P IPC**: Communicates directly through local filesystem mailboxes (`~/.pi/messages/`). Fast, secure, and offline.
- 🛡️ **Guaranteed Delivery Queueing**: Uses `deliverAs: "followUp"` so incoming messages are never dropped or rejected, even while the recipient agent is busy running shell tools or streaming responses.
- 📜 **Full Multi-Line & Markdown Integrity**: Payloads travel as JSON envelopes in one-file-per-message spools, written temp-then-rename so delivery is atomic and concurrent senders never clobber each other. Indentation, code blocks, tables and emojis survive intact.
- 🔒 **Owner-Private Spool**: `~/.pi/messages` is created `0700` (files `0600`) and ownership-checked, since incoming text is injected into the agent as a user message.
- 🤖 **Claude Code-Style Agent Tools**: Your AI agent can autonomously discover peers and message them (`list_session_peers`, `send_session_message`).
- 💬 **Human TUI Commands**: Direct user commands to message sessions, rename mailboxes, list active peers, or view buffered inboxes (`/send`, `/peers`, `/mset`, `/inbox`).
- 🛑 **Safe Auto-Reply**: Off by default (`/autoreply on`), capped chain depth, and correlated to the turn the incoming message actually triggered — a locally typed prompt disarms it, so your own answers never leak to a peer.
- 🧹 **Dead-Peer Self-Pruning**: Uses OS-level process checks (`process.kill(pid, 0)`) to instantly clean up stale peer records when a terminal window is closed.

---

## 📦 Installation

Install directly into your global Pi CLI settings via git:

```bash
pi install git:github.com/igreshev/pi-session-messaging
```

Or pin to a release (pinned refs are skipped by `pi update --extensions`):

```bash
pi install git:github.com/igreshev/pi-session-messaging@v1.2.0
```

Or test it temporarily for the current run only:

```bash
pi -e git:github.com/igreshev/pi-session-messaging
```

---

## 🚀 Quickstart

Open two terminal tabs running `pi`.

### Terminal 1
```text
/mset backend
```

### Terminal 2
```text
/mset frontend
```

### Send a message between them:

From `frontend`:
```text
/send backend What port is the API server running on?
```

`backend` receives the message and its agent is told how to route an answer back to `frontend`. Turn on `/autoreply` in `backend` if you want its replies forwarded automatically instead.

> **Auto-reply is off by default.** Each chained turn costs tokens in *both* sessions, so opt in per session with `/autoreply on` (chains are capped at 4 turns).

---

## 🛠 Command & Tool Reference

### 1. User Commands (Terminal TUI)

| Command | Usage | Description |
|---|---|---|
| `/peers` | `/peers` | Lists all reachable, active Pi sessions on this machine (e.g. `@backend`, `@frontend`). |
| `/send` | `/send <peer> <message>` | Sends a message directly to another session. |
| `/mset` | `/mset <name>` | Sets a friendly name for the current session (defaults to `sess-<PID>`). |
| `/inbox` | `/inbox` | Peeks at messages still waiting in your local mailbox, without consuming them. |
| `/autoreply` | `/autoreply on\|off` | Toggles automatic response forwarding (off by default; chains are depth-capped). |

### 2. AI Agent Tools (Claude Code-Style)

When an agent needs to collaborate with another session, it can use the built-in tools:

* **`list_session_peers`**: Discover active peer sessions running on the machine.
* **`send_session_message`**: Send a message to another session directly.
  - `peer`: Target session name (e.g. `"backend"`)
  - `message`: Text content to send

Both tools reject unknown or dead peers instead of writing into a mailbox nobody reads. Incoming messages arrive with an explicit routing hint, so the receiving agent answers *through the tool* rather than into its own terminal:

```text
[message from @frontend] What port is the API server running on?

(To answer @frontend, call send_session_message with peer="frontend". Text you write here is NOT visible to them.)
```

The hint is omitted when `/autoreply` is on, or when the message is itself an auto-reply.

```text
User: "Ask the backend session what database migrations have run."
Agent: calls send_session_message(peer: "backend", message: "What migrations have been applied?")
```

---

## 🏗 How It Works

```text
 Terminal 1 (Alice)                         Terminal 2 (Bob)
┌──────────────────┐                       ┌──────────────────┐
│  /send bob ...   │                       │  (Receives Turn) │
└────────┬─────────┘                       └────────▲─────────┘
         │                                          │
         │ writes to ~/.pi/messages/bob.d/          │ drains bob.d/
         ▼                                          │
┌───────────────────────────────────────────────────┴─────────┐
│              Local Mailbox Directory (~/.pi/messages/)      │
│  ├── alice.peer (PID heartbeat)                             │
│  ├── bob.peer   (PID heartbeat)                             │
│  ├── alice.d/   (one file per message)                      │
│  └── bob.d/     (one file per message)                      │
└─────────────────────────────────────────────────────────────┘
```

1. **Presence**: Each session publishes a `.peer` heartbeat every 5s, written temp-then-`rename()` so readers never observe a half-written record. The record is versioned and carries a boot-unique token:
   ```text
   v2 <TAB> name <TAB> pid <TAB> host <TAB> boot-token
   ```
   `listPeers()` prunes a peer when its pid is gone (`ESRCH`), when a *live* pid has a stale heartbeat (a recycled pid, not the original session), or — for peers on another host, whose pids cannot be probed — when the heartbeat ages out. `EPERM` counts as alive. Legacy v1 records (`name pid host`) are still read.
2. **Wire Protocol**: Each message is a versioned JSON envelope in its own file:
   ```json
   { "v": 1, "to": "bob", "from": "alice", "depth": 0, "kind": "user", "text": "..." }
   ```
   Senders write `.tmp-*` then `rename()` to `<stamp>.msg`; the receiver claims each file by `rename()` before delivering, so a message is delivered exactly once even with multiple drainers.
3. **Queueing**: Receivers poll their inbox every 1000ms. Injections into Pi use `deliverAs: "followUp"`, guaranteeing execution whether the agent is idle or busy.
4. **Reply correlation**: A pending auto-reply is registered *before* injection and claimed by the matching `input` event, so the answer is tied to the turn that message actually triggered. Typing locally disarms it — your own answers never leak to a peer.
5. **Hygiene**: The spool is created `0700` (files `0600`) and ownership-checked, message size is capped in both directions, and stale spools, legacy `.in` files and orphaned temp files are swept on start. Presence and spool are removed on `session_shutdown`.

---

## 🧪 Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm test            # bundles the extension, runs both suites
```

- `test/run.mjs` — transport suite: spool permissions, discovery, multi-line/tab/emoji/code-fence integrity, unknown-peer rejection, auto-reply on/off, local-prompt disarm, 200 concurrent messages with zero loss, duplicate bodies, legacy sweep, shutdown cleanup.
- `test/presence.mjs` — presence suite: record format, boot token, atomic heartbeat, independent 5s timer, v1 compatibility, dead-pid pruning, pid-reuse detection, cross-host staleness, malformed records.

Both boot the real extension in forked processes behind a stub pi host.

---

## 📄 License

MIT © [Ivo Greshev](https://github.com/igreshev)
