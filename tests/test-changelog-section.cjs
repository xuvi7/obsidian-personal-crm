/** The release-notes extractor: gets the right section, and refuses bad input. */
const { execFileSync } = require("child_process");
const assert = require("assert");
const path = require("path");
const REPO = path.join(process.env.HOME, "Repos/obsidian-personal-crm");
const run = (v) => execFileSync("node", ["scripts/changelog-section.mjs", v],
  { cwd: REPO, encoding: "utf8" });
const fails = (v) => { try { run(v); return false; } catch { return true; } };

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

const v130 = run("1.3.0");
check("returns the requested version's content", () =>
  assert.ok(v130.includes("bounded, scrollable box"), v130.slice(0, 120)));
check("stops before the previous version", () =>
  assert.ok(!/^##\s/m.test(v130), "leaked another version heading"));
check("omits its own heading (the release title is the tag)", () =>
  assert.ok(!v130.startsWith("## 1.3.0")));
check("older versions still extract", () => {
  assert.ok(run("1.1.0").includes("Mentions that record an intention"));
  assert.ok(run("1.2.0").includes("declarative settings"));
});
check("the last section in the file extracts to end-of-file", () =>
  assert.ok(run("1.0.0").includes("Initial version")));
check("an unknown version fails rather than producing empty notes", () =>
  assert.ok(fails("9.9.9")));
check("a malformed version fails", () => assert.ok(fails("not-a-version")));
check("no argument fails", () => assert.ok(fails("")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
