// Bundles the extension, then runs every suite.
import { execFileSync } from "node:child_process";
const here = new URL(".", import.meta.url).pathname;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: here, stdio: "inherit" });
run("npx", ["--yes", "esbuild", "../extensions/index.ts", "--bundle", "--format=esm", "--platform=node",
  "--external:node:*", "--alias:typebox=./typebox-stub.js", "--outfile=./plugin.mjs"]);
run("node", ["presence.mjs"]);
run("node", ["run.mjs"]);
