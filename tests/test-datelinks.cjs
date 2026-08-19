/** Dated links in a person's own note as interaction history. */
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

async function boot(build, settings = {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [{ folder: "Daily", format: "YYYY-MM-DD" }] }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Harvesting dates from a person's own note");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n" +
        "# Contact log\n" +
        "- [[2026-07-04]] — coffee\n" +
        "- [[2026-06-12]] — called\n" +
        "# Thoughts\n" +
        "- a very deep conversation on [[2026-01-24]] stayed with me\n" +
        "- he knows [[Ana]] from school\n" +
        "- moved here in [[2020]]\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\n---\n");
      v.addFile("Daily/2026-07-04.md", "");
    });
    const sam = plugin.engine.get("People/Sam.md");

    check("log-line dates become interactions", () => {
      assert.ok(sam.contactDates.includes("2026-07-04"), JSON.stringify(sam.contactDates));
      assert.ok(sam.contactDates.includes("2026-06-12"), JSON.stringify(sam.contactDates));
    });
    check("a date named in prose counts too", () =>
      assert.ok(sam.contactDates.includes("2026-01-24"), JSON.stringify(sam.contactDates)));
    check("a link to a person is not a date", () =>
      assert.strictEqual(sam.contactDates.length, 3, JSON.stringify(sam.contactDates)));
    check("last contact is the newest of them", () =>
      assert.strictEqual(sam.lastContact, "2026-07-04"));
    check("and the other person isn't given Sam's dates", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Ana.md").contactDates, []));
  }

  console.log("\nThe same positional rules as a journal");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n" +
        "- [ ] follow up on [[2026-05-01]]\n" +
        "> quoting him about [[2026-04-01]]\n" +
        "```\ncode with [[2026-03-01]]\n```\n" +
        "![[2026-02-01]]\n" +
        "- really did talk on [[2026-01-15]]\n");
    });
    const dates = plugin.engine.get("People/Sam.md").contactDates;
    check("an open task doesn't count", () => assert.ok(!dates.includes("2026-05-01"), JSON.stringify(dates)));
    check("a quotation doesn't count", () => assert.ok(!dates.includes("2026-04-01"), JSON.stringify(dates)));
    check("a code block doesn't count", () => assert.ok(!dates.includes("2026-03-01"), JSON.stringify(dates)));
    check("an embed doesn't count", () => assert.ok(!dates.includes("2026-02-01"), JSON.stringify(dates)));
    check("the real one does", () => assert.deepStrictEqual(dates, ["2026-01-15"]));
  }

  console.log("\nHistory is what the frontmatter alone can't give");
  {
    const { plugin } = await boot((v) => {
      // Only ever logged manually: one frontmatter date, four log lines.
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\nprm-last-contacted: 2026-08-01\n---\n" +
        "# Contact log\n- [[2026-08-01]]\n- [[2026-07-18]]\n- [[2026-07-04]]\n- [[2026-06-20]]\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    check("every logged date is on record", () =>
      assert.strictEqual(sam.contactDates.length, 4, JSON.stringify(sam.contactDates)));
    check("the frontmatter date isn't double-counted", () =>
      assert.strictEqual(sam.contactDates.filter((d) => d === "2026-08-01").length, 1));
    check("so a rhythm can be measured from manual logs alone", () =>
      assert.strictEqual(sam.typicalGapDays, 14, `${sam.typicalGapDays}`));
  }

  console.log("\nA journal entry stays the place a date jumps to");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n- [[2026-07-04]] — coffee\n");
      v.addFile("Daily/2026-07-04.md", "had coffee with [[Sam]]\n");
    });
    const sam = plugin.engine.get("People/Sam.md");
    check("the date is counted once", () => assert.deepStrictEqual(sam.contactDates, ["2026-07-04"]));
    check("and points at the journal, not the log line", () =>
      assert.strictEqual(sam.sources.get("2026-07-04"), "Daily/2026-07-04.md"));
  }

  console.log("\nOpting out");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n- [[2026-07-04]]\n");
    }, { countPersonNoteDateLinks: false });
    check("the setting off means no harvesting", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Sam.md").contactDates, []));
  }
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md",
        "---\ntags:\n  - people\nprm-tier: casual\nprm-ignore-journal: true\n---\n- [[2026-07-04]]\n");
    });
    check("prm-ignore-journal opts one person out", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Sam.md").contactDates, []));
  }

  console.log("\nLogging links the date even with no note for that day");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n");
    }, { logToBody: true, linkDailyNoteInLog: true, alwaysLinkLogDate: true });
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam.md");
    await plugin.logContact(file, "2026-05-05", "texted");
    const text = store.get("People/Sam.md");
    check("the bare date becomes a link", () =>
      assert.ok(text.includes("[[2026-05-05]]"), text));
    check("so the index can read it back", () =>
      assert.ok(plugin.engine.get("People/Sam.md").contactDates.includes("2026-05-05")));
  }
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n");
    }, { logToBody: true, linkDailyNoteInLog: true, alwaysLinkLogDate: false });
    const file = plugin.app.vault.getAbstractFileByPath("People/Sam.md");
    await plugin.logContact(file, "2026-05-05", "texted");
    const text = store.get("People/Sam.md");
    check("off by default, it stays a bare date", () => {
      assert.ok(text.includes("2026-05-05"), text);
      assert.ok(!text.includes("[[2026-05-05]]"), text);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
