/** Verifies the real data.json from the installed plugin migrates correctly. */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");

const notices = [];
const stub = makeStub(notices);
Module._load = ((orig) => (r, p, m) => (r === "obsidian" ? stub : orig(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };

const VAULT = harness.realVault();
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  \u2713 ${n}`); passed++; }
  catch (e) { console.error(`  \u2717 ${n}\n     ${e.message}`); failed++; } };

// The v1.0 shape that was actually sitting in the vault.
const OLD = {
  peopleFolder: "Atlas/People",
  journalFolders: ["Calendar/Journal"],
  requireTag: false,
  personTag: "people",
  tiers: [
    { id: "inner", label: "Inner circle", cadenceDays: 14, color: "#e0567a" },
    { id: "close", label: "Close", cadenceDays: 30, color: "#e8913a" },
    { id: "casual", label: "Casual", cadenceDays: 90, color: "#3aa0e8" },
    { id: "warm", label: "Keep warm", cadenceDays: 180, color: "#8b7ce8" },
    { id: "dormant", label: "Dormant", cadenceDays: 365, color: "#7c8b8f" },
  ],
  defaultTierId: "casual",
  dueSoonWindowDays: 7,
  nextUpCount: 5,
  bodyLogHeading: "Contact Log",
};

(async () => {
  const v = makeVault();
  // A decoy "People" folder that first-run detection would prefer if it ran.
  v.addFile("People/Decoy.md", "---\ntags:\n  - people\n---\n");
  v.addFile("Atlas/People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n");
  v.addFile("Calendar/Journal/2026-08-17.md", "saw [[Sam]]\n");

  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = JSON.parse(JSON.stringify(OLD));
  await plugin.onload();

  check("peopleFolder → personFolders", () =>
    assert.deepStrictEqual(plugin.settings.personFolders, ["Atlas/People"]));
  check("journalFolders → journalSources with a default format", () =>
    assert.deepStrictEqual(plugin.settings.journalSources, [
      { folder: "Calendar/Journal", format: "YYYY-MM-DD" },
    ]));
  check("marked configured, so first-run detection does NOT override", () =>
    assert.strictEqual(plugin.settings.configured, true));
  check("first-run detection did not steal the decoy People folder", () =>
    assert.ok(!plugin.settings.personFolders.includes("People")));
  check("custom tiers preserved", () =>
    assert.strictEqual(plugin.settings.tiers.length, 5));
  check("existing bodyLogHeading preserved", () =>
    assert.strictEqual(plugin.settings.bodyLogHeading, "Contact Log"));
  check("new settings take their defaults", () => {
    assert.strictEqual(plugin.settings.ignoreIntentLinks, true);
    assert.strictEqual(plugin.settings.allowFallbackDateFormats, true);
    assert.strictEqual(plugin.settings.journalDateKey, "date");
  });

  plugin.engine.rebuild();
  check("indexing still works after migration", () => {
    assert.ok(plugin.engine.get("Atlas/People/Sam.md"));
    assert.strictEqual(plugin.engine.get("Atlas/People/Sam.md").lastContact, "2026-08-17");
  });

  // A genuinely fresh install should detect instead.
  const v2 = makeVault();
  v2.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n");
  v2.addFile("Daily/2026-08-17.md", "x\n");
  const fresh = new PluginClass(v2.app, { id: "personal-crm" });
  fresh.__data = null;
  await fresh.onload();
  check("fresh install detects a People folder", () =>
    assert.deepStrictEqual(fresh.settings.personFolders, ["People"]));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
