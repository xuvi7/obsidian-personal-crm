/** Does the calendar view actually open? Drives the real class, not a mock. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout,
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };

const V = require(harness.bundleModule("src/calendar-view.ts"));
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

async function boot() {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n");
  v.addFile("Daily/2026-08-01.md", "saw [[Sam]]\n");
  v.addFile("Daily/2026-07-01.md", "saw [[Sam]]\n");
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = { configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] };
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Opening the view");
  const { plugin } = await boot();
  const leaf = { view: null };
  let view;
  check("the view constructs", () => {
    view = new V.PrmCalendarView(leaf, plugin);
  });
  check("it reports its type and title", () => {
    assert.strictEqual(view.getViewType(), "prm-calendar");
    assert.ok(view.getDisplayText().length > 0);
    assert.ok(view.getIcon().length > 0);
  });
  check("onOpen does not throw", async () => {
    // ItemView's contentEl comes from Obsidian; the stub gives the same shape.
    await view.onOpen();
  });
  await view.onOpen();

  check("it builds a grid", () => {
    const cells = view.contentEl.querySelectorAll(".prm-cal-cell");
    assert.ok(cells.length > 300, `${cells.length} cells`);
  });
  check("all four scales render", () => {
    for (const scale of ["day", "week", "month", "year"]) {
      view.scale = scale;
      view.render();
      assert.ok(view.contentEl.querySelectorAll(".prm-cal-cell").length > 0, scale);
    }
  });
  check("focusing one person works", () => {
    view.showPerson("People/Sam.md");
    assert.strictEqual(view.focus, "People/Sam.md");
    view.showPerson(null);
  });
  check("onClose does not throw", async () => { await view.onClose(); });

  console.log("\nThe plugin's entry points");
  check("openCalendar is on the plugin", () =>
    assert.strictEqual(typeof plugin.openCalendar, "function"));
  check("so is the person picker", () =>
    assert.strictEqual(typeof plugin.pickPersonForCalendar, "function"));
  check("openCalendar does not throw", async () => { await plugin.openCalendar(); });
  await plugin.openCalendar();
  await plugin.openCalendar("People/Sam.md");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
