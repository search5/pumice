#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const marker = path.join(root, "src", "generated", "SyncServiceClientPb.ts");

if (existsSync(marker)) {
  process.exit(0);
}

console.log("[ensure-generated] src/generated/ is missing, running `npm run proto:gen`...");
const result = spawnSync(process.execPath, [path.join(__dirname, "gen-proto.mjs")], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
