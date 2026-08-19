/** Rhythm and drift: measuring how often you actually talk. */
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
const E = require(harness.bundleModule("src/engine.ts"));
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

const day = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const ago = (n) => iso(Date.now() - n * day);

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

/** A person seen on each of `days` (as days-ago numbers), via dated notes. */
function person(v, name, days, extra = "") {
  v.addFile(`People/${name}.md`, `---\ntags:\n  - people\nprm-tier: casual\n${extra}---\n`);
  for (const d of days) {
    const date = ago(d);
    const p = `Daily/${date}.md`;
    const prev = v.store.get(p) ?? "";
    v.addFile(p, prev + `saw [[${name}]]\n`);
  }
}

(async () => {
  console.log("typicalGap");
  {
    // newest-first, as the record stores them
    check("needs four interactions before it says anything", () => {
      assert.strictEqual(E.typicalGap(["2026-08-01", "2026-07-01", "2026-06-01"]), null);
      assert.strictEqual(E.typicalGap([]), null);
    });
    check("a steady weekly rhythm reads as 7 days", () =>
      assert.strictEqual(E.typicalGap(["2026-08-29", "2026-08-22", "2026-08-15", "2026-08-08"]), 7));
    check("a single long silence doesn't redefine the rhythm", () =>
      assert.strictEqual(
        E.typicalGap(["2026-08-29", "2026-08-22", "2026-08-15", "2020-01-01", "2019-12-25"]), 7));
    check("only the recent window counts", () => {
      // Six recent monthly gaps, then ancient daily ones that must be ignored.
      const dates = ["2026-08-01","2026-07-01","2026-06-01","2026-05-01","2026-04-01",
                     "2026-03-01","2026-02-01","2020-01-05","2020-01-04","2020-01-03"];
      const gap = E.typicalGap(dates);
      assert.ok(gap >= 28 && gap <= 31, `${gap}`);
    });
  }

  console.log("\nA burst of mentions is not a rhythm");
  {
    check("six daily mentions inside one week give no rhythm", () =>
      assert.strictEqual(
        E.typicalGap(["2026-08-06","2026-08-05","2026-08-04","2026-08-03","2026-08-02","2026-08-01"]),
        null));
    check("but daily contact sustained for a month does", () => {
      const dates = [];
      for (let i = 0; i < 40; i++) dates.push(iso(Date.parse("2026-08-10") - i * day));
      assert.strictEqual(E.typicalGap(dates), 1);
    });
    check("weekly over six weeks does", () =>
      assert.strictEqual(
        E.typicalGap(["2026-08-29","2026-08-22","2026-08-15","2026-08-08","2026-08-01"]), 7));
  }

  console.log("\nDrifting is measured against their own rhythm, not the tier");
  {
    const { plugin } = await boot((v) => {
      // Weekly for months, then silent for two.
      person(v, "Slipping", [63, 70, 77, 84, 91, 98, 105]);
      // Weekly and still weekly.
      person(v, "Steady", [3, 10, 17, 24, 31, 38]);
      // Yearly, and it's been 13 months — long in absolute terms, normal for them.
      person(v, "Yearly", [400, 765, 1130, 1495]);
      // Daily, quiet for three days: not drifting.
      person(v, "Daily", [3, 4, 5, 6, 7, 8]);
      // Too little history to judge.
      person(v, "New", [40, 60]);
    });
    const at = (n) => plugin.engine.get(`People/${n}.md`);

    check("a weekly friendship gone quiet for two months is drifting", () =>
      assert.strictEqual(at("Slipping").drifting, true,
        `gap=${at("Slipping").typicalGapDays} last=${at("Slipping").lastContact}`));
    check("a steady one is not", () => assert.strictEqual(at("Steady").drifting, false));
    check("a yearly friendship at 13 months is not", () =>
      assert.strictEqual(at("Yearly").drifting, false,
        `gap=${at("Yearly").typicalGapDays} last=${at("Yearly").lastContact}`));
    check("three quiet days is not drifting for a daily correspondent", () =>
      assert.strictEqual(at("Daily").drifting, false,
        `gap=${at("Daily").typicalGapDays}`));
    check("too little history means no verdict", () => {
      assert.strictEqual(at("New").typicalGapDays, null);
      assert.strictEqual(at("New").drifting, false);
    });

    check("the rhythm is reported alongside", () =>
      assert.strictEqual(at("Steady").typicalGapDays, 7, `${at("Steady").typicalGapDays}`));
  }

  console.log("\nSituational intensity that ended is not drift");
  {
    const { plugin } = await boot((v) => {
      // Daily through a three-month internship that finished six months ago.
      const days = [];
      for (let d = 180; d <= 270; d++) days.push(d);
      person(v, "Internship", days);
      // Same shape, but it only finished three weeks ago: still catchable.
      const recent = [];
      for (let d = 21; d <= 111; d++) recent.push(d);
      person(v, "JustEnded", recent);
      // A weekly friendship of two years, quiet for two months: squarely drift.
      const weekly = [];
      for (let w = 0; w < 100; w++) weekly.push(60 + w * 7);
      person(v, "OldFriend", weekly);
    });
    const at = (n) => plugin.engine.get(`People/${n}.md`);

    check("a daily context that ended six months ago is not drifting", () =>
      assert.strictEqual(at("Internship").drifting, false,
        `rhythm=${at("Internship").typicalGapDays} last=${at("Internship").lastContact}`));
    check("its rhythm is still reported, for the record", () =>
      assert.strictEqual(at("Internship").typicalGapDays, 1));
    check("the same shape three weeks out IS drifting", () =>
      assert.strictEqual(at("JustEnded").drifting, true,
        `rhythm=${at("JustEnded").typicalGapDays}`));
    check("a long weekly friendship gone quiet is drifting", () =>
      assert.strictEqual(at("OldFriend").drifting, true,
        `rhythm=${at("OldFriend").typicalGapDays}`));
  }

  console.log("\nDrift is independent of the assigned cadence");
  {
    const { plugin } = await boot((v) => {
      // Weekly in practice, but filed under a yearly cadence: not overdue, drifting.
      person(v, "Mismatch", [40, 47, 54, 61, 68], "prm-cadence: 365\n");
    });
    const r = plugin.engine.get("People/Mismatch.md");
    check("not overdue by the tier", () => assert.ok(r.overdueDays < 0, `${r.overdueDays}`));
    check("but flagged as drifting", () => assert.strictEqual(r.drifting, true));
    check("with the real rhythm on record", () => assert.strictEqual(r.typicalGapDays, 7));
  }

  console.log("\nPaused and never-contacted people are left alone");
  {
    const { plugin } = await boot((v) => {
      person(v, "Paused", [63, 70, 77, 84, 91], "prm-paused: true\n");
      v.addFile("People/Never.md", "---\ntags:\n  - people\nprm-tier: casual\n---\n");
    });
    check("a paused person is never drifting", () =>
      assert.strictEqual(plugin.engine.get("People/Paused.md").drifting, false));
    check("nor is someone never contacted", () =>
      assert.strictEqual(plugin.engine.get("People/Never.md").drifting, false));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
