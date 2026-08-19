/** The person panel and bulk-mode log dialog, driven against the real modals.ts. */
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

const M = require(harness.bundleModule("src/modals.ts"));
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

async function boot(build, settings = {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [], linkDailyNoteInLog: false }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Bulk-mode log dialog hands back the date and note instead of writing");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n");
    });
    const seen = [];
    const paths = ["People/Sam.md", "People/Ana.md"];
    const m = new M.LogContactModal(plugin, null, {
      count: paths.length,
      onSubmit: (date, note) => seen.push([date, note]),
    });
    let closed = false;
    m.close = () => { closed = true; };

    m.date = "2026-08-01";
    m.note = "  Saw them all at the wedding.  ";
    await m.submit();
    check("the callback gets the date and a trimmed note", () =>
      assert.deepStrictEqual(seen, [["2026-08-01", "Saw them all at the wedding."]]));
    check("the dialog closes itself", () => assert.strictEqual(closed, true));
    check("no note was written directly", () =>
      assert.ok(!store.get("People/Sam.md").includes("2026-08-01"),
        store.get("People/Sam.md")));

    m.note = "   ";
    await m.submit();
    check("a whitespace-only note is passed as undefined", () =>
      assert.strictEqual(seen[1][1], undefined));

    const before = seen.length;
    m.date = "not-a-date";
    await m.submit();
    check("an invalid date submits nothing", () => assert.strictEqual(seen.length, before));

    // The bulk callback is what the dashboard wires to bulkLogContact.
    await plugin.bulkLogContact(paths, "2026-08-01", "Saw them all at the wedding.");
    check("the wired-up bulk write reaches every note", () => {
      for (const p of paths) {
        assert.ok(store.get(p).includes("2026-08-01"), `${p}: ${store.get(p)}`);
        assert.ok(store.get(p).includes("Saw them all at the wedding."), p);
      }
    });
  }

  console.log("\nThe person panel logs one person with its own date and note");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n# Thoughts\n");
    });
    const record = plugin.engine.get("People/Sam.md");
    const m = new M.PersonActionsModal(plugin, record);
    let closed = false;
    m.close = () => { closed = true; };

    m.date = "2026-07-04";
    m.note = "Fireworks on the roof.";
    await m.logIt();

    const text = store.get("People/Sam.md");
    check("the log entry lands in the note", () => assert.ok(text.includes("2026-07-04"), text));
    check("the note text comes with it", () =>
      assert.ok(text.includes("Fireworks on the roof."), text));
    check("last contact is updated", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").lastContact, "2026-07-04"));
    check("the panel closes after logging", () => assert.strictEqual(closed, true));

    check("one undo entry, named for the person", () => {
      const entry = plugin.undo.peekUndo();
      assert.ok(/Sam/.test(entry.label), entry.label);
    });

    // A second click while the first write is in flight must not double-log.
    const m2 = new M.PersonActionsModal(plugin, plugin.engine.get("People/Sam.md"));
    m2.close = () => {};
    m2.date = "2026-07-05";
    m2.note = "";
    await Promise.all([m2.logIt(), m2.logIt(), m2.logIt()]);
    const after = store.get("People/Sam.md");
    // Count log lines only: prm-last-contacted carries the same date.
    const logLines = after.split("\n").filter((l) => l.startsWith("- 2026-07-05"));
    check("a re-entrant click logs the date once", () =>
      assert.strictEqual(logLines.length, 1, after));
  }

  console.log("\nThe panel follows the index instead of drawing once");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n");
    });
    const before = plugin.engine.listeners.size;
    const m = new M.PersonActionsModal(plugin, plugin.engine.get("People/Sam.md"));
    m.onOpen();
    check("it subscribes while open", () =>
      assert.strictEqual(plugin.engine.listeners.size, before + 1));

    // A rebuild that briefly saw no frontmatter is what rendered "unclassified";
    // the panel must redraw when the index settles rather than keep the stale draw.
    let renders = 0;
    const inner = m.render.bind(m);
    m.render = () => { renders++; inner(); };
    plugin.engine.rebuild();
    check("an index change redraws it", () => assert.ok(renders >= 1, `${renders}`));
    check("and the tier survives the redraw", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").tierId, "inner"));

    m.onClose();
    check("it unsubscribes when closed", () =>
      assert.strictEqual(plugin.engine.listeners.size, before));
  }

  console.log("\nAn invalid date in the person panel writes nothing");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: inner\n---\n");
    });
    const before = store.get("People/Sam.md");
    const m = new M.PersonActionsModal(plugin, plugin.engine.get("People/Sam.md"));
    let closed = false;
    m.close = () => { closed = true; };
    m.date = "";
    await m.logIt();
    check("the note is untouched", () => assert.strictEqual(store.get("People/Sam.md"), before));
    check("and the panel stays open", () => assert.strictEqual(closed, false));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
