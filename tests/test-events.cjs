const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");

const stub = makeStub([]);
Module._load = ((orig) => (r, p, m) => (r === "obsidian" ? stub : orig(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };

const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; } catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

(async () => {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n");
  v.addFile("Daily/2026-08-17.md", "[[Sam]]\n");
  v.addFile("Notes/Unrelated.md", "# Nothing to do with people\n");
  v.addFile("Notes/Tagged.md", "---\ntags:\n  - person\n---\n");

  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = {
    configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], personTags: ["person"],
    journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }],
  };
  await plugin.onload();
  plugin.engine.rebuild();

  const get = (p) => v.app.vault.getAbstractFileByPath(p);
  check("person note affects the index", () => assert.strictEqual(plugin.engine.affectsIndex(get("People/Sam.md")), true));
  check("dated note affects the index", () => assert.strictEqual(plugin.engine.affectsIndex(get("Daily/2026-08-17.md")), true));
  check("unrelated note does NOT trigger a rebuild", () => assert.strictEqual(plugin.engine.affectsIndex(get("Notes/Unrelated.md")), false));
  check("note that gained a person tag DOES trigger", () => assert.strictEqual(plugin.engine.affectsIndex(get("Notes/Tagged.md")), true));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
