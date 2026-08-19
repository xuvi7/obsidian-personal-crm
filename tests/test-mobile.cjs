/**
 * Mobile invariants.
 *
 * Two halves. The first renders the real dashboard header and checks the structure the
 * phone stylesheet depends on: hiding a button's label is only safe if the button is
 * named some other way. The second reads styles.css directly, because the CSS is where
 * every mistake in this work actually lived and none of it is reachable from a DOM the
 * browser never laid out — see AGENTS.md §5 on trusting harnesses.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { makeStub, makeVault } = require("./stub-obsidian.cjs");
const harness = require("./build.cjs");
const notices = [];
const stub = makeStub(notices);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);
global.window = { setTimeout, clearTimeout,
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout };

const V = require(harness.bundleModule("src/view.ts"));
const PluginClass = harness.loadPlugin();
// Comments are stripped first: this file's rules carry long explanatory comments, and
// a `}` inside one of them truncated every rule body the naive scan below returned.
const CSS = fs.readFileSync(path.join(harness.repoRoot, "styles.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

let passed = 0, failed = 0;
const check = (n, f) => { try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n     ${e.message}`); failed++; } };

/** The declarations inside one rule, by selector text. */
function ruleBody(selector) {
  const i = CSS.indexOf(selector);
  if (i === -1) return null;
  const open = CSS.indexOf("{", i);
  const close = CSS.indexOf("}", open);
  return open === -1 || close === -1 ? null : CSS.slice(open + 1, close);
}

async function bootView(count = 1) {
  const v = makeVault();
  for (let i = 0; i < count; i++) {
    v.addFile(`People/P${i}.md`, "---\ntags:\n  - people\nprm-tier: casual\n---\n");
  }
  const p = new PluginClass(v.app, { id: "personal-crm" });
  p.__data = { configured: true, notifyOnStartup: false, showStatusBar: false,
    personFolders: ["People"], journalSources: [] };
  await p.onload();
  p.engine.rebuild();
  const view = new V.PrmDashboardView({ app: v.app }, p);
  view.register = () => {};
  await view.onOpen();
  return view;
}

(async () => {
  console.log("The phone header can lose its labels safely");
  {
    const view = await bootView();
    const buttons = [...view.contentEl.querySelectorAll(".prm-header-buttons button")];

    check("there are header buttons to check", () => assert.ok(buttons.length >= 7, String(buttons.length)));

    check("every header button is named without its label", () => {
      // `body.is-phone .prm-btn-label { display: none }` leaves the icon alone, so a
      // button with no aria-label would become an unnamed square.
      const unnamed = buttons.filter((b) => !(b.getAttribute("aria-label") || "").trim());
      assert.strictEqual(unnamed.length, 0,
        "unnamed: " + unnamed.map((b) => b.textContent.trim() || "(icon)").join(", "));
    });

    check("no header button carries bare text outside .prm-btn-label", () => {
      // Bare text cannot be hidden by class, so it would survive into the icon-only
      // row and blow the header's width budget. `text` is the stub's own property for
      // a node's directly-set text; a wrapped label lives on a child instead.
      const bare = buttons.filter((b) => (b.text || "").trim().length > 0);
      assert.strictEqual(bare.length, 0,
        "unwrapped text: " + bare.map((b) => (b.text || "").trim()).join(", "));
    });

    check("every header button carries an icon to fall back to", () => {
      // Two shapes: a `.prm-action-icon` span for the labelled buttons, and setIcon
      // applied straight to the button for the `clickable-icon` ones.
      const hasIcon = (b) =>
        !!b.querySelector(".prm-action-icon") ||
        !!b.querySelector(".svg-icon") ||
        [...b.children].some((c) => c.classes && c.classes.has("svg-icon"));
      const iconless = buttons.filter((b) => !hasIcon(b));
      assert.strictEqual(iconless.length, 0,
        "iconless: " + iconless.map((b) => b.getAttribute("aria-label")).join(", "));
    });
  }

  console.log("\nThe touch tokens stay off the desktop");
  {
    check("every token is defined under body.is-mobile", () => {
      const body = ruleBody("body.is-mobile {");
      assert.ok(body, "no `body.is-mobile` token block");
      for (const t of ["--prm-tap", "--prm-field-font", "--prm-link-pad", "--prm-cell-size"]) {
        assert.ok(body.includes(t), `${t} not defined there`);
      }
    });

    check("no token is defined at the top level, where it would reach the desktop", () => {
      // A token declared outside a mobile block turns every `var(--prm-tap, …)`
      // fallback below into a live value on desktop too.
      const stray = CSS.split("\n").filter((l) => /^\s*--prm-(tap|field-font|link-pad|cell-size)\s*:/.test(l));
      const inMobile = (ruleBody("body.is-mobile {") || "").split("\n")
        .filter((l) => /^\s*--prm-/.test(l)).length;
      assert.strictEqual(stray.length, inMobile,
        `${stray.length - inMobile} token declaration(s) outside the mobile block`);
    });

    check("every rule reading a token supplies a fallback or sits under is-mobile", () => {
      // `min-height: var(--prm-tap)` with no fallback is only safe inside a selector
      // that already requires is-mobile; anywhere else it resolves to nothing.
      const lines = CSS.split("\n");
      const bad = [];
      let selector = "";
      for (const line of lines) {
        if (line.includes("{")) selector = line;
        const m = /var\((--prm-(?:tap|field-font|link-pad|cell-size))\s*\)/.exec(line);
        if (m && !/is-mobile|is-phone/.test(selector)) bad.push(selector.trim() + " → " + line.trim());
      }
      assert.deepStrictEqual(bad, []);
    });
  }

  console.log("\nTap sizes are in px, because rem follows the theme's root");
  {
    check("no tap-critical length is expressed in rem", () => {
      // A 14px root turns `min-height: 2rem` into 28px, silently below the minimum.
      // This is how the chip minimum was wrong the first time.
      const body = ruleBody("body.is-mobile {");
      assert.ok(!/\d\s*rem/.test(body.replace(/--prm-link-pad[^;]*;/, "")),
        "rem in the token block: " + body.trim());
      const chip = ruleBody("body.is-mobile .prm-chip-button {");
      assert.ok(chip && /min-height:\s*\d+px/.test(chip), "chip minimum is not in px: " + chip);
    });

    check("--prm-tap is at least the 44px platform minimum", () => {
      const m = /--prm-tap:\s*(\d+)px/.exec(ruleBody("body.is-mobile {"));
      assert.ok(m, "--prm-tap is not a px value");
      assert.ok(Number(m[1]) >= 44, `--prm-tap is ${m[1]}px`);
    });

    check("text fields reach 16px, or iOS zooms the pane on focus", () => {
      const m = /--prm-field-font:\s*(\d+)px/.exec(ruleBody("body.is-mobile {"));
      assert.ok(m, "--prm-field-font is not a px value");
      assert.ok(Number(m[1]) >= 16, `--prm-field-font is ${m[1]}px`);
    });
  }

  console.log("\nThe layout bugs this work found stay fixed");
  {
    check("the narrow toolbar turns wrap off when it turns column on", () => {
      // Wrap in a column container makes items form extra *columns*: the toolbar grew
      // to its max-content width and pushed the sort control off the pane, behind
      // `.prm-view { overflow: hidden }`.
      const i = CSS.indexOf("@container (max-width: 700px)");
      const region = CSS.slice(i, i + 2600);
      const j = region.indexOf(".prm-toolbar {");
      assert.ok(j !== -1, ".prm-toolbar not found in the narrow block");
      const body = region.slice(j, region.indexOf("}", j));
      assert.ok(/flex-direction:\s*column/.test(body), "not a column: " + body);
      assert.ok(/flex-wrap:\s*nowrap/.test(body), "column without nowrap: " + body);
    });

    check("the phone header-button rule outranks the min-width:0 rule", () => {
      // Both target the same buttons. (0,2,1) loses to (0,3,1) regardless of order, so
      // the icon-only buttons went back to 32px wide until this selector was deepened.
      const sel = "body.is-phone .prm-view .prm-header-buttons button:not(.clickable-icon)";
      assert.ok(CSS.includes(sel), "the deepened selector is gone");
      const classes = (s) => (s.match(/\.[a-z-]+|:not\([^)]*\)|\[[^\]]*\]/g) || []).length;
      const narrower = "body.is-mobile .prm-view .prm-header-buttons button:not(.clickable-icon)";
      assert.ok(classes(sel) >= classes(narrower), `${classes(sel)} vs ${classes(narrower)}`);
    });

    check("the checkbox keeps a hit area larger than the box it draws", () => {
      const before = ruleBody("body.is-mobile .prm-select::before,");
      assert.ok(before, "no ::before overlay rule");
      assert.ok(/width:\s*var\(--prm-tap\)/.test(before), "overlay is not tap-sized: " + before);
      assert.ok(/position:\s*absolute/.test(before), "overlay is not positioned: " + before);
    });

    check("the tap minimum reaches the calendar's tabs, not just the dashboard's", () => {
      // The scale tabs live in .prm-cal-toolbar > .prm-tabs, so a `.prm-view .prm-tabs`
      // selector missed them entirely and left them 28px tall. Checked against the
      // selector list of the rule that actually grants the minimum: merely finding the
      // string somewhere in the file also matched the `min-width: 0` block below it,
      // which made this assertion survive the very change it exists to catch.
      const i = CSS.indexOf("min-height: var(--prm-tap);\n\tmin-width: var(--prm-tap);");
      assert.ok(i !== -1, "the tap-minimum rule is gone");
      const selectors = CSS.slice(0, i).split("}").pop().split("{")[0]
        .split(",").map((x) => x.trim()).filter(Boolean);
      const tabRule = selectors.find((x) => x.includes(".prm-tabs .prm-tab"));
      assert.ok(tabRule, "no .prm-tabs .prm-tab selector: " + selectors.join(" | "));
      assert.ok(!tabRule.includes(".prm-view"),
        "scoped to the dashboard, so the calendar's tabs miss out: " + tabRule);
    });
  }

  console.log("\nThe view controls its own overflow and padding");
  {
    // Obsidian's `.workspace-leaf-content .view-content` is (0,2,0) and sets BOTH
    // `padding: 12px 12px 32px` and `overflow: auto`. `.prm-view` is (0,1,0) and lost
    // both, which is what made the whole pane scroll sideways on a phone: 24px of the
    // width was gone and the overflow it caused scrolled instead of showing.
    const depth = (sel) => (sel.match(/\.[a-z-]+|:not\([^)]*\)|\[[^\]]*\]/g) || []).length;
    const OBSIDIAN = ".workspace-leaf-content .view-content";   // (0,2,0)

    check("the overflow reclaim outranks Obsidian's view-content rule", () => {
      const i = CSS.indexOf(".workspace-leaf-content .view-content.prm-view");
      assert.ok(i !== -1, "the overflow-reclaiming selector is gone");
      const sel = CSS.slice(i).split("{")[0].split(",")[0].trim();
      assert.ok(depth(sel) > depth(OBSIDIAN),
        `${sel} (${depth(sel)}) does not outrank ${OBSIDIAN} (${depth(OBSIDIAN)})`);
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/overflow:\s*hidden/.test(body), "not reclaiming overflow: " + body);
    });

    check("a phone reclaims the horizontal padding too", () => {
      const i = CSS.indexOf("body.is-phone .workspace-leaf-content .view-content.prm-view");
      assert.ok(i !== -1, "the phone padding reset is gone");
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/padding-inline:\s*0/.test(body), "not zeroing the sides: " + body);
      // The home indicator sits over the last row without this.
      assert.ok(/safe-area-inset-bottom/.test(body), "safe area dropped: " + body);
    });

    check("the phone header stays on one line by compressing, not wrapping", () => {
      // Seven buttons at 44px want ~332px of pane. Wrapping is the wrong fallback: a
      // flex line wraps *before* it shrinks, so allowing it put a second 44px row on
      // screen the moment the widest phone ran out of room. The row is nowrap and the
      // borderless buttons are shrinkable instead, which needs min-width < width or
      // there is no room to give.
      const i = CSS.indexOf("body.is-phone .prm-header-buttons {");
      assert.ok(i !== -1);
      const row = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/flex-wrap:\s*nowrap/.test(row), "row can wrap: " + row);

      const j = CSS.indexOf("body.is-phone .prm-view .prm-header-buttons button.clickable-icon {");
      assert.ok(j !== -1, "the borderless-button rule is gone");
      const icon = CSS.slice(CSS.indexOf("{", j), CSS.indexOf("}", j));
      const width = /(?:^|[^-])width:\s*(\d+)px/.exec(icon);
      const floor = /min-width:\s*(\d+)px/.exec(icon);
      assert.ok(width && floor, "width/min-width not both px: " + icon);
      assert.ok(Number(floor[1]) < Number(width[1]),
        `min-width ${floor[1]}px leaves no room to compress from ${width[1]}px`);
      assert.ok(/flex:\s*0\s+1\s/.test(icon), "not allowed to shrink: " + icon);
    });

    check("the filled buttons keep full size and never compress", () => {
      // They are the primary actions; only the borderless glyphs give ground.
      const i = CSS.indexOf("body.is-phone .prm-view .prm-header-buttons button:not(.clickable-icon) {\n\tflex:");
      assert.ok(i !== -1, "the no-shrink rule for filled buttons is gone");
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/flex:\s*0\s+0\s/.test(body), "filled buttons can shrink: " + body);
    });

    check("the list padding covers the checkbox's hit overlay", () => {
      // The 44px overlay reaches 11px past the 22px box; less padding than that lets it
      // poke outside the pane and widen the scroll area.
      const i = CSS.indexOf("body.is-phone .prm-list {");
      assert.ok(i !== -1);
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      const m = /padding:\s*0\s+(\d+)px/.exec(body);
      assert.ok(m, "side padding is not a px value: " + body);
      assert.ok(Number(m[1]) >= 11, `${m[1]}px is under the overlay's 11px reach`);
    });
  }

  console.log("\nSelection is a mode, and its bar is one line");
  {
    const view = await bootView(4);
    const root = view.contentEl;
    const bar = () => root.querySelector(".prm-bulkbar");
    const label = (sel) => {
      const el = root.querySelector(sel);
      if (!el) return null;
      // The stub keeps directly-set text on `text`; a wrapped label is on a child.
      return (el.text || "").trim() ||
        [...el.children].map((c) => (c.text || "").trim()).join(" ").trim();
    };

    check("nothing is selected to start, and the view is not in selection mode", () => {
      assert.ok(!root.classes.has("prm-selecting"));
      assert.ok(!bar().classes.has("prm-bulkbar-active"));
    });

    check("the toolbar no longer carries its own Select all", () => {
      // Two buttons with the same name, one of which silently no-ops, was the whole
      // confusion. Selection's Select all lives in the bar now.
      const toolbarButtons = root.querySelectorAll(".prm-controls button");
      for (const b of toolbarButtons) {
        assert.notStrictEqual((b.text || "").trim(), "Select all",
          "the toolbar's Select all is back");
      }
    });

    view.onSelectClick("People/P0.md", { shiftKey: false }, { checked: true });

    check("selecting puts the view into selection mode", () => {
      // The phone stylesheet hangs the hiding of stats and toolbar off this class,
      // rather than :has(), so it must be on the root whenever a selection exists.
      assert.ok(root.classes.has("prm-selecting"));
      assert.ok(bar().classes.has("prm-bulkbar-active"));
    });

    check("the count reports the selection and is a button that clears it", () => {
      assert.strictEqual(label(".prm-bulk-count"), "1 selected");
      const dismiss = root.querySelector(".prm-bulk-dismiss");
      assert.ok(dismiss, "no dismiss button");
      assert.strictEqual(typeof dismiss.onclick, "function");
      assert.ok((dismiss.getAttribute("aria-label") || "").length > 0, "dismiss is unnamed");
    });

    check("Select all is in the bar and takes everything listed", () => {
      assert.strictEqual(label(".prm-bulk-selectall"), "Select all");
      root.querySelector(".prm-bulk-selectall").onclick();
      assert.strictEqual(label(".prm-bulk-count"), "4 selected");
    });

    check("it stays Select all even with everything selected", () => {
      // It is not a dead slot to reuse: change the filter and the listed set changes
      // under it, so it is useful again. The count is what clears.
      assert.strictEqual(label(".prm-bulk-selectall"), "Select all");
    });

    check("tapping the count clears, from any state", () => {
      root.querySelector(".prm-bulk-dismiss").onclick();
      assert.ok(!root.classes.has("prm-selecting"));
      view.onSelectClick("People/P1.md", { shiftKey: false }, { checked: true });
      assert.strictEqual(label(".prm-bulk-count"), "1 selected");
      root.querySelector(".prm-bulk-dismiss").onclick();
      assert.ok(!root.classes.has("prm-selecting"),
        "a partial selection has no one-tap exit");
    });

    check("the filter button names the active filter", () => {
      view.onSelectClick("People/P2.md", { shiftKey: false }, { checked: true });
      const btn = root.querySelector(".prm-bulk-filter");
      assert.ok(btn, "no filter button");
      assert.ok((btn.getAttribute("aria-label") || "").startsWith("Filter:"),
        btn.getAttribute("aria-label"));
      // A phone hides the tabs while selecting, so this label is the only thing left
      // saying which filter is on.
      assert.ok(label(".prm-bulk-filter").length > 0, "the filter button has no label");
    });

    check("changing filter redraws the bar, so its label cannot go stale", () => {
      const before = label(".prm-bulk-filter");
      // The tab handler used to call renderToolbar and renderList but not
      // renderBulkBar, which left this label describing the tab you had left.
      view.setFilter("drifting");
      const after = label(".prm-bulk-filter");
      assert.notStrictEqual(after, before, `still "${after}" after changing filter`);
    });

    check("a search marks the filter button", () => {
      view.setQuery("#gym");
      const btn = root.querySelector(".prm-bulk-filter");
      assert.ok(btn.classes.has("prm-bulk-filter-on"), "a live query is not shown");
      assert.ok((btn.getAttribute("aria-label") || "").includes("#gym"),
        btn.getAttribute("aria-label"));
      view.setQuery("");
    });

    check("both renderings of the actions are built, from one list", () => {
      const buttons = root.querySelectorAll(".prm-bulk-btn");
      const more = root.querySelector(".prm-bulk-more");
      assert.strictEqual(buttons.length, 6, `${buttons.length} action buttons`);
      assert.ok(more, "no Actions button for the sheet");
      assert.strictEqual(typeof more.onclick, "function");
    });

    check("every action button is labelled, since the tag icons are near-identical", () => {
      for (const b of root.querySelectorAll(".prm-bulk-btn")) {
        const text = [...b.children].map((c) => (c.text || "").trim()).join("").trim();
        assert.ok(text.length > 0, "an action button has no label");
      }
    });
  }

  console.log("\nThe phone bar hides what it replaces");
  {
    check("the button row gives way to the sheet on a phone", () => {
      const i = CSS.indexOf("body.is-phone .prm-bulkbar .prm-bulk-btn,");
      assert.ok(i !== -1, "the hide rule is gone");
      const sel = CSS.slice(i, CSS.indexOf("{", i));
      // Select all is hidden with the six, because on a phone it leads the sheet.
      assert.ok(sel.includes(".prm-bulk-selectall"), "Select all is not hidden too: " + sel);
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/display:\s*none/.test(body), body);
      const show = ruleBody("body.is-phone .prm-bulk-more,");
      assert.ok(show && /display:\s*flex/.test(show), "the sheet button is not shown: " + show);
    });

    check("the filter button is the phone's stand-in for the hidden toolbar", () => {
      const hidden = ruleBody(".prm-bulk-more,");
      assert.ok(hidden && /display:\s*none/.test(hidden),
        "the filter button shows on wide panes, where the toolbar is already there");
      const shown = ruleBody("body.is-phone .prm-bulk-more,");
      assert.ok(shown && /display:\s*flex/.test(shown), shown);
      const search = ruleBody(".prm-sheet-search {");
      // The sheet's search box is a text field, so it is under the same iOS rule.
      assert.ok(search && /font-size:\s*var\(--prm-field-font/.test(search),
        "the sheet's search box can zoom the pane on iOS: " + search);
    });

    check("the bar is one line on a phone", () => {
      const body = ruleBody("body.is-phone .prm-bulkbar-active {");
      assert.ok(body && /flex-wrap:\s*nowrap/.test(body), "the bar can wrap: " + body);
    });

    check("selection mode hides the stats and the toolbar", () => {
      // 180px of an ~800px pane, none of it useful mid-selection. Without this the bar
      // stacked on top of the filter chrome and left three rows visible out of five.
      const i = CSS.indexOf("body.is-phone .prm-selecting .prm-stats,");
      assert.ok(i !== -1, "the selection-mode rule is gone");
      const sel = CSS.slice(i, CSS.indexOf("{", i));
      assert.ok(sel.includes(".prm-toolbar"), "the toolbar is not hidden: " + sel);
      const body = CSS.slice(CSS.indexOf("{", i), CSS.indexOf("}", i));
      assert.ok(/display:\s*none/.test(body), body);
    });

    check("the sheet's rows are tap-sized and full width", () => {
      const body = ruleBody(".prm-sheet-btn {");
      assert.ok(body, "no sheet button rule");
      assert.ok(/min-height:\s*var\(--prm-tap/.test(body), "not tap-sized: " + body);
      assert.ok(/width:\s*100%/.test(body), "not full width: " + body);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
