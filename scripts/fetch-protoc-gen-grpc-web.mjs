#!/usr/bin/env node
import { chmodSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION = "1.5.0";
const RELEASE_URL = `https://github.com/grpc/grpc-web/releases/tag/${VERSION}`;

const PLATFORM_MAP = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_MAP = { x64: "x86_64", arm64: "aarch64" };

function assetName() {
  const platform = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];
  if (!platform || !arch) {
    throw new Error(`unsupported platform/arch: ${process.platform}/${process.arch}`);
  }
  const ext = platform === "windows" ? ".exe" : "";
  return `protoc-gen-grpc-web-${VERSION}-${platform}-${arch}${ext}`;
}

function manualFallbackMessage(reason) {
  return (
    `[fetch-protoc-gen-grpc-web] ${reason} Download it manually from ${RELEASE_URL} ` +
    "and place it at bin/protoc-gen-grpc-web (bin/protoc-gen-grpc-web.exe on Windows)."
  );
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const binDir = path.join(__dirname, "..", "bin");
  const destName = process.platform === "win32" ? "protoc-gen-grpc-web.exe" : "protoc-gen-grpc-web";
  const dest = path.join(binDir, destName);

  if (existsSync(dest)) {
    console.log(`[fetch-protoc-gen-grpc-web] ${destName} already present, skipping.`);
    return;
  }

  let name;
  try {
    name = assetName();
  } catch (err) {
    console.warn(manualFallbackMessage(`${err.message}.`));
    return;
  }

  const url = `https://github.com/grpc/grpc-web/releases/download/${VERSION}/${name}`;
  console.log(`[fetch-protoc-gen-grpc-web] Downloading ${url}`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.warn(manualFallbackMessage(`Download failed (${err.message}).`));
    return;
  }

  if (!res.ok) {
    console.warn(manualFallbackMessage(`Download failed (HTTP ${res.status}).`));
    return;
  }

  mkdirSync(binDir, { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
  console.log(`[fetch-protoc-gen-grpc-web] Saved to ${dest}`);
}

main().catch((err) => {
  console.warn(manualFallbackMessage(`Unexpected error (${err.message}).`));
});
