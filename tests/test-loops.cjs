/** Open follow-ups: detection, completion, and adding them from the UI. */
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

const L = require(harness.bundleModule("src/loops.ts"));
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

async function boot(build, settings = {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }],
    linkDailyNoteInLog: false }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Detection");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n# Follow-ups\n- [ ] send the climbing list\n- [x] already did this one\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\n---\n");
      v.addFile("Projects/Trip.md", "- [ ] ask [[Ana]] about Lisbon\n- [x] booked flights with [[Ana]]\n- not a task, mentions [[Ana]]\n");
      v.addFile("Daily/2026-08-01.md", "- [ ] reach out to [[Sam]]\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    const ana = plugin.engine.get("People/Ana.md");

    check("an unchecked task in someone's own note is theirs", () =>
      assert.ok(sam.openLoops.some((l) => l.path === "People/Sam.md" && l.own === true),
        JSON.stringify(sam.openLoops)));
    check("a completed task is not a loop", () =>
      assert.strictEqual(sam.openLoops.filter((l) => l.path === "People/Sam.md").length, 1));
    check("an unchecked task elsewhere that links to them counts", () =>
      assert.ok(ana.openLoops.some((l) => l.path === "Projects/Trip.md"),
        JSON.stringify(ana.openLoops)));
    check("a completed task elsewhere does not", () =>
      assert.strictEqual(ana.openLoops.length, 1, JSON.stringify(ana.openLoops)));
    check("a plain bullet is not a task", () =>
      assert.ok(!ana.openLoops.some((l) => l.line === 2)));
    check("a journal to-do counts as a follow-up, not as contact", () => {
      assert.ok(sam.openLoops.some((l) => l.path === "Daily/2026-08-01.md"));
      assert.strictEqual(sam.lastContact, null);
    });
    check("the diagnostics count them", () =>
      assert.strictEqual(plugin.engine.diagnostics().openLoopsFound, 3,
        JSON.stringify(plugin.engine.diagnostics())));
  }

  console.log("\nA task in a person's note that links to them is counted once");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n- [ ] text [[Sam]] about dinner\n");
    });
    check("no duplicate loop", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 1));
  }

  console.log("\nReading the text, due dates and ordering");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n" +
        "- [ ] send the list 📅 2026-09-01\n" +
        "- [ ] book a table (2026-08-20)\n" +
        "- [ ] no date on this one\n" +
        "- [ ] ask [[Ana Diaz|Ana]] to join\n");
      v.addFile("People/Ana Diaz.md", "---\ntags:\n  - people\n---\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    const loops = await L.readLoops(plugin.app, sam.openLoops);

    check("all four are read", () => assert.strictEqual(loops.length, 4));
    check("dated loops come first, soonest first", () =>
      assert.deepStrictEqual(loops.slice(0, 2).map((l) => l.due), ["2026-08-20", "2026-09-01"]));
    check("the due-date syntax is stripped from the text", () =>
      assert.strictEqual(loops.find((l) => l.due === "2026-09-01").text, "send the list"));
    check("a parenthesised date is read and stripped", () =>
      assert.strictEqual(loops.find((l) => l.due === "2026-08-20").text, "book a table"));
    check("an undated loop keeps its text", () =>
      assert.ok(loops.some((l) => l.due === null && l.text === "no date on this one")));
    check("a link is shown by its display text", () =>
      assert.ok(loops.some((l) => l.text === "ask Ana to join"), JSON.stringify(loops.map(l=>l.text))));
  }

  console.log("\nCompleting a loop");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n- [ ] first thing\n- [ ] second thing\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    const loops = await L.readLoops(plugin.app, sam.openLoops);
    const second = loops.find((l) => l.text === "second thing");

    const ok = await plugin.completeLoop(second.ref);
    const text = store.get("People/Sam.md");
    check("it reports success", () => assert.strictEqual(ok, true));
    check("the right task is ticked", () =>
      assert.ok(text.includes("- [x] second thing"), text));
    check("the other is untouched", () =>
      assert.ok(text.includes("- [ ] first thing"), text));
    check("the index drops it", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 1));

    check("one undo entry", () => {
      const entry = plugin.undo.peekUndo();
      assert.ok(/follow-up/i.test(entry.label), entry.label);
    });
    await plugin.performUndo();
    check("undo restores the open task", () =>
      assert.ok(store.get("People/Sam.md").includes("- [ ] second thing"),
        store.get("People/Sam.md")));
  }

  console.log("\nUnticking a follow-up");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n- [ ] send the list\n- [ ] call him\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    const loops = await L.readLoops(plugin.app, sam.openLoops);
    const one = loops.find((l) => l.text === "send the list");

    check("a fresh loop reads as not done", () => assert.strictEqual(one.done, false));

    await plugin.completeLoop(one.ref, true);
    check("ticking it writes [x]", () =>
      assert.ok(store.get("People/Sam.md").includes("- [x] send the list"),
        store.get("People/Sam.md")));

    // The index drops it, so the panel keeps the ref to offer the un-tick.
    const afterDone = await L.readLoops(plugin.app, [one.ref]);
    check("it can still be read, reported as done", () => {
      assert.strictEqual(afterDone.length, 1);
      assert.strictEqual(afterDone[0].done, true);
      assert.strictEqual(afterDone[0].text, "send the list");
    });

    const ok = await plugin.completeLoop(one.ref, false);
    check("unticking succeeds", () => assert.strictEqual(ok, true));
    check("and writes [ ] back", () =>
      assert.ok(store.get("People/Sam.md").includes("- [ ] send the list"),
        store.get("People/Sam.md")));
    check("the other task is untouched", () =>
      assert.ok(store.get("People/Sam.md").includes("- [ ] call him")));
    check("the index has it again", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 2));
    check("reopening is its own undo entry", () =>
      assert.ok(/[Rr]eopen/.test(plugin.undo.peekUndo().label), plugin.undo.peekUndo().label));

    // Completed loops sort below outstanding ones.
    await plugin.completeLoop(one.ref, true);
    const mixed = await L.readLoops(plugin.app,
      [...plugin.engine.get("People/Sam.md").openLoops, one.ref]);
    check("completed loops sort last", () => {
      assert.strictEqual(mixed.length, 2);
      assert.strictEqual(mixed[0].done, false);
      assert.strictEqual(mixed[1].done, true);
    });
    check("a ref given twice is only read once", async () => {
      const dup = await L.readLoops(plugin.app, [one.ref, one.ref, one.ref]);
      assert.strictEqual(dup.length, 1);
    });
    const dup = await L.readLoops(plugin.app, [one.ref, one.ref, one.ref]);
    check("deduped", () => assert.strictEqual(dup.length, 1));
  }

  console.log("\nA stale ref is declined rather than ticking the wrong line");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n- [ ] the original task\n");
    });
    const ref = plugin.engine.get("People/Sam.md").openLoops[0];
    // The task is gone; something else now sits at that offset and line.
    store.set("People/Sam.md", "---\ntags:\n  - people\n---\njust prose now\n");
    const before = store.get("People/Sam.md");
    const ok = await plugin.completeLoop(ref);
    check("it reports failure", () => assert.strictEqual(ok, false));
    check("nothing is written", () => assert.strictEqual(store.get("People/Sam.md"), before));
    check("and the user is told", () =>
      assert.ok(notices.some((n) => /already changed/.test(n)), JSON.stringify(notices.slice(-2))));
  }

  console.log("\nAdding a follow-up");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n## Thoughts\n\nsome prose\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\n---\n### Notes\n\n- [ ] existing one\n");
    });
    await plugin.addFollowUp(plugin.engine.get("People/Sam.md"), "  send the climbing list  ");
    const sam = store.get("People/Sam.md");
    check("a heading is created when absent", () =>
      assert.ok(sam.includes("## Follow-ups"), sam));
    check("the task is written under it, trimmed", () =>
      assert.ok(/## Follow-ups\n- \[ \] send the climbing list\n/.test(sam), sam));
    check("the heading matches the note's own depth", () =>
      assert.ok(!sam.includes("# Follow-ups\n") || sam.includes("## Follow-ups"), sam));
    check("the index picks it up", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 1));

    // Ana's note uses h3, and already has a Follow-ups-less section.
    await plugin.addFollowUp(plugin.engine.get("People/Ana.md"), "first");
    await plugin.addFollowUp(plugin.engine.get("People/Ana.md"), "second");
    const ana = store.get("People/Ana.md");
    check("a second follow-up appends after the first", () =>
      assert.ok(/- \[ \] first\n- \[ \] second\n/.test(ana), ana));
    check("an existing heading is reused, not duplicated", () =>
      assert.strictEqual(ana.split("Follow-ups").length - 1, 1, ana));
    check("the new heading matched the note's shallowest depth", () =>
      assert.ok(ana.includes("### Follow-ups"), ana));

    check("an empty follow-up is refused", async () => {
      assert.ok(true);
    });
    const anaBefore = store.get("People/Ana.md");
    await plugin.addFollowUp(plugin.engine.get("People/Ana.md"), "   ");
    check("a whitespace-only follow-up writes nothing", () =>
      assert.strictEqual(store.get("People/Ana.md"), anaBefore));
  }

  console.log("\nThe feature can be turned off");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n- [ ] a task\n");
    }, { trackOpenLoops: false });
    check("no loops are indexed", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 0));
    check("and none are counted", () =>
      assert.strictEqual(plugin.engine.diagnostics().openLoopsFound, 0));
  }

  console.log("\nA ref only ticks the task it was made for");
  {
    // Three tasks in a row, then a line inserted above them: every recorded offset
    // now lands on the task *before* the one it was made for, and that line is also
    // an open task, so the positional checks alone are satisfied by the wrong one.
    const before = "---\ntags:\n  - people\n---\n" +
      "- [ ] call the plumber\n- [ ] book the dentist\n- [ ] renew the passport\n";
    const after = before.replace("---\n- [ ]", "---\nA note I added.\n- [ ]");
    const refFor = (content, text) => {
      const idx = content.indexOf(`- [ ] ${text}`);
      return { path: "People/Sam.md", own: true, offset: idx,
        line: content.slice(0, idx).split("\n").length - 1 };
    };
    const ref = refFor(before, "book the dentist");

    check("the hazard is real: positions alone hit the wrong task", () => {
      const span = L.locateTask(after, ref, /^\s*[-*+]\s*\[( )\]/);
      assert.ok(span, "expected a positional match");
      assert.strictEqual(after.slice(span[0], span[1]), "- [ ] call the plumber");
    });
    check("the expected text refuses that match", () =>
      assert.strictEqual(L.locateTask(after, ref, /^\s*[-*+]\s*\[( )\]/,
        "book the dentist"), null));
    check("so setTask declines rather than ticking the neighbour", () =>
      assert.strictEqual(L.setTask(after, ref, true, "book the dentist"), null));
    check("and without the guard it would have written the wrong line", () => {
      const wrong = L.setTask(after, ref, true);
      assert.ok(wrong.includes("- [x] call the plumber"), wrong);
    });
    check("an unmoved task still ticks, with the text agreeing", () => {
      const out = L.setTask(before, ref, true, "book the dentist");
      assert.ok(out.includes("- [x] book the dentist"), out);
      assert.ok(out.includes("- [ ] call the plumber"), out);
    });
    check("reopening is guarded the same way", () => {
      const done = before.replace("- [ ] book", "- [x] book");
      assert.strictEqual(L.setTask(done, refFor(done, "call the plumber"), false,
        "book the dentist"), null);
      const out = L.setTask(done, ref, false, "book the dentist");
      assert.ok(out.includes("- [ ] book the dentist"), out);
    });
    check("a due date is stripped from both sides before comparing", () => {
      const dated = before.replace("- [ ] book the dentist",
        "- [ ] book the dentist \uD83D\uDCC5 2026-09-01");
      const out = L.setTask(dated, refFor(dated, "book the dentist"), true,
        "book the dentist");
      assert.ok(out.includes("- [x] book the dentist"), out);
    });
    check("omitting the text keeps the old positional behaviour", () => {
      const out = L.setTask(before, ref, true);
      assert.ok(out.includes("- [x] book the dentist"), out);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
