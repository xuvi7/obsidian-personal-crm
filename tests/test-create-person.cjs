/** Creating people: template handling, settings, and undo. */
const Module = require("module");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o)=>(r,p,m)=>(r==="obsidian"?stub:o(r,p,m)))(Module._load);
global.window = { setTimeout, clearTimeout, requestAnimationFrame:(f)=>setTimeout(f,0), cancelAnimationFrame:clearTimeout };

// modals.ts is bundled here against the browser shim, which builds real DOM nodes.
// A minimal document is enough to construct and drive a modal headlessly.
const fakeEl = () => ({
  children: [], value: "", disabled: false, textContent: "",
  classList: { add() {}, remove() {}, toggle() {} },
  style: { setProperty() {} },
  appendChild(c) { this.children.push(c); return c; },
  remove() {}, empty() { this.children = []; }, setText(t) { this.textContent = t; },
  addClass() { return this; }, removeClass() { return this; },
  createEl() { return fakeEl(); }, createDiv() { return fakeEl(); }, createSpan() { return fakeEl(); },
  addEventListener() {}, setAttribute() {}, focus() {}, select() {},
});
global.document = { createElement: fakeEl, createElementNS: fakeEl, getElementById: () => null };
const PluginClass = harness.loadPlugin();

let passed=0, failed=0;
const check=(n,f)=>{try{f();console.log(`  ✓ ${n}`);passed++;}catch(e){console.error(`  ✗ ${n}\n     ${e.message}`);failed++;}};

async function boot(settings, build = () => {}) {
  const v = makeVault();
  build(v);
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = Object.assign({ configured:true, notifyOnStartup:false, showStatusBar:false,
    personFolders:["People"], journalSources:[] }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Folder resolution");
  {
    const a = await boot({});
    check("defaults to the first people folder", () =>
      assert.strictEqual(a.plugin.newPersonFolder(), "People"));
    const b = await boot({ newPersonFolder: "Contacts/New" });
    check("uses the dedicated setting when set", () =>
      assert.strictEqual(b.plugin.newPersonFolder(), "Contacts/New"));
    const c = await boot({ newPersonFolder: "Contacts\\New" });
    check("normalizes a Windows-style path", () =>
      assert.strictEqual(c.plugin.newPersonFolder(), "Contacts/New"));
  }

  console.log("\nCreating without a template");
  {
    const { plugin, store } = await boot({ newPersonTier: "close" },
      (v) => v.addFile("People/Existing.md", "---\ntags:\n  - people\n---\n"));
    const res = await plugin.createPerson("Sam Rivera");
    check("the note is created in the right folder", () => {
      assert.ok(res && res.created);
      assert.strictEqual(res.file.path, "People/Sam Rivera.md");
    });
    const text = store.get("People/Sam Rivera.md");
    check("it has the plugin's frontmatter and the two headings", () => {
      assert.ok(/tags:/.test(text), text);
      assert.ok(/prm-tier: close/.test(text), text);
      assert.ok(text.includes("# Facts") && text.includes("# Thoughts"), text);
    });
    check("the new person is indexed and tracked immediately", () => {
      const r = plugin.engine.get("People/Sam Rivera.md");
      assert.ok(r, "not indexed");
      assert.strictEqual(r.tierId, "close");
    });
    check("creating it is undoable", () => assert.ok(plugin.undo.canUndo()));
    await plugin.performUndo();
    check("undo removes the created note", () =>
      assert.strictEqual(store.get("People/Sam Rivera.md"), undefined));
    await plugin.performRedo();
    check("redo puts it back", () =>
      assert.ok(store.get("People/Sam Rivera.md"), "not restored"));
  }

  console.log("\nAn existing note is never overwritten");
  {
    const { plugin, store } = await boot({},
      (v) => v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\nimportant notes\n"));
    notices.length = 0;
    const res = await plugin.createPerson("Sam");
    check("returns the existing note and reports it", () => {
      assert.ok(res && res.created === false);
      assert.ok(notices.some((n) => /already exists/.test(n)), JSON.stringify(notices));
    });
    check("its content is untouched", () =>
      assert.ok(store.get("People/Sam.md").includes("important notes")));
  }

  console.log("\nWith a template");
  {
    const tpl = [
      "---",
      'creation date: <% tp.date.now("YYYY-MM-DD") %>',
      "tags:",
      "  - people",
      "---",
      "up:: [[People MOC]]",
      "",
      "# Facts",
      "- First met: <% tp.file.cursor() %>",
      "- Name check: <% tp.file.title %>",
      "- Email: {{email}}",
      "# Thoughts",
    ].join("\n");
    const { plugin, store } = await boot(
      { newPersonTemplate: "Templates/Person.md", newPersonFolder: "People" },
      (v) => v.addFile("Templates/Person.md", tpl),
    );
    await plugin.createPerson("Ana Diaz", { fields: { email: "ana@example.com" } });
    const text = store.get("People/Ana Diaz.md");
    check("the template is used", () => assert.ok(text.includes("up:: [[People MOC]]"), text));
    check("tp.date.now is evaluated, not left as syntax", () => {
      assert.ok(!/<%/.test(text), text);
      assert.ok(/creation date: \d{4}-\d{2}-\d{2}/.test(text), text);
    });
    check("tp.file.title becomes the person's name", () =>
      assert.ok(text.includes("Name check: Ana Diaz"), text));
    check("tp.file.cursor leaves nothing behind", () =>
      assert.ok(/- First met:\s*$/m.test(text), text));
    check("{{email}} is filled from the imported field", () =>
      assert.ok(text.includes("Email: ana@example.com"), text));
  }

  console.log("\nA missing template says so rather than silently differing");
  {
    const { plugin, store } = await boot({ newPersonTemplate: "Templates/Nope.md" });
    notices.length = 0;
    await plugin.createPerson("Bo Chen");
    check("warns about the missing template", () =>
      assert.ok(notices.some((n) => /not found/.test(n)), JSON.stringify(notices)));
    check("still creates a usable note", () =>
      assert.ok(store.get("People/Bo Chen.md").includes("# Facts")));
  }

  console.log("\nNames that can't be filenames");
  {
    const { plugin, store } = await boot({});
    await plugin.createPerson('Sam / "Rivera" : Jr');
    check("illegal characters are stripped", () => {
      const paths = [...store.keys()].filter((k) => k.startsWith("People/"));
      assert.ok(paths.some((p) => /Sam Rivera Jr/.test(p)), JSON.stringify(paths));
    });
    notices.length = 0;
    const none = await plugin.createPerson("///");
    check("a name with nothing usable is refused", () => {
      assert.strictEqual(none, null);
      assert.ok(notices.some((n) => /can't be used/.test(n)), JSON.stringify(notices));
    });
  }

  console.log("\nThe folder is created if missing");
  {
    const { plugin, store } = await boot({ newPersonFolder: "Areas/People/New" });
    const res = await plugin.createPerson("Cy Fox");
    check("nested folder is made and the note lands in it", () => {
      assert.ok(res && res.created);
      assert.ok(store.get("Areas/People/New/Cy Fox.md"), [...store.keys()].join(", "));
    });
  }

  console.log("\nThe UI entry point");
  {
    const { plugin } = await boot({ newPersonTier: "close" });
    check("the plugin exposes openCreatePerson for the dashboard button", () =>
      assert.strictEqual(typeof plugin.openCreatePerson, "function"));
    check("the command is registered under the same name as the button", () => {
      const cmd = (plugin.__cmds || []).find((c) => c.id === "create-person");
      assert.ok(cmd, "command not registered");
      assert.strictEqual(cmd.name, "Add a person…");
      assert.strictEqual(typeof cmd.callback, "function");
    });

    // Drive the modal the button opens.
    const modals = require(harness.bundleModule("src/modals.ts"));
    check("CreatePersonModal is exported", () =>
      assert.strictEqual(typeof modals.CreatePersonModal, "function"));

    const calls = [];
    const fake = {
      app: plugin.app,
      settings: plugin.settings,
      newPersonFolder: () => plugin.newPersonFolder(),
      createPerson: async (name, opts) => { calls.push({ name, opts }); return null; },
    };
    const modal = new modals.CreatePersonModal(fake);
    check("the tier defaults to the configured newPersonTier", () =>
      assert.strictEqual(modal.tierId, "close"));

    modal.name = "  Sam Rivera  ";
    await modal.submit();
    check("it creates with the trimmed name and the chosen tier, and opens the note", () => {
      assert.strictEqual(calls.length, 1, JSON.stringify(calls));
      assert.strictEqual(calls[0].name, "Sam Rivera");
      assert.strictEqual(calls[0].opts.tierId, "close");
      assert.strictEqual(calls[0].opts.open, true);
    });

    calls.length = 0;
    modal.name = "   ";
    await modal.submit();
    check("a blank name creates nothing", () => assert.strictEqual(calls.length, 0));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e=>{console.error("SUITE ERROR:",e.stack);process.exit(1);});
