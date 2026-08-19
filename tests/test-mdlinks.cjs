/**
 * Markdown-style links, which is what Obsidian writes with "Use [[Wikilinks]]" off.
 *
 * These were never attributed: the person link map registered only extension-less
 * names and paths, so `[Bob](People/Bob.md)` missed every key and the miss was
 * final. For a vault with wikilinks off that meant no contact history at all —
 * the plugin's whole premise — while looking like it simply had nothing to show.
 */
const Module = require("module");
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

const PERSON = "---\ntags:\n  - people\nprm-tier: casual\n---\n";

(async () => {
  console.log("A journal that uses markdown links");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Bob.md", PERSON);
      v.addFile("People/Ana Diaz.md", PERSON);
      v.addFile("People/Cy.md", PERSON);
      v.addFile("People/Di.md", PERSON);
      v.addFile("Daily/2026-08-10.md",
        "Lunch with [Bob](People/Bob.md).\n" +                     // full path
        "Then [Ana](People/Ana%20Diaz.md) called.\n" +             // percent-encoded
        "Ran into [Cy](Cy.md).\n" +                                // bare, with extension
        "And [Di](<People/Di.md>) too.\n");                        // angle-bracketed
    });
    const on = (p) => plugin.engine.get(p).contactDates;

    check("a full-path markdown link is contact", () =>
      assert.deepStrictEqual(on("People/Bob.md"), ["2026-08-10"]));
    check("a percent-encoded target is contact", () =>
      assert.deepStrictEqual(on("People/Ana Diaz.md"), ["2026-08-10"]));
    check("a bare name with .md is contact", () =>
      assert.deepStrictEqual(on("People/Cy.md"), ["2026-08-10"]));
    check("an angle-bracketed target is contact", () =>
      assert.deepStrictEqual(on("People/Di.md"), ["2026-08-10"]));
  }

  console.log("\nStill only people, and still only real contact");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Bob.md", PERSON);
      v.addFile("Notes/Bob's Project.md", "a note, not a person\n");
      v.addFile("Daily/2026-08-11.md",
        "- [ ] email [Bob](People/Bob.md) back\n" +                // an intention
        "Shipped [the project](Notes/Bob's%20Project.md).\n" +     // not a person
        "Read [a post](https://example.com/bob.md).\n" +           // external
        "![shot](People/Bob.md)\n");                              // an embed
      v.addFile("Daily/2026-08-12.md", "Saw [Bob](People/Bob.md).\n");
    });
    const bob = plugin.engine.get("People/Bob.md");

    check("an open task is an intention, not contact", () =>
      assert.ok(!bob.contactDates.includes("2026-08-11"), JSON.stringify(bob.contactDates)));
    check("an embed is not contact", () =>
      assert.deepStrictEqual(bob.contactDates, ["2026-08-12"]));
    check("the open task still becomes a follow-up", () =>
      assert.strictEqual(bob.openLoops.length, 1, JSON.stringify(bob.openLoops)));
    check("a link to a non-person note attributes to nobody", () =>
      assert.strictEqual(plugin.engine.get("Notes/Bob's Project.md"), null));
    check("an external link is never a person", () => {
      const all = [...plugin.engine.all()].filter((r) => r.contactDates.includes("2026-08-11"));
      assert.deepStrictEqual(all, []);
    });
  }

  console.log("\nMarkdown links elsewhere behave like wikilinks");
  {
    const { plugin } = await boot((v) => {
      // Two people can share a name here too, and only Obsidian can break the tie.
      v.addFile("People/Sam.md", PERSON);
      v.addFile("Work/Sam.md", PERSON);
      v.addFile("Daily/2026-08-13.md", "Saw [Sam](People/Sam.md).\n");
    }, { personFolders: ["People", "Work"] });

    check("an unambiguous full path is not confused by a shared basename", () => {
      assert.deepStrictEqual(plugin.engine.get("People/Sam.md").contactDates, ["2026-08-13"]);
      assert.deepStrictEqual(plugin.engine.get("Work/Sam.md").contactDates, []);
    });
  }

  console.log("\nDates in a person's own note, written as markdown links");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Eve.md", PERSON + "# Contact log\n- [Jul 4](2026-07-04.md) — coffee\n");
      v.addFile("Daily/2026-07-04.md", "");
    });
    check("a markdown date link is harvested as an interaction", () =>
      assert.deepStrictEqual(plugin.engine.get("People/Eve.md").contactDates, ["2026-07-04"]));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
