/** The dashboard's windowed list: filtering, selection and chunking over the data. */
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

const V = require(harness.bundleModule("src/view.ts"));
const PluginClass = harness.loadPlugin();

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

async function boot(count) {
  const v = makeVault();
  for (let i = 0; i < count; i++) {
    const tag = i % 3 === 0 ? "  - work\n" : "";
    const place = i % 5 === 0 ? "prm-location: Lisbon\n" : "";
    v.addFile(`People/Person ${String(i).padStart(4, "0")}.md`,
      `---\ntags:\n  - people\n${tag}prm-tier: casual\nprm-last-contacted: 2020-01-0${(i % 9) + 1}\n${place}---\n`);
  }
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = { configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [] };
  await p.onload();
  p.engine.rebuild();

  const view = new V.PrmDashboardView({ app: v.app }, p);
  view.register = () => {};
  await view.onOpen();
  return { plugin: p, view };
}

const rowsBuilt = (view) => view.contentEl.querySelectorAll(".prm-row").length;
const sentinel = (view) => view.contentEl.querySelectorAll(".prm-list-sentinel").length;

(async () => {
  console.log("Only one viewport is built up front");
  {
    const { view } = await boot(500);
    check("all 500 are in the window", () => assert.strictEqual(view.rowOrder.length, 500));
    // The chunk size is a tuning constant; assert the behaviour, not the number.
    const chunk = rowsBuilt(view);
    check("but only a chunk is rendered", () =>
      assert.ok(chunk > 0 && chunk < 500, `${chunk} of 500`));
    check("a sentinel guards the rest", () => assert.strictEqual(sentinel(view), 1));

    // Each append adds a chunk and moves the sentinel down.
    view.appendChunk(chunk);
    check("appending builds the next chunk", () =>
      assert.strictEqual(rowsBuilt(view), chunk * 2));
    check("the sentinel is still last", () => {
      const kids = view.listEl.children;
      assert.ok(kids[kids.length - 1].classes.has("prm-list-sentinel"));
    });

    while (rowsBuilt(view) < 500) view.appendChunk(chunk);
    check("the whole list can be built", () => assert.strictEqual(rowsBuilt(view), 500));
    check("and the sentinel is gone at the end", () => assert.strictEqual(sentinel(view), 0));
  }

  console.log("\nA small list needs no sentinel");
  {
    const { view } = await boot(12);
    check("every row is built", () => assert.strictEqual(rowsBuilt(view), 12));
    check("no sentinel", () => assert.strictEqual(sentinel(view), 0));
  }

  console.log("\nSearching filters the data, not the built rows");
  {
    const { view } = await boot(500);
    // A person far beyond the first chunk.
    view.setQuery("Person 0499");
    check("a match beyond the window is found", () => {
      assert.strictEqual(view.rowOrder.length, 1);
      assert.strictEqual(rowsBuilt(view), 1);
    });
    check("and it's the right one", () =>
      assert.strictEqual(view.rowOrder[0], "People/Person 0499.md"));

    view.setQuery("#work");
    check("a tag query spans the whole list", () => {
      assert.ok(view.rowOrder.length > 100, `${view.rowOrder.length}`);
      assert.ok(rowsBuilt(view) < view.rowOrder.length, "should still be windowed");
    });
    view.setQuery("@Lisbon");
    check("so does a place query", () => assert.ok(view.rowOrder.length > 50, `${view.rowOrder.length}`));

    view.setQuery("nobodyhere");
    check("no matches says so", () => {
      assert.strictEqual(view.rowOrder.length, 0);
      assert.strictEqual(rowsBuilt(view), 0);
      assert.strictEqual(view.contentEl.querySelectorAll(".prm-no-matches").length, 1);
    });

    view.setQuery("");
    check("clearing restores the full window", () => {
      assert.strictEqual(view.rowOrder.length, 500);
      assert.ok(rowsBuilt(view) > 0 && rowsBuilt(view) < 500, `${rowsBuilt(view)}`);
    });
  }

  console.log("\nSelection covers the window, not the rendered rows");
  {
    const { view } = await boot(500);
    view.visiblePathsForTest = view.visiblePaths;
    check("select-all takes every match", () => {
      const all = view.visiblePaths();
      assert.strictEqual(all.length, 500);
    });

    // A shift-range spanning rows that were never rendered.
    view.applySelect(view.rowOrder[0], false, true);
    view.applySelect(view.rowOrder[400], true, true);
    check("a shift-range spans unbuilt rows", () => assert.strictEqual(view.selection.size, 401));

    // A row built later must come up already selected.
    view.appendChunk(500);
    const rows = Array.from(view.listEl.children).filter((c) => c.classes.has("prm-row"));
    check("appended rows inherit selection state", () => {
      const selected = rows.filter((r) => r.classes.has("prm-row-selected")).length;
      assert.strictEqual(selected, 401, `${selected}`);
    });

    view.clearSelection();
    check("clearing empties it", () => assert.strictEqual(view.selection.size, 0));
  }

  console.log("\nFilters and sorts reset the window");
  {
    const { view } = await boot(500);
    while (rowsBuilt(view) < 500) view.appendChunk(100);
    const wasFullyBuilt = rowsBuilt(view);
    view.sort = "name";
    view.renderList();
    check("a sort change rebuilds one chunk", () => {
      assert.strictEqual(wasFullyBuilt, 500);
      assert.ok(rowsBuilt(view) < 500, `${rowsBuilt(view)} still built`);
    });
    check("in the new order", () =>
      assert.strictEqual(view.rowOrder[0], "People/Person 0000.md"));

    view.filter = "unclassified";
    view.renderList();
    check("a filter with no matches shows its empty state", () => {
      assert.strictEqual(view.rowOrder.length, 0);
      assert.ok(view.contentEl.querySelectorAll(".prm-empty").length >= 1);
    });
  }

  console.log("\nSearch keys are cached and invalidated");
  {
    const { plugin, view } = await boot(50);
    view.setQuery("Person 0001");
    check("keys are memoized per record", () => assert.ok(view.searchKeys.size > 0));
    plugin.engine.rebuild();
    // onOpen subscribed to the engine, which clears the cache.
    check("an index change clears them", () => assert.strictEqual(view.searchKeys.size, 0));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
