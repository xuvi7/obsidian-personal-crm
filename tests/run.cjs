#!/usr/bin/env node
/**
 * Runs every suite in this directory.
 *
 * Each `test-*.cjs` is a standalone script with its own `check()` helper and a nonzero
 * exit code on failure — deliberately not a framework. They boot the real plugin
 * against a fake vault that stores real text and computes a metadata cache with link
 * offsets, so they are integration tests; a runner would add configuration without
 * adding an assertion.
 *
 * Set PRM_TEST_VAULT to a real Obsidian vault to additionally run the checks that
 * assert against real data. Without it those blocks skip.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const harness = require("./build.cjs");

const suites = fs
	.readdirSync(__dirname)
	.filter((f) => f.startsWith("test-") && f.endsWith(".cjs"))
	.sort();

// Built once, up front, so a failure here isn't mistaken for a test failure.
process.stdout.write("building from src… ");
harness.buildOnce();
console.log("ok");
if (!harness.realVault()) {
	console.log("PRM_TEST_VAULT unset — real-vault assertions will skip\n");
}

let failed = [];
for (const suite of suites) {
	const label = suite.replace(/\.cjs$/, "").padEnd(24);
	try {
		// stderr captured, not inherited: several suites deliberately exercise error
		// paths and log to stderr, which would otherwise look like failures.
		const out = execFileSync(process.execPath, [path.join(__dirname, suite)], {
			encoding: "utf8",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const summary = out.trimEnd().split("\n").pop() ?? "";
		console.log(`  ✓ ${label} ${summary}`);
	} catch (err) {
		const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
		console.log(`  ✗ ${label}`);
		// Only the failing lines, so one broken suite doesn't bury the rest.
		for (const line of out.split("\n")) {
			if (/✗|Error|error|failed/.test(line)) console.log(`      ${line.trim()}`);
		}
		failed.push(suite);
	}
}

console.log();
if (failed.length > 0) {
	console.error(`${failed.length} of ${suites.length} suites failed: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`${suites.length} suites passed.`);
