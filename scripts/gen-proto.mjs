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
  "--grpc-web_out=import_style=typescript,mode=grpcwebtext:./src/generated",
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

console.log("[gen-proto] Generated src/generated/ from sync.proto.");
