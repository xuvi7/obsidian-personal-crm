const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const stub = makeStub([]);
Module._load = ((orig) => (r,p,m) => (r === "obsidian" ? stub : orig(r,p,m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0), cancelAnimationFrame:clearTimeout };
const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

async function withNote(body) {
  const v = makeVault();
  v.addFile("People/Sam.md", `---\ntags:\n  - people\nprm-tier: close\n---\n${body}`);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = { configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[], linkDailyNoteInLog:false };
  await p.onload(); p.engine.rebuild();
  const f = v.app.vault.getAbstractFileByPath("People/Sam.md");
  await p.logContact(f, "2026-08-17", "hello");
  return v.store.get("People/Sam.md");
}

(async () => {
  const one = await withNote("# Facts\n- met at a talk\n# Thoughts\n- nice person\n");
  check("matches # when the note uses #", () =>
    assert.ok(/^# Contact log$/m.test(one), one));
  check("does not nest under the last section", () =>
    assert.ok(!/^## Contact log$/m.test(one), one));

  const two = await withNote("## Facts\n- met at a talk\n");
  check("matches ## when the note uses ##", () =>
    assert.ok(/^## Contact log$/m.test(two), two));

  const none = await withNote("just a paragraph, no headings\n");
  check("defaults to ## when the note has no headings", () =>
    assert.ok(/^## Contact log$/m.test(none), none));

  const existing = await withNote("# Facts\n- x\n### Contact log\n- [[2026-01-01]]\n");
  check("an existing log heading is reused whatever its level", () => {
    assert.strictEqual((existing.match(/Contact log/g) || []).length, 1, existing);
    assert.ok(existing.includes("- 2026-08-17 — hello"), existing);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error("SUITE ERROR:", e.stack); process.exit(1); });
