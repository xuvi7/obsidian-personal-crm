/**
 * Builds the plugin from `src/` and returns the path to the bundle.
 *
 * Every suite loads the plugin through here. They used to `require()` the built
 * `main.js` out of the author's own Obsidian vault, which meant the tests could not
 * run on another machine or in CI — and, worse, could pass against **stale code**:
 * edit `src/`, run the suite, and get a green result about the last build that
 * happened to be deployed. Building here makes staleness structurally impossible.
 *
 * Not minified, so a stack trace points somewhere useful.
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(__dirname, ".build");
const bundle = path.join(outDir, "main.js");

let built = false;

/** Build once per process, however many suites ask for it. */
function buildOnce() {
	if (built) return bundle;
	fs.mkdirSync(outDir, { recursive: true });
	// The repo is `"type": "module"`, so a `.js` file inside it is parsed as ESM — and
	// the plugin bundle is CommonJS. This scopes just this directory back to CJS so
	// `require()` works. It used to work by accident: the bundle was loaded from the
	// vault, which has no package.json to inherit.
	fs.writeFileSync(
		path.join(outDir, "package.json"),
		JSON.stringify({ type: "commonjs", private: true }, null, "\t") + "\n",
	);
	execSync(`node esbuild.config.mjs once`, {
		cwd: repoRoot,
		env: { ...process.env, PRM_OUT_DIR: outDir },
		stdio: ["ignore", "ignore", "inherit"],
	});
	if (!fs.existsSync(bundle)) {
		throw new Error(`build produced no bundle at ${bundle}`);
	}
	built = true;
	return bundle;
}

/** The built plugin's default export (the Plugin class). */
function loadPlugin() {
	const mod = require(buildOnce());
	return mod.default ?? mod;
}

/**
 * Bundle a single module for direct testing, so a suite can drive a pure function
 * without going through the plugin class.
 */
function bundleModule(relativeSourcePath) {
	fs.mkdirSync(outDir, { recursive: true });
	const name = path.basename(relativeSourcePath).replace(/\.ts$/, ".cjs");
	const out = path.join(outDir, name);
	execSync(
		`npx esbuild ${JSON.stringify(path.join(repoRoot, relativeSourcePath))} ` +
			`--bundle --format=cjs --platform=node --external:obsidian ` +
			`--outfile=${JSON.stringify(out)} --log-level=warning`,
		{ cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] },
	);
	return out;
}

/**
 * The author's real vault, for the handful of checks that assert against real data.
 * Opt-in through an env var: those assertions are valuable locally and must skip
 * cleanly everywhere else, and the path is nobody else's business.
 */
function realVault() {
	const dir = process.env.PRM_TEST_VAULT;
	if (!dir || !fs.existsSync(dir)) return null;
	return dir;
}

module.exports = { repoRoot, outDir, buildOnce, loadPlugin, bundleModule, realVault };
