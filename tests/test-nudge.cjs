/** The daily reach-out block: what it writes, and how it interacts with the rest. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout,
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

const TODAY = new Date().toISOString().slice(0, 10);
const LONG_AGO = "2020-01-01";

async function boot(build, settings = {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }],
    dailyNudge: true, dailyNudgeLimit: 5, linkDailyNoteInLog: false }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

const overdue = (name) =>
  [`People/${name}.md`, `---\ntags:\n  - people\nprm-tier: inner\nprm-last-contacted: ${LONG_AGO}\n---\n`];

(async () => {
  console.log("Writing the block");
  {
    const { plugin, store, addFile } = await boot((v) => {
      for (const n of ["Sam", "Ana", "Bo"]) v.addFile(...overdue(n));
      v.addFile(`Daily/${TODAY}.md`, "## Log\n\nwoke up late\n");
    });
    const file = plugin.app.vault.getAbstractFileByPath(`Daily/${TODAY}.md`);
    const ok = await plugin.addNudge(file);
    const text = store.get(`Daily/${TODAY}.md`);

    check("it reports success", () => assert.strictEqual(ok, true));
    check("a heading is written", () => assert.ok(text.includes("## Reach out"), text));
    check("everyone overdue is listed as an open task", () => {
      for (const n of ["Sam", "Ana", "Bo"]) {
        assert.ok(new RegExp(`- \\[ \\] \\[\\[${n}\\]\\]`).test(text), `${n}: ${text}`);
      }
    });
    check("with how overdue they are", () => assert.ok(/overdue \d/.test(text), text));
    check("the existing content is kept", () => assert.ok(text.includes("woke up late"), text));

    check("an open nudge does NOT count as contact", () => {
      for (const n of ["Sam", "Ana", "Bo"]) {
        assert.strictEqual(plugin.engine.get(`People/${n}.md`).lastContact, LONG_AGO,
          `${n} was marked contacted by being listed`);
      }
    });
    check("nor does it become a follow-up", () => {
      for (const n of ["Sam", "Ana", "Bo"]) {
        assert.deepStrictEqual(plugin.engine.get(`People/${n}.md`).openLoops, [],
          `${n}: ${JSON.stringify(plugin.engine.get(`People/${n}.md`).openLoops)}`);
      }
    });

    check("one undo entry", () => assert.ok(/Reach-outs|reach-outs/i.test(plugin.undo.peekUndo().label),
      plugin.undo.peekUndo().label));

    // Running again must not stack a second block.
    const before = store.get(`Daily/${TODAY}.md`);
    const again = await plugin.addNudge(file);
    check("a second run writes nothing", () => {
      assert.strictEqual(again, false);
      assert.strictEqual(store.get(`Daily/${TODAY}.md`), before);
    });
    check("and says why", () =>
      assert.ok(notices.some((n) => /already has/.test(n)), JSON.stringify(notices.slice(-2))));
  }

  console.log("\nTicking a nudge off logs the contact");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile(...overdue("Sam"));
      v.addFile(`Daily/${TODAY}.md`, "");
    });
    const file = plugin.app.vault.getAbstractFileByPath(`Daily/${TODAY}.md`);
    await plugin.addNudge(file);
    check("not contacted while the box is open", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").lastContact, LONG_AGO));

    // The user ticks the box, as they would in the editor.
    store.set(`Daily/${TODAY}.md`, store.get(`Daily/${TODAY}.md`).replace("- [ ]", "- [x]"));
    plugin.engine.rebuild();
    check("ticking it counts as contact today", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").lastContact, TODAY,
        store.get(`Daily/${TODAY}.md`)));
  }

  console.log("\nOnly today's dated note gets one automatically");
  {
    const { plugin, store, addFile } = await boot((v) => {
      v.addFile(...overdue("Sam"));
    });
    const nudged = async (p) => {
      const f = addFile(p, "");
      await plugin.nudgeIfTodaysNote(f);
      return store.get(p).includes("Reach out");
    };
    check("today's journal is nudged", async () => assert.ok(true));
    const todayNote = await nudged(`Daily/${TODAY}.md`);
    const oldNote = await nudged("Daily/2024-03-04.md");
    const futureNote = await nudged("Daily/2099-01-01.md");
    const elsewhere = await nudged("Projects/Some note.md");
    check("today's dated note gets a block", () => assert.strictEqual(todayNote, true));
    check("an older dated note does not", () => assert.strictEqual(oldNote, false));
    check("a future dated note does not", () => assert.strictEqual(futureNote, false));
    check("a note outside the journal does not", () => assert.strictEqual(elsewhere, false));
  }

  console.log("\nNothing overdue, and the feature off");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", `---\ntags:\n  - people\nprm-tier: inner\nprm-last-contacted: ${TODAY}\n---\n`);
      v.addFile(`Daily/${TODAY}.md`, "x\n");
    });
    const file = plugin.app.vault.getAbstractFileByPath(`Daily/${TODAY}.md`);
    const ok = await plugin.addNudge(file);
    check("nothing is written when nobody is due", () => {
      assert.strictEqual(ok, false);
      assert.strictEqual(store.get(`Daily/${TODAY}.md`), "x\n");
    });
  }
  {
    const { plugin, store, addFile } = await boot((v) => {
      v.addFile(...overdue("Sam"));
    }, { dailyNudge: false });
    const f = addFile(`Daily/${TODAY}.md`, "");
    await plugin.nudgeIfTodaysNote(f);
    check("the setting off means no automatic block", () =>
      assert.strictEqual(store.get(`Daily/${TODAY}.md`), ""));
  }

  console.log("\nDuring startup, Obsidian replays create for every file");
  {
    const { plugin, store, addFile } = await boot((v) => {
      v.addFile(...overdue("Sam"));
    });
    // What the vault looks like before the workspace is ready.
    plugin.ready = false;
    const f = addFile(`Daily/${TODAY}.md`, "");
    await plugin.nudgeIfTodaysNote(f);
    check("no note is edited while loading", () =>
      assert.strictEqual(store.get(`Daily/${TODAY}.md`), ""));
    plugin.ready = true;
    await plugin.nudgeIfTodaysNote(f);
    check("and it works once ready", () =>
      assert.ok(store.get(`Daily/${TODAY}.md`).includes("Reach out"),
        store.get(`Daily/${TODAY}.md`)));
  }

  console.log("\nWith the nudge off, an existing block is an ordinary follow-up again");
  {
    const { plugin } = await boot((v) => {
      v.addFile(...overdue("Sam"));
      v.addFile(`Daily/${TODAY}.md`, "## Reach out\n- [ ] [[Sam]] — overdue 6w\n");
    }, { dailyNudge: false });
    check("the task counts as a follow-up", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").openLoops.length, 1));
    check("but still not as contact", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").lastContact, LONG_AGO));
  }

  console.log("\nA real follow-up outside the block still counts");
  {
    const { plugin } = await boot((v) => {
      v.addFile(...overdue("Sam"));
      v.addFile(`Daily/${TODAY}.md`,
        "## Reach out\n- [ ] [[Sam]] — overdue 6w\n\n## Log\n- [ ] send [[Sam]] the climbing list\n");
    });
    const loops = plugin.engine.get("People/Sam.md").openLoops;
    check("only the one outside the block", () => assert.strictEqual(loops.length, 1, JSON.stringify(loops)));
    check("and it's the one under Log", () => assert.strictEqual(loops[0].line, 4, JSON.stringify(loops)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
