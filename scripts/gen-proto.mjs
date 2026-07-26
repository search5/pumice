#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

mkdirSync(path.join(root, "src", "generated"), { recursive: true });

const protocGenJs = path.join(root, "node_modules", ".bin", "protoc-gen-js");
const protocGenGrpcWeb = path.join(
  root,
  "bin",
  process.platform === "win32" ? "protoc-gen-grpc-web.exe" : "protoc-gen-grpc-web",
);

const args = [
  `--plugin=protoc-gen-js=${protocGenJs}`,
  "--js_out=import_style=commonjs,binary:./src/generated",
  `--plugin=protoc-gen-grpc-web=${protocGenGrpcWeb}`,
  // mode=grpcweb (binary), not grpcwebtext: the latter base64-encodes every request/response
  // body, inflating every byte transferred by ~33% plus encode/decode CPU cost, on every RPC
  // (Delta's full local-file-metadata list, every download, the batched-upload fallback) --
  // pumice-server's grpc_web_resource.py already negotiates text vs. binary per-request from the
  // Content-Type header, so this needs no server-side change.
  "--grpc-web_out=import_style=typescript,mode=grpcweb:./src/generated",
  "--proto_path=.",
  "sync.proto",
];

const result = spawnSync("protoc", args, { cwd: root, stdio: "inherit" });

if (result.error && result.error.code === "ENOENT") {
  console.error(
    "[gen-proto] `protoc` was not found on your PATH. Install it (verified with 3.21.12) " +
      "and re-run `npm run proto:gen`.",
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error("[gen-proto] protoc failed. See output above.");
  process.exit(result.status ?? 1);
}

// protoc-gen-js emits sync_pb.js paired with a real, hand-off-worthy sync_pb.d.ts, but
// protoc-gen-grpc-web's TypeScript mode emits only SyncServiceClientPb.ts (implementation and
// types in one file, nothing separate to hand off). Deriving a matching .d.ts here via
// `tsc --declaration --emitDeclarationOnly` gives that file the same shape as sync_pb.d.ts: a
// type-only declaration that's committed (see .gitignore) so external tools that lint/typecheck
// this repo without running `npm install`/generation first can still resolve real types for
// `import { SyncServiceClient } from "./generated/SyncServiceClientPb"` -- instead of every
// pb.*/SyncServiceClient reference collapsing to `any` and cascading into hundreds of unrelated
// no-unsafe-* findings, which is what happened when neither the .ts nor a .d.ts was present.
const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const declResult = spawnSync(
  tsc,
  [
    "--declaration",
    "--emitDeclarationOnly",
    "--skipLibCheck",
    "--moduleResolution", "bundler",
    "--module", "ESNext",
    "--target", "ES2022",
    "--outDir", "src/generated",
    "src/generated/SyncServiceClientPb.ts",
  ],
  { cwd: root, stdio: "inherit" },
);

if (declResult.status !== 0) {
  console.error("[gen-proto] Failed to derive SyncServiceClientPb.d.ts. See output above.");
  process.exit(declResult.status ?? 1);
}

console.log("[gen-proto] Generated src/generated/ from sync.proto.");
