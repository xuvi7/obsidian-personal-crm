import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import fs from "fs";
import path from "path";

const banner = `/*
Personal CRM for Obsidian — bundled by esbuild.
Source: obsidian-personal-crm/src
*/`;

const prod = process.argv[2] === "production";
const outDir = process.env.PRM_OUT_DIR || ".";
const installing = path.resolve(outDir) !== path.resolve(".");

if (installing) {
  fs.mkdirSync(outDir, { recursive: true });
}

/** Keep manifest.json and styles.css beside main.js wherever we build. */
function copyAssets() {
  if (!installing) return;
  for (const f of ["manifest.json", "styles.css"]) {
    fs.copyFileSync(f, path.join(outDir, f));
  }
  console.log(`[prm] assets copied to ${outDir}`);
}

const assetPlugin = {
  name: "prm-assets",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyAssets();
    });
  },
};

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
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
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(outDir, "main.js"),
  minify: prod,
  plugins: [assetPlugin],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
  process.exit(0);
} else {
  await ctx.watch();
  console.log("[prm] watching for changes…");
}
