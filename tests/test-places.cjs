/** Locations: reading them, listing them, and setting them. */
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
    personFolders: ["People"], journalSources: [] }, settings);
  await p.onload();
  p.engine.rebuild();
  return { plugin: p, ...v };
}

(async () => {
  console.log("Reading a location");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nprm-location: Lisbon\n---\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\nlocation: Brooklyn, NY\n---\n");
      v.addFile("People/Bo.md", "---\ntags:\n  - people\ncity: Berlin\n---\n");
      v.addFile("People/Cy.md", "---\ntags:\n  - people\nprm-location: Lisbon\nlocation: Porto\n---\n");
      v.addFile("People/Dee.md", "---\ntags:\n  - people\n---\n");
      v.addFile("People/Eli.md", "---\ntags:\n  - people\nlocation:\n  - Tokyo\n  - Osaka\n---\n");
      v.addFile("People/Fay.md", "---\ntags:\n  - people\nlocation: \"   \"\n---\n");
    });
    const at = (n) => plugin.engine.get(`People/${n}.md`).location;
    check("prm-location is read", () => assert.strictEqual(at("Sam"), "Lisbon"));
    check("the importer's plain location is read", () => assert.strictEqual(at("Ana"), "Brooklyn, NY"));
    check("a city key is read", () => assert.strictEqual(at("Bo"), "Berlin"));
    check("prm-location wins over a plain one", () => assert.strictEqual(at("Cy"), "Lisbon"));
    check("no location reads as null", () => assert.strictEqual(at("Dee"), null));
    check("a list takes the first place", () => assert.strictEqual(at("Eli"), "Tokyo"));
    check("a blank value is not a place", () => assert.strictEqual(at("Fay"), null));

    check("allLocations counts by use, then name", () =>
      assert.deepStrictEqual(plugin.engine.allLocations(), [
        { place: "Lisbon", count: 2 },
        { place: "Berlin", count: 1 },
        { place: "Brooklyn, NY", count: 1 },
        { place: "Tokyo", count: 1 },
      ]));
  }

  console.log("\nSetting a place");
  {
    const { plugin, store } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\n---\n");
      v.addFile("People/Ana.md", "---\ntags:\n  - people\nlocation: Porto\n---\n");
    });
    const paths = ["People/Sam.md", "People/Ana.md"];
    const result = await plugin.bulkSetLocation(paths, "  Lisbon  ");

    check("both are set, trimmed", () => {
      assert.strictEqual(plugin.engine.get("People/Sam.md").location, "Lisbon");
      assert.strictEqual(plugin.engine.get("People/Ana.md").location, "Lisbon");
    });
    check("it reports what changed", () => assert.strictEqual(result.changed, 2));
    check("the importer's own field is left alone", () =>
      assert.ok(store.get("People/Ana.md").includes("location: Porto"),
        store.get("People/Ana.md")));
    check("one undo entry, named for the place", () =>
      assert.ok(/Lisbon/.test(plugin.undo.peekUndo().label), plugin.undo.peekUndo().label));

    await plugin.performUndo();
    check("undo puts it back", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").location, null));

    // Clearing removes only the key this plugin owns.
    await plugin.bulkSetLocation(["People/Ana.md"], "Lisbon");
    await plugin.bulkSetLocation(["People/Ana.md"], "");
    const ana = store.get("People/Ana.md");
    check("clearing drops prm-location", () => assert.ok(!ana.includes("prm-location"), ana));
    check("but keeps the plain one", () => assert.ok(ana.includes("location: Porto"), ana));
    check("so the plain one shows again", () =>
      assert.strictEqual(plugin.engine.get("People/Ana.md").location, "Porto"));
  }

  console.log("\nCustom location keys");
  {
    const { plugin } = await boot((v) => {
      v.addFile("People/Sam.md", "---\ntags:\n  - people\nwhere: Kyoto\n---\n");
    }, { locationKeys: ["where"] });
    check("a configured key is read", () =>
      assert.strictEqual(plugin.engine.get("People/Sam.md").location, "Kyoto"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
