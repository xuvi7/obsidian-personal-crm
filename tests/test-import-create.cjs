/** The import creating notes for unmatched contacts, and linking to existing ones. */
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
const contacts = require(harness.bundleModule("src/contacts.ts"));

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

const CONTACT = {
  displayName: "Ana Diaz", emails: ["ana@example.com"], phones: ["555-0142"],
  company: "Northwind", title: "Designer", location: "Lisbon, PT",
  birthday: "04-17", labels: ["Climbing"],
};

async function boot(settings, build = () => {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[] }, settings);
  await p.onload(); p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("contactFields maps a contact to note frontmatter");
  {
    const f = contacts.contactFields(CONTACT);
    check("all the useful fields are carried across", () => {
      assert.strictEqual(f.email, "ana@example.com");
      assert.strictEqual(f.phone, "555-0142");
      assert.strictEqual(f.company, "Northwind");
      assert.strictEqual(f.title, "Designer");
      assert.strictEqual(f.location, "Lisbon, PT");
      assert.strictEqual(f["prm-birthday"], "04-17");
      assert.strictEqual(f["prm-relationship"], "Climbing");
    });
    check("a contact key is stable across identical contacts", () =>
      assert.strictEqual(contacts.contactKey(CONTACT), contacts.contactKey({ ...CONTACT })));
    check("and differs when the person differs", () =>
      assert.notStrictEqual(contacts.contactKey(CONTACT),
        contacts.contactKey({ ...CONTACT, displayName: "Ana Diez", emails: ["x@y.com"] })));
  }

  console.log("\nCreating notes from unmatched contacts");
  {
    const { plugin, store } = await boot({ newPersonTier: "casual" });
    const result = await plugin.applyContactImport([], false, undefined,
      [{ contact: CONTACT, name: "Ana Diaz" }]);

    check("reports one creation", () => {
      assert.strictEqual(result.created, 1);
      assert.strictEqual(result.written, 0);
      assert.deepStrictEqual(result.failed, []);
    });
    const text = store.get("People/Ana Diaz.md");
    check("the note carries the imported details", () => {
      assert.ok(/email: ana@example.com/.test(text), text);
      assert.ok(/prm-birthday: 04-17/.test(text), text);
      assert.ok(/company: Northwind/.test(text), text);
    });
    check("and the configured tier, so it is tracked at once", () =>
      assert.ok(/prm-tier: casual/.test(text), text));
    check("the birthday feeds the engine", () =>
      assert.strictEqual(typeof plugin.engine.get("People/Ana Diaz.md").daysUntilBirthday, "number"));

    check("one undo entry covers the creation", () => {
      const e = plugin.undo.peekUndo();
      assert.ok(e, "no entry");
      assert.ok(/create 1/.test(e.label), e.label);
    });
    await plugin.performUndo();
    check("undo removes the note it created", () =>
      assert.strictEqual(store.get("People/Ana Diaz.md"), undefined));
  }

  console.log("\nCreations and updates in one undoable step");
  {
    const { plugin, store } = await boot({},
      (v) => v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-tier: close\n---\n"));
    const plan = {
      personPath: "People/Sam.md", personName: "Sam",
      contact: { displayName: "Sam", emails: [], phones: [], labels: [] },
      confidence: "exact",
      changes: [{ key: "email", from: null, to: "sam@example.com" }],
    };
    const before = store.get("People/Sam.md");
    const result = await plugin.applyContactImport([plan], false, undefined,
      [{ contact: CONTACT, name: "Ana Diaz" }]);

    check("both halves are reported", () => {
      assert.strictEqual(result.created, 1);
      assert.strictEqual(result.written, 1);
    });
    check("the label names both", () =>
      assert.ok(/create 1, update 1/.test(plugin.undo.peekUndo().label),
        plugin.undo.peekUndo().label));

    await plugin.performUndo();
    check("one undo reverses the creation and the edit together", () => {
      assert.strictEqual(store.get("People/Ana Diaz.md"), undefined);
      assert.strictEqual(store.get("People/Sam.md"), before);
    });
    await plugin.performRedo();
    check("redo reapplies both", () => {
      assert.ok(store.get("People/Ana Diaz.md"));
      assert.ok(/sam@example.com/.test(store.get("People/Sam.md")));
    });
  }

  console.log("\nA name that already exists is skipped, not overwritten");
  {
    const { plugin, store } = await boot({},
      (v) => v.addFile("People/Ana Diaz.md", "---\ntags:\n  - people\n---\nhand-written\n"));
    const result = await plugin.applyContactImport([], false, undefined,
      [{ contact: CONTACT, name: "Ana Diaz" }]);
    check("counted as skipped", () => {
      assert.strictEqual(result.created, 0);
      assert.strictEqual(result.skipped, 1);
    });
    check("the existing note is untouched", () =>
      assert.ok(store.get("People/Ana Diaz.md").includes("hand-written")));
  }

  console.log("\nA user-edited created note survives undo");
  {
    const { plugin, store } = await boot({});
    await plugin.applyContactImport([], false, undefined, [{ contact: CONTACT, name: "Ana Diaz" }]);
    store.set("People/Ana Diaz.md", store.get("People/Ana Diaz.md") + "\nmy own thoughts\n");
    await plugin.performUndo();
    check("undo leaves a note the user has since edited alone", () => {
      const t = store.get("People/Ana Diaz.md");
      assert.ok(t && t.includes("my own thoughts"), "the edited note was deleted");
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
