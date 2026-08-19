/**
 * Build the browser harnesses in this directory.
 *
 * Each renders the REAL component against the REAL styles.css, with `obsidian`
 * aliased to a shim. Bundles and the stylesheet copy are gitignored; run this
 * before opening any of the .html files, and again after changing src/.
 *
 *   node tests/ui/build.mjs          # or: npm run ui
 */
import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

// Which shim each bundle gets: the modal shim carries Setting, SuggestModal and
// the rest of the surface the dialogs touch.
const TARGETS = [
	{ entry: "dash-entry.ts", out: "view.bundle.js", global: "PRM", shim: "obsidian-shim.js" },
	{ entry: "calview-entry.ts", out: "calview.bundle.js", global: "PRMCAL", shim: "obsidian-shim.js" },
	{ entry: "modals-entry.ts", out: "modals.bundle.js", global: "PRMM", shim: "obsidian-shim-modals.js" },
	{ entry: "modals-entry.ts", out: "import.bundle.js", global: "PRMI", shim: "obsidian-shim-modals.js" },
];

// The harnesses link ./styles.css, so the real sheet has to sit beside them. A copy
// rather than a symlink: this is what the browser will actually parse.
await copyFile(join(repo, "styles.css"), join(here, "styles.css"));

for (const t of TARGETS) {
	await build({
		entryPoints: [join(here, t.entry)],
		outfile: join(here, t.out),
		bundle: true,
		format: "iife",
		globalName: t.global,
		platform: "browser",
		target: "es2018",
		sourcemap: false,
		logLevel: "warning",
		alias: { obsidian: join(here, t.shim) },
	});
	console.log(`  ${t.out}  (${t.global})`);
}
console.log("harnesses built — open tests/ui/*.html");
