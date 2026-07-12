import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

import fs from "fs";

const prod = process.argv[2] === "production";

// Copy sync.proto
try {
  fs.copyFileSync("../proto/sync.proto", "sync.proto");
  console.log("Copied sync.proto successfully.");
} catch (e) {
  console.error("Failed to copy sync.proto:", e);
}


const obsidianPluginPaths = [
  "/home/jiho/Documents/nos/.obsidian/plugins/pumice",
  "/home/jiho/.local/Obsidian/.obsidian/plugins/pumice",
  "/home/jiho/Documents/obs/.obsidian/plugins/pumice"
];

const copyToObsidianPlugin = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd(() => {
      try {
        obsidianPluginPaths.forEach(pluginPath => {
          if (fs.existsSync(pluginPath)) {
            fs.copyFileSync("main.js", `${pluginPath}/main.js`);
            fs.copyFileSync("manifest.json", `${pluginPath}/manifest.json`);
            if (fs.existsSync("sync.proto")) {
              fs.copyFileSync("sync.proto", `${pluginPath}/sync.proto`);
            }
            if (fs.existsSync("styles.css")) {
              fs.copyFileSync("styles.css", `${pluginPath}/styles.css`);
            }
            console.log(`[Plugin Install] Successfully copied build artifacts to: ${pluginPath}`);
          }
        });
      } catch (err) {
        console.error("Failed to copy build artifacts to Obsidian plugin directory:", err);
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@electron/remote",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  platform: "node",
  plugins: [copyToObsidianPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
