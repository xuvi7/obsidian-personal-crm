/**
 * Verifies the declarative settings tab: every control key declared in
 * getSettingDefinitions() must resolve through getControlValue and round-trip
 * through setControlValue. A typo in a dotted key would otherwise silently read
 * nothing and be invisible until a user opened that field.
 */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");

const notices = [];
const stub = makeStub(notices);
Module._load = ((orig) => (r, p, m) => (r === "obsidian" ? stub : orig(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };

const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; } catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

/** Flatten the definition tree into leaf definitions. */
function walk(items, out = []) {
  for (const item of items ?? []) {
    if (item && (item.type === "group" || item.type === "list" || item.type === "page")) {
      out.push({ container: item });
      walk(item.items, out);
    } else if (item) {
      out.push({ leaf: item });
    }
  }
  return out;
}

const EXPECTED_TYPE = {
  toggle: "boolean", text: "string", textarea: "string", dropdown: "string",
  folder: "string", file: "string", color: "string", number: "number", slider: "number",
};

(async () => {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n");
  v.addFile("Daily/2026-08-17.md", "saw [[Sam]]\n");

  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = { configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] };
  await plugin.onload();
  plugin.engine.rebuild();

  // The tab the plugin registered.
  const TabClass = plugin.__tab;
  assert.ok(TabClass, "settings tab was not captured");
  const tab = TabClass;

  const defs = tab.getSettingDefinitions();
  check("getSettingDefinitions returns a non-empty array (so display() is bypassed)", () => {
    assert.ok(Array.isArray(defs) && defs.length > 0, `got ${JSON.stringify(defs).slice(0,80)}`);
  });

  const nodes = walk(defs);
  const leaves = nodes.filter((n) => n.leaf).map((n) => n.leaf);
  const controls = leaves.filter((l) => l.control);
  const actions = leaves.filter((l) => l.action);

  console.log(`     ${defs.length} top-level items · ${controls.length} controls · ${actions.length} actions`);

  check("every definition has a name", () => {
    for (const l of leaves) assert.ok(typeof l.name === "string" && l.name.length > 0, JSON.stringify(l).slice(0,120));
  });

  check("every control key resolves to the right type", () => {
    for (const c of controls) {
      const { type, key } = c.control;
      const val = tab.getControlValue(key);
      const want = EXPECTED_TYPE[type];
      assert.ok(want, `unknown control type ${type}`);
      assert.strictEqual(typeof val, want,
        `key "${key}" (${type}) returned ${typeof val} (${JSON.stringify(val)}), expected ${want}`);
    }
  });

  check("no duplicate control keys", () => {
    const seen = new Set();
    for (const c of controls) {
      assert.ok(!seen.has(c.control.key), `duplicate key ${c.control.key}`);
      seen.add(c.control.key);
    }
  });

  check("every control key round-trips through setControlValue", () => {
    for (const c of controls) {
      const { type, key } = c.control;
      const before = tab.getControlValue(key);
      let probe;
      if (type === "toggle") probe = !before;
      else if (type === "number" || type === "slider") probe = Math.max(c.control.min ?? 1, 3);
      else if (type === "dropdown") probe = Object.keys(c.control.options)[0];
      else if (type === "color") probe = "#123456";
      else probe = "probe-value";
      tab.setControlValue(key, probe);
      const after = tab.getControlValue(key);
      if (type === "folder") {
        // Folder values are normalized on write.
        assert.strictEqual(after, "probe-value", `${key}: got ${JSON.stringify(after)}`);
      } else if (typeof probe === "string" && key.endsWith("Csv")) {
        assert.strictEqual(after, "probe-value", `${key}: got ${JSON.stringify(after)}`);
      } else {
        assert.deepStrictEqual(after, probe, `${key}: wrote ${JSON.stringify(probe)}, read ${JSON.stringify(after)}`);
      }
      tab.setControlValue(key, before);
    }
  });

  check("CSV keys split and rejoin", () => {
    tab.setControlValue("personTagsCsv", "#person, people/friend , ");
    assert.deepStrictEqual(plugin.settings.personTags, ["person", "people/friend"], JSON.stringify(plugin.settings.personTags));
    assert.strictEqual(tab.getControlValue("personTagsCsv"), "person, people/friend");
  });

  check("indexed tier keys address the right tier", () => {
    tab.setControlValue("tiers.1.label", "Renamed");
    assert.strictEqual(plugin.settings.tiers[1].label, "Renamed");
    assert.strictEqual(tab.getControlValue("tiers.1.label"), "Renamed");
    tab.setControlValue("tiers.1.cadenceDays", 45);
    assert.strictEqual(plugin.settings.tiers[1].cadenceDays, 45);
  });

  check("cadence rejects values below 1", () => {
    const before = plugin.settings.tiers[0].cadenceDays;
    tab.setControlValue("tiers.0.cadenceDays", 0);
    assert.strictEqual(plugin.settings.tiers[0].cadenceDays, before, "0 should be rejected");
  });

  check("journal source keys address folder and format separately", () => {
    tab.setControlValue("journalSources.0.format", "DD-MM-YYYY");
    assert.strictEqual(plugin.settings.journalSources[0].format, "DD-MM-YYYY");
    tab.setControlValue("journalSources.0.folder", "Journal\\Old");
    assert.strictEqual(plugin.settings.journalSources[0].folder, "Journal/Old", "backslash should normalize");
  });

  check("out-of-range indices don't throw", () => {
    assert.strictEqual(tab.getControlValue("tiers.99.label"), "");
    assert.strictEqual(tab.getControlValue("journalSources.99.folder"), "");
    tab.setControlValue("tiers.99.label", "x");
    tab.setControlValue("journalSources.99.folder", "x");
  });

  check("list add/delete callbacks mutate and re-render", () => {
    const list = defs.find((d) => d.type === "list" && d.heading === "Tiers");
    assert.ok(list, "tiers list not found");
    const n = plugin.settings.tiers.length;
    list.addItem.action();
    assert.strictEqual(plugin.settings.tiers.length, n + 1, "add failed");
    list.onDelete(plugin.settings.tiers.length - 1);
    assert.strictEqual(plugin.settings.tiers.length, n, "delete failed");
  });

  check("tier reorder moves the entry", () => {
    const list = defs.find((d) => d.type === "list" && d.heading === "Tiers");
    const first = plugin.settings.tiers[0].id;
    list.onReorder(0, 2);
    assert.strictEqual(plugin.settings.tiers[2].id, first);
    list.onReorder(2, 0);
    assert.strictEqual(plugin.settings.tiers[0].id, first);
  });

  check("dated-folder list flags a missing folder as a warning", () => {
    const list = tab.getSettingDefinitions().find((d) => d.type === "list" && d.heading === "Dated note folders");
    const page = list.items[0];
    assert.strictEqual(typeof page.status, "function");
    // Folder was set to Journal/Old above, which doesn't exist in this vault.
    assert.strictEqual(page.status(), "warning");
  });

  check("visible() predicates evaluate without throwing", () => {
    for (const l of leaves) {
      if (typeof l.visible === "function") l.visible();
      if (typeof l.disabled === "function") l.disabled();
      if (l.control && typeof l.control.disabled === "function") l.control.disabled();
    }
  });

  check("validate() functions behave", () => {
    for (const c of controls) {
      const val = c.control.validate;
      if (typeof val !== "function") continue;
      if (c.control.type === "number") {
        assert.ok(val(0), `${c.control.key}: 0 should be rejected`);
        assert.ok(!val(30), `${c.control.key}: 30 should be accepted`);
      } else {
        assert.ok(val("  "), `${c.control.key}: blank should be rejected`);
        assert.ok(!val("something"), `${c.control.key}: value should be accepted`);
      }
    }
  });

  check("status definition builds a description without throwing", () => {
    const status = defs[0];
    assert.strictEqual(status.name, "Status");
    assert.ok(status.desc, "no desc fragment");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error("SUITE ERROR:", e.stack); process.exit(1); });
