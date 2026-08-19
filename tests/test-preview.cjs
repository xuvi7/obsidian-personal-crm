/**
 * previewBody() against every real person note (read-only): correctness of the
 * stripping, plus its cost, since it runs on each preview render.
 */
const harness = require("./build.cjs");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
global.window = { setTimeout, clearTimeout };
global.document = { createElement: () => ({ appendChild(){}, classList:{add(){}}, setAttribute(){}, dataset:{} }),
  createElementNS: () => ({ appendChild(){}, classList:{add(){}}, setAttribute(){}, dataset:{} }),
  getElementById: () => null };
// modals.ts imports obsidian; install the shared stub before loading it, as every
// other suite does. This previously loaded a pre-built bundle that happened not to
// need it.
const Module = require("module");
const { makeStub } = require("./stub-obsidian.cjs");
const stub = makeStub([]);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);

const { previewBody: raw } = require(harness.bundleModule("src/modals.ts"));
// previewBody now reports empty sections too; most assertions only want the text.
const previewBody = (md) => raw(md).text;
const previewFull = raw;

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

console.log("Stripping behaviour");
const template = `---
creation date: 2025-08-26T01:56:43-04:00
tags:
  - people
---
up:: [[People MOC]]

# Facts
- First met: <% tp.file.cursor() %>
# Thoughts
`;
check("a note straight from the template previews as empty", () =>
  assert.strictEqual(previewBody(template), ""));
check("and it names the sections that are empty, so the message can explain", () =>
  assert.deepStrictEqual(previewFull(template).emptySections, ["Facts", "Thoughts"]));

const withContent = template.replace("# Thoughts\n",
  "# Thoughts\n- easy to talk to, we should climb more\n");
check("real content is kept, and its heading with it", () => {
  const out = previewBody(withContent);
  assert.ok(out.includes("easy to talk to"), out);
  assert.ok(out.includes("# Thoughts"), out);
});
check("the empty Facts heading is dropped", () =>
  assert.ok(!previewBody(withContent).includes("# Facts"), previewBody(withContent)));
check("frontmatter and up:: are gone", () => {
  const out = previewBody(withContent);
  assert.ok(!out.includes("creation date"));
  assert.ok(!out.includes("up::"));
});
check("unfilled template syntax is gone", () =>
  assert.ok(!/<%|%>/.test(previewBody(withContent))));
check("a filled-in value is kept", () => {
  const out = previewBody(template.replace("<% tp.file.cursor() %>", "at the climbing gym, 2024"));
  assert.ok(out.includes("at the climbing gym, 2024"), out);
  assert.ok(out.includes("# Facts"), out);
});
check("a nested list under a heading counts as content", () => {
  const out = previewBody("# Thoughts\n- a\n\t- b\n");
  assert.ok(out.includes("# Thoughts") && out.includes("- a"), out);
});
check("prose with a colon is not mistaken for an empty label", () => {
  const out = previewBody("# Thoughts\n- note: he mentioned the new job\n");
  assert.ok(out.includes("he mentioned the new job"), out);
});

check("an appended log section does not revive an empty heading above it", () => {
  const base = "up:: [[People MOC]]\n\n# Facts\n- First met: \n# Thoughts\n";
  const withLog = base + "\n## Contact log\n- [[2026-08-17]] — caught up\n";
  const out = previewBody(withLog);
  assert.ok(!out.includes("# Thoughts"), `Thoughts should be gone:\n${out}`);
  assert.ok(out.includes("Contact log") && out.includes("caught up"), out);
});
check("a heading keeps its own content even with a subsection after it", () => {
  const out = previewBody("# Thoughts\n- a real thought\n## Contact log\n- [[2026-08-17]]\n");
  assert.ok(out.includes("# Thoughts") && out.includes("a real thought"), out);
  assert.ok(out.includes("Contact log"), out);
});

console.log("\nAgainst the real vault (read-only)");
// Opt-in: set PRM_TEST_VAULT to assert against a real vault's person notes.
const vault = harness.realVault();
const PEOPLE = vault ? path.join(vault, "Atlas/People") : null;
if (PEOPLE && fs.existsSync(PEOPLE)) {
  const files = fs.readdirSync(PEOPLE).filter(f => f.endsWith(".md") && !f.includes("excalidraw"));
  const notes = files.map(f => fs.readFileSync(path.join(PEOPLE, f), "utf8"));

  // Warm, then measure.
  for (const n of notes) previewBody(n);
  const t = performance.now();
  const outs = notes.map(previewBody);
  const ms = performance.now() - t;

  const empty = outs.filter(o => o.length === 0).length;
  const residue = outs.filter(o => /<%|%>|\{\{/.test(o)).length;
  const bytesIn = notes.reduce((a, n) => a + n.length, 0);
  const bytesOut = outs.reduce((a, o) => a + o.length, 0);

  console.log(`     ${files.length} notes · ${(bytesIn/1024).toFixed(0)} KB in -> ${(bytesOut/1024).toFixed(0)} KB shown`);
  console.log(`     ${empty} preview as empty (template-only) · ${outs.length - empty} have content`);
  console.log(`     total ${ms.toFixed(2)}ms for all ${files.length}, ${(ms/files.length*1000).toFixed(0)}µs each`);

  check("no template residue survives on any real note", () => assert.strictEqual(residue, 0));
  check("per-note cost is well under a frame", () => assert.ok(ms/files.length < 1, `${ms/files.length}ms`));
  check("stripping actually reduces what is shown", () => assert.ok(bytesOut < bytesIn));

  const worst = notes.reduce((a, b) => (b.length > a.length ? b : a));
  const t2 = performance.now();
  for (let i = 0; i < 200; i++) previewBody(worst);
  const per = (performance.now() - t2) / 200;
  console.log(`     largest note (${(worst.length/1024).toFixed(1)} KB): ${per.toFixed(3)}ms per call`);
  check("largest real note stays sub-millisecond", () => assert.ok(per < 1, `${per}ms`));

  // Guard against the O(headings x lines) scan degrading on a pathological note.
  const pathological = Array.from({length: 400}, (_, i) => `# H${i}\n` + "text\n".repeat(20)).join("");
  const t3 = performance.now();
  previewBody(pathological);
  const bigMs = performance.now() - t3;
  console.log(`     synthetic 400-heading / 8k-line note: ${bigMs.toFixed(2)}ms`);
  check("pathological note stays under one frame", () => assert.ok(bigMs < 16, `${bigMs}ms`));
} else {
  console.log("     (vault not found, skipped)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
