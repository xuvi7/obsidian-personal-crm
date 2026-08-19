/** Does the Rebuild index action actually re-derive anything? */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((orig)=>(r,p,m)=>(r==="obsidian"?stub:orig(r,p,m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0), cancelAnimationFrame:clearTimeout };
const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

function findAction(defs, name) {
  for (const d of defs) {
    if (d && d.action && d.name === name) return d;
    for (const kid of (d && d.items) || []) {
      const hit = findAction([kid], name);
      if (hit) return hit;
    }
  }
  return null;
}

(async () => {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n");
  v.addFile("Daily/2026-08-17.md", "saw [[Sam]]\n");
  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = { configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[{folder:"Daily", format:"YYYY-MM-DD"}] };
  await plugin.onload();
  plugin.engine.rebuild();

  const tab = plugin.__tab;
  const action = findAction(tab.getSettingDefinitions(), "Rebuild index");
  check("the Rebuild index action exists in the settings definitions", () =>
    assert.ok(action && typeof action.action === "function"));

  const before = plugin.engine.all().length;
  check("index starts with 1 person", () => assert.strictEqual(before, 1));

  // An out-of-band change: added to the vault with no metadata event fired,
  // which is the situation a manual rebuild is meant to recover from.
  v.addFile("People/Ana.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n");
  check("index is now stale (still 1)", () =>
    assert.strictEqual(plugin.engine.all().length, 1));

  action.action(null, 0);
  check("after pressing Rebuild index it picks up the new person", () =>
    assert.strictEqual(plugin.engine.all().length, 2));

  const updatesBefore = tab.__updates;
  action.action(null, 0);
  check("it also refreshes the settings display (so Status counts update)", () =>
    assert.ok(tab.__updates > updatesBefore, `${updatesBefore} -> ${tab.__updates}`));

  // Diagnostics should reflect the rebuild.
  check("diagnostics reflect the new count", () =>
    assert.strictEqual(plugin.engine.diagnostics().personFilesFound, 2));

  check("it now reports what it found, so pressing it is visibly not a no-op", () => {
    notices.length = 0;
    action.action(null, 0);
    assert.strictEqual(notices.length, 1, `expected one notice, got ${notices.length}`);
    assert.ok(/people/.test(notices[0]), notices[0]);
    assert.ok(/dated notes/.test(notices[0]), notices[0]);
    assert.ok(/interactions/.test(notices[0]), notices[0]);
    assert.ok(/ms$/.test(notices[0]), notices[0]);
  });

  check("the command and the button report identically", () => {
    notices.length = 0;
    plugin.rebuildAndReport();
    const fromCommand = notices[0];
    notices.length = 0;
    action.action(null, 0);
    // Only the timing digits may differ.
    const strip = (s) => s.replace(/\d+ms/, "Xms");
    assert.strictEqual(strip(fromCommand), strip(notices[0]));
  });

  // Does it clear the memoised filename->date results? (Currently: no.)
  const journalStale = (() => {
    // Rename a journal note's date by rewriting the store under a new path.
    v.addFile("Daily/2026-08-18.md", "saw [[Sam]]\n");
    action.action(null, 0);
    return plugin.engine.get("People/Sam.md").lastContact;
  })();
  check("a newly added dated note is picked up too", () =>
    assert.strictEqual(journalStale, "2026-08-18", journalStale));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
