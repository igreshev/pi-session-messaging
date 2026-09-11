# Integration harness

Boots the real extension in two/three forked node processes behind a stub pi
host and exercises the file transport end to end.

```bash
npx esbuild ../extensions/index.ts --bundle --format=esm --platform=node \
  --external:node:* --alias:typebox=./typebox-stub.js --outfile=./plugin.mjs
node run.mjs
```

Covers: spool permissions (0700), peer discovery, multi-line/tab/code-fence
integrity, unknown-peer rejection, auto-reply off by default, auto-reply
round trip, local-prompt disarm (no answer leaks to a peer), 200 concurrent
messages with zero loss, duplicate identical messages, legacy `.in` + orphan
spool sweep, and presence cleanup on shutdown.
