/** Status must reflect the index, including before the first build and after it. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o)=>(r,p,m)=>(r==="obsidian"?stub:o(r,p,m)))(Module._load);

let shown = true;
global.window = { setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0), cancelAnimationFrame:clearTimeout };
global.activeDocument = { activeElement: null };
global.HTMLInputElement = class {};
global.HTMLTextAreaElement = class {};

const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

(async () => {
  const v = makeVault();
  v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n");
  v.addFile("Daily/2026-08-17.md", "saw [[Sam]]\n");

  const plugin = new PluginClass(v.app, { id: "personal-crm" });
  plugin.__data = { configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[{folder:"Daily", format:"YYYY-MM-DD"}] };

  // Capture registered disposers so we can assert the subscription is tied to unload.
  const registered = [];
  plugin.register = (fn) => registered.push(fn);

  await plugin.onload();
  const tab = plugin.__tab;
  tab.containerEl.isShown = () => shown;

  // Before any build: diagnostics must say so rather than reporting zeros.
  check("diagnostics start as not-built", () =>
    assert.strictEqual(plugin.engine.diagnostics().built, false));
  const pre = tab.getSettingDefinitions()[0];
  check("Status says it is indexing, not '0 people found'", () => {
    assert.strictEqual(pre.name, "Status");
    assert.ok(/indexing/i.test(String(pre.desc)), JSON.stringify(pre.desc));
  });

  plugin.engine.rebuild();
  check("diagnostics report built after a rebuild", () =>
    assert.strictEqual(plugin.engine.diagnostics().built, true));
  const post = tab.getSettingDefinitions()[0];
  check("Status now reports real counts", () => {
    const lines = (post.desc.__lines || []).join(" | ");
    assert.ok(/1 person found/.test(lines), lines);
    assert.ok(/1 with a readable date/.test(lines), lines);
  });

  check("the engine subscription is registered for cleanup on unload", () =>
    assert.ok(registered.length >= 1, `registered ${registered.length}`));

  // The tab refreshes itself when the index changes while it is open.
  const before = tab.__updates;
  shown = true;
  plugin.engine.rebuild();
  await new Promise(r => setTimeout(r, 400));
  check("an index change while the tab is open refreshes it", () =>
    assert.ok(tab.__updates > before, `${before} -> ${tab.__updates}`));

  // ...but not while it is closed.
  shown = false;
  const closedAt = tab.__updates;
  plugin.engine.rebuild();
  await new Promise(r => setTimeout(r, 400));
  check("no refresh while the tab is closed", () =>
    assert.strictEqual(tab.__updates, closedAt));

  // ...and not while a field has focus, which would move the caret.
  shown = true;
  const typing = new global.HTMLInputElement();
  global.activeDocument.activeElement = typing;
  tab.containerEl.contains = () => true;
  const typingAt = tab.__updates;
  plugin.engine.rebuild();
  await new Promise(r => setTimeout(r, 400));
  check("no refresh while a settings field has focus", () =>
    assert.strictEqual(tab.__updates, typingAt));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
