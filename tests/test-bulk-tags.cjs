/** Multi-select bulk writes, tagging, and tag sorting. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o)=>(r,p,m)=>(r==="obsidian"?stub:o(r,p,m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0), cancelAnimationFrame:clearTimeout };
const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

const fm = (extra="") => `---\ntags:\n  - people\n${extra}---\n`;

async function boot(build, settings = {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[], linkDailyNoteInLog:false }, settings);
  await p.onload(); p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Group tags exclude the marker tags");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n  - work\n  - climbing\n---\n");
      v.addFile("People/Ana.md", "---\ntags: person, family\n---\n");
      v.addFile("People/Bo.md", fm());
    });
    check("the marker tag is not shown as a group", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Sam.md").tags, ["climbing", "work"]));
    check("a comma-separated string tags field is read", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Ana.md").tags, ["family"]));
    check("someone with only the marker tag has no groups", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Bo.md").tags, []));
    check("allTags lists them by how many people use them", () =>
      assert.deepStrictEqual(plugin.engine.allTags().sort(), ["climbing", "family", "work"]));
  }

  console.log("\nBulk tagging");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\n  - work\n---\n");
      v.addFile("People/Bo.md", "---\ntags:\n  - people\n---\n");
    });
    const paths = ["People/Sam.md", "People/Ana.md", "People/Bo.md"];
    await plugin.bulkTag(paths, "work", true);

    check("everyone gains the tag", () => {
      for (const p of paths) {
        assert.ok(plugin.engine.get(p).tags.includes("work"), `${p}: ${plugin.engine.get(p).tags}`);
      }
    });
    check("it isn't duplicated on someone who already had it", () => {
      const t = plugin.engine.get("People/Ana.md").tags.filter((x) => x === "work");
      assert.strictEqual(t.length, 1);
    });
    check("the marker tag survives", () =>
      assert.ok(/- people/.test(store.get("People/Sam.md")), store.get("People/Sam.md")));
    check("one undo entry covers the whole selection", () => {
      const e = plugin.undo.peekUndo();
      assert.ok(/Tag 3 people with work/.test(e.label), e.label);
      assert.strictEqual(e.files.length, 2, "only the two that changed");
    });

    const before = paths.map((p) => store.get(p));
    await plugin.performUndo();
    check("undo restores every note it touched", () => {
      assert.ok(!plugin.engine.get("People/Sam.md").tags.includes("work"));
      assert.ok(plugin.engine.get("People/Ana.md").tags.includes("work"), "Ana had it already");
    });
    await plugin.performRedo();
    check("redo reapplies", () => paths.forEach((p, i) =>
      assert.strictEqual(store.get(p), before[i])));

    await plugin.bulkTag(paths, "work", false);
    check("removing takes it off everyone", () => {
      for (const p of paths) assert.ok(!plugin.engine.get(p).tags.includes("work"));
    });
    check("removing the last group tag leaves the marker tag intact", () =>
      assert.ok(/- people/.test(store.get("People/Ana.md")), store.get("People/Ana.md")));
    notices.length = 0;
    await plugin.bulkTag(paths, "   ", true);
    check("a whitespace-only tag is refused", () =>
      assert.ok(notices.some((n) => /Enter a tag/.test(n)), JSON.stringify(notices)));
    await plugin.bulkTag(["People/Sam.md"], "#gym", true);
    check("#gym is stored as gym", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Sam.md").tags, ["gym"]));
  }

  console.log("\nBulk cadence and logging");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", fm("prm-tier: casual\n"));
      v.addFile("People/Ana.md", fm());
      v.addFile("People/Bo.md", fm("prm-tier: inner\nprm-snooze-until: 2027-01-01\n"));
    });
    const paths = ["People/Sam.md", "People/Ana.md", "People/Bo.md"];

    await plugin.bulkSetTier(paths, "close");
    check("everyone gets the cadence", () => {
      for (const p of paths) assert.strictEqual(plugin.engine.get(p).tierId, "close");
    });
    check("one undo entry, named for the count", () =>
      assert.ok(/Set 3 people to Close/.test(plugin.undo.peekUndo().label),
        plugin.undo.peekUndo().label));

    await plugin.bulkLogContact(paths, "2026-08-18", "group catch-up");
    check("everyone's last contact is set", () => {
      for (const p of paths) assert.strictEqual(plugin.engine.get(p).lastContact, "2026-08-18");
    });
    check("the note text lands in each log", () =>
      assert.ok(/group catch-up/.test(store.get("People/Ana.md")), store.get("People/Ana.md")));
    check("logging clears an existing snooze", () =>
      assert.ok(!/prm-snooze-until/.test(store.get("People/Bo.md")), store.get("People/Bo.md")));

    await plugin.bulkSnooze(paths, "2026-09-01");
    check("bulk snooze applies to all", () => {
      for (const p of paths) assert.strictEqual(plugin.engine.get(p).snoozeUntil, "2026-09-01");
    });
    notices.length = 0;
    await plugin.bulkSnooze(paths, "not-a-date");
    check("an invalid bulk snooze date is refused", () =>
      assert.ok(notices.some((n) => /isn't a valid date/.test(n)), JSON.stringify(notices)));
  }

  console.log("\nA missing note in the selection doesn't sink the rest");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", fm());
      v.addFile("People/Ana.md", fm());
    });
    const result = await plugin.bulkTag(
      ["People/Sam.md", "People/Gone.md", "People/Ana.md"], "work", true);
    check("the present notes are still tagged", () => {
      assert.ok(plugin.engine.get("People/Sam.md").tags.includes("work"));
      assert.ok(plugin.engine.get("People/Ana.md").tags.includes("work"));
    });
    check("the outcome names what changed and what failed", () => {
      assert.strictEqual(result.changed, 2);
      assert.deepStrictEqual(result.failed, ["People/Gone.md"]);
    });
    check("and the failure is surfaced to the user", () =>
      assert.ok(notices.some((n) => /failed/.test(n)), JSON.stringify(notices.slice(-2))));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
