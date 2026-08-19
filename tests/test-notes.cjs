/** Multi-line notes must stay inside the markdown list item they belong to. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");

const notices = [];
const stub = makeStub(notices);
Module._load = ((orig) => (r, p, m) => (r === "obsidian" ? stub : orig(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame: (f)=>setTimeout(f,0), cancelAnimationFrame: clearTimeout };

const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

(async () => {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n# Facts\n- met at a talk\n");
  v.addFile("Daily/2026-08-17.md", "x\n");
  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = { configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] };
  await plugin.onload();
  plugin.engine.rebuild();
  const file = v.app.vault.getAbstractFileByPath("People/Sam.md");

  await plugin.logContact(file, "2026-08-17", "Talked about the new job.\n\nHe's moving to Lisbon in October.\nWants climbing recommendations.");
  const text = v.store.get(file.path);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("- [[2026-08-17]]"));

  check("first line follows the dated bullet", () =>
    assert.strictEqual(lines[start], "- [[2026-08-17]] — Talked about the new job."));
  check("blank line preserved as indented whitespace", () =>
    assert.strictEqual(lines[start + 1], "  "));
  check("later lines indented into the same list item", () => {
    assert.strictEqual(lines[start + 2], "  He's moving to Lisbon in October.");
    assert.strictEqual(lines[start + 3], "  Wants climbing recommendations.");
  });
  check("no continuation line starts a new bullet", () => {
    for (let i = start + 1; i <= start + 3; i++) {
      assert.ok(!/^- /.test(lines[i]), `line ${i} broke the item: ${lines[i]}`);
    }
  });
  check("existing note content untouched", () => assert.ok(text.includes("- met at a talk")));

  // A single-line note keeps the original one-line shape.
  await plugin.logContact(file, "2026-08-16", "quick text");
  check("single-line note unchanged in shape", () =>
    assert.ok(v.store.get(file.path).includes("- 2026-08-16 — quick text"),
      v.store.get(file.path)));

  // No note at all.
  await plugin.logContact(file, "2026-08-15");
  check("no note yields a bare dated bullet", () =>
    assert.ok(/^- 2026-08-15$/m.test(v.store.get(file.path))));

  await plugin.logContact(file, "2026-08-14", "   \n  \n ");
  check("whitespace-only note yields a bare bullet", () =>
    assert.ok(/^- 2026-08-14$/m.test(v.store.get(file.path)), v.store.get(file.path)));

  // Undo must still reverse a multi-line entry exactly.
  const before = v.store.get(file.path);
  await plugin.logContact(file, "2026-08-13", "line one\nline two");
  await plugin.performUndo();
  check("undo reverses a multi-line entry byte-for-byte", () =>
    assert.strictEqual(v.store.get(file.path), before));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error("SUITE ERROR:", e.stack); process.exit(1); });
