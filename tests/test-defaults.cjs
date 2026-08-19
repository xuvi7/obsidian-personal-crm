/**
 * The shipped defaults must not encode any one vault's conventions, and a fresh
 * install must still end up configured via detection.
 */
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

// Conventions specific to one person's vault, which must not appear in defaults.
// "MOC" is deliberately NOT here: Map of Content is an Obsidian-community term
// (from the LYT framework), not one vault's invention, and with whole-word
// matching it can no longer swallow a real name. "People MOC" as a phrase would
// be vault-specific, so that is checked separately.
//
// This guard also needs to catch the author's own name and employer leaking into
// shipped defaults — but this repo is public, so those strings cannot be written
// down here. Set PRM_TEST_PRIVATE_TERMS (comma-separated) to add them locally.
const VAULT_ISMS = ["Atlas", "Calendar/Journal", "creation date", "creation-date",
                    "Encounters", "People MOC", "dashboard",
                    ...(process.env.PRM_TEST_PRIVATE_TERMS || "")
                      .split(",").map((t) => t.trim()).filter(Boolean)];

(async () => {
  console.log("Shipped defaults");
  {
    const v = makeVault();
    const p = new PluginClass(v.app, { id: "personal-crm" });
    p.__data = null;                      // a genuinely fresh install
    await p.onload();
    const s = p.settings;

    check("no folders are guessed", () => {
      assert.deepStrictEqual(s.personFolders, []);
      assert.deepStrictEqual(s.journalSources, []);
    });
    check("no vault-specific creation-date key", () => {
      for (const k of s.createdDateKeys) {
        assert.ok(!/creation.date/i.test(k), `"${k}" is one vault's convention`);
      }
    });
    check("exclusions are Obsidian-universal only", () =>
      assert.deepStrictEqual(s.personExclusions,
        ["template", "templates", "untitled", "index", "MOC"]));
    check("creation settings start empty", () => {
      assert.strictEqual(s.newPersonFolder, "");
      assert.strictEqual(s.newPersonTemplate, "");
      assert.strictEqual(s.newPersonTier, "");
    });
    check("no default value anywhere mentions this vault's idioms", () => {
      const json = JSON.stringify(s);
      for (const ism of VAULT_ISMS) {
        assert.ok(!json.includes(ism), `defaults contain "${ism}": ${json.slice(0, 200)}`);
      }
    });
    check("behavioural defaults are still sensible", () => {
      assert.strictEqual(s.dueSoonWindowDays, 7);
      assert.strictEqual(s.ignoreIntentLinks, true);
      assert.strictEqual(s.journalMentionsCountAsContact, true);
      assert.strictEqual(s.tiers.length, 5);
      assert.strictEqual(s.journalDateKey, "date");
    });
  }

  console.log("\nExclusions match whole words, not substrings");
  {
    const v = makeVault();
    // Real names that contain an exclusion fragment as a substring.
    for (const n of ["Mochizuki Aya", "Indexa Bello", "Templeton Ray", "Sam Rivera"]) {
      v.addFile(`People/${n}.md`, "---\ntags:\n  - people\n---\n");
    }
    // Notes that genuinely are not people.
    for (const n of ["People MOC", "Person template", "Untitled", "Index"]) {
      v.addFile(`People/${n}.md`, "---\ntags:\n  - people\n---\n");
    }
    const p = new PluginClass(v.app, { id: "personal-crm" });
    p.__data = { configured:true, notifyOnStartup:false, showStatusBar:false,
      personFolders:["People"], journalSources:[] };
    await p.onload(); p.engine.rebuild();
    const names = p.engine.all().map((r) => r.name).sort();

    check("a surname containing an exclusion word is kept", () => {
      assert.ok(names.includes("Mochizuki Aya"), names.join(", "));
      assert.ok(names.includes("Indexa Bello"), names.join(", "));
      assert.ok(names.includes("Templeton Ray"), names.join(", "));
    });
    check("notes that are genuinely not people are still excluded", () => {
      for (const n of ["People MOC", "Person template", "Untitled", "Index"]) {
        assert.ok(!names.includes(n), `${n} should be excluded: ${names.join(", ")}`);
      }
    });
    check("exactly the four real people are indexed", () =>
      assert.strictEqual(names.length, 4, names.join(", ")));
  }

  console.log("\nA fresh install still gets configured, by detection");
  {
    const v = makeVault();
    v.addFile("Contacts/Sam.md", "---\ntags:\n  - people\n---\n");
    v.addFile("Journal/2026-08-17.md", "saw [[Sam]]\n");
    const p = new PluginClass(v.app, { id: "personal-crm" });
    p.__data = null;
    await p.onload();
    check("the people folder is found by name", () =>
      assert.deepStrictEqual(p.settings.personFolders, ["Contacts"]));
  }

  console.log("\nDetection never overwrites a choice already made");
  {
    const v = makeVault();
    v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n");
    v.addFile("MyFolks/Ana.md", "---\ntags:\n  - people\n---\n");
    const p = new PluginClass(v.app, { id: "personal-crm" });
    p.__data = { configured: true, personFolders: ["MyFolks"],
      journalSources: [{ folder: "Logs", format: "YYYY-MM-DD" }],
      notifyOnStartup: false, showStatusBar: false };
    await p.onload();
    const found = await p.detectFromVault();
    check("an existing people folder is kept, not replaced by the guess", () =>
      assert.deepStrictEqual(p.settings.personFolders, ["MyFolks"]));
    check("existing dated folders are kept", () =>
      assert.deepStrictEqual(p.settings.journalSources, [{ folder: "Logs", format: "YYYY-MM-DD" }]));
    check("and it reports that it filled nothing in", () =>
      assert.strictEqual(found.people, null));
  }

  console.log("\nAn unconfigured install explains itself");
  {
    const v = makeVault();
    v.addFile("Notes/Something.md", "text\n");
    const p = new PluginClass(v.app, { id: "personal-crm" });
    p.__data = { configured: true, notifyOnStartup: false, showStatusBar: false };
    await p.onload();
    p.engine.rebuild();
    const status = p.__tab.getSettingDefinitions()[0];
    const text = (status.desc.__lines || []).join(" | ");
    check("Status says nothing is set up rather than blaming a folder", () =>
      assert.ok(/Nothing is set up yet/.test(text), text));
    check("0 people, and no invented folder reported missing", () => {
      assert.strictEqual(p.engine.diagnostics().personFilesFound, 0);
      assert.deepStrictEqual(p.engine.diagnostics().missingFolders, []);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
