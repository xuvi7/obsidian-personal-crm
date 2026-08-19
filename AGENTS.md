# Working on this codebase

Orientation for an agent (or a person) picking this repo up cold. `README.md` explains
what the plugin does for a *user*; this file explains how it is built, what must not be
broken, and which mistakes have already been made so they need not be made again.

---

## 1. What it is, in one paragraph

An Obsidian plugin that turns a folder of person notes into a relationship manager. Its
central idea is that **contact history already exists in the vault** — you wrote who you
saw in your daily notes — so the plugin derives history from wikilinks in dated notes
rather than asking anyone to enter data. Everything else (cadences, follow-ups, places,
a drift signal, a contact calendar) is built on that index.

---

## 2. Architecture

```
metadataCache ──► engine.ts ──► PersonRecord[] ──► view.ts        (dashboard)
(Obsidian)        (the index)                  ├─► calendar-view.ts
                                               └─► modals.ts     (dialogs)

writes: modals/view ──► main.ts ──► writes.ts (queue) ──► vault.process
                          └──────► undo.ts   (snapshots)
```

- **`engine.ts`** owns the index. `rebuild()` walks every markdown file once, classifies
  it (person note / journal / neither), and produces a `PersonRecord` per person. It is
  the only place that decides what a person *is*.
- **`main.ts`** owns every write. Nothing else touches the vault.
- **`view.ts`**, **`calendar-view.ts`**, **`modals.ts`** are read-only consumers of
  records; they call `main.ts` to change anything.
- **`types.ts`** is the contract between them.

### The full module map

| File | Role |
| --- | --- |
| `engine.ts` | The index: classification, link attribution, cadence/status/rhythm maths |
| `main.ts` | Plugin lifecycle, commands, and **all** vault writes |
| `types.ts` | `PersonRecord`, `LoopRef`, diagnostics — the shared contract |
| `settings.ts` | Settings schema, declarative settings UI, `FRONTMATTER_KEYS` |
| `view.ts` | Dashboard: windowed list, filters, sort, multi-select, bulk bar |
| `calendar.ts` | Pure bucketing maths for the contact calendar (all four scales) |
| `calendar-view.ts` | The calendar view built on `calendar.ts` |
| `modals.ts` | Every dialog: person panel, log, reach-out, triage, pickers |
| `loops.ts` | Follow-up tasks: locating, completing, appending |
| `undo.ts` | Snapshot undo/redo with pre-flight validation and rollback |
| `writes.ts` | Per-path write serialisation (`WriteQueue`) |
| `dates.ts` | UTC-anchored day arithmetic and ISO validation |
| `journal.ts` | Filename → date via moment formats, memoized |
| `frontmatter.ts` | Narrowing untyped frontmatter to safe values |
| `detect.ts` | First-run detection of Daily/Periodic Notes config |
| `contacts.ts` | CSV/vCard parsing, name matching, change planning |
| `import-modal.ts` | Import review UI |
| `templates.ts` | Person-note templating, incl. partial Templater translation |

---

## 3. Invariants — do not break these

These are load-bearing. Each one exists because of a specific failure.

### 3.1 The index reads only `metadataCache`, never file contents

A rebuild is ~3 ms over 2,372 files *because* it never opens a file. Any feature that
needs file text must read it **on demand**, not during indexing.

Worked example: follow-ups index only a task's `{path, line, offset}`; the task's words
are read when a panel displays them, from the handful of files that actually hold one.
Had the text been indexed, rebuild cost would scale with vault bytes.

### 3.2 An unchecked task is an intention, not contact

Links inside unchecked tasks, blockquotes, code fences and embeds are excluded from
contact detection, positionally (`excludedRanges` in `engine.ts`). Without this, writing
`- [ ] reach out to [[Sam]]` marks Sam as contacted and silences the very reminder that
prompted it.

Three features compose off this and will break if it changes:

- Those same open tasks *are* the follow-ups (`openTasks`).
- The daily reach-out block writes `- [ ] [[Sam]]`, so being listed cannot count as
  contact — and **ticking the box makes it a completed task, which does count**. The
  gesture meaning "done" is the one that logs it.
- Tasks under the nudge's own heading are excluded from follow-ups, or the block would
  restate the Due tab and accumulate daily.

### 3.3 Every write is atomic, queued, and undoable

`main.ts` writes through `vault.process` (atomic read-modify-write) inside a per-path
`WriteQueue`, and snapshots the file for undo *inside* the queued turn. Bypassing any of
those three re-introduces bugs that were already fixed: clobbering a concurrent edit,
interleaving multi-step writes, and an undo entry that absorbs someone else's change.

### 3.4 Obsidian's cache is one-directional

`getFileCache(f).links` holds links written **in** `f`, never links pointing **at** it.
Backlinks require inverting `resolvedLinks`. This is why dated links inside a person's
own note needed their own pass — the journal pass could never have seen them.

### 3.5 The dashboard list is windowed

`view.ts` builds one viewport of rows and appends chunks as a sentinel scrolls into view.
Consequently **filtering and sorting must operate on data, never on built rows**. If you
add a feature that walks `listEl.children` to decide something, it will be wrong for
every row that hasn't been rendered: search would miss people, "Select all" would mean
"everything scrolled past", and a shift-range would stop at the last built row.

---

## 4. Platform traps that have already cost time

### 4.1 Obsidian's button rules outrank a single plugin class

From Obsidian's `app.css`:

```css
button                      { padding; height; border-radius }   /* (0,0,1) */
button:not(.clickable-icon) { background-color; box-shadow }     /* (0,1,1) */
```

A plugin's single class is **(0,1,0)**: it beats the first rule and **loses to the
second**. Any `<button>` you style with one class keeps the app's grey background and
shadow no matter how you set the colour. Use two classes or an ancestor selector.

This produced two visible bugs (calendar cells and tier chips rendering as grey
buttons) and three failed fix attempts before being diagnosed. **The tell**: identical
markup renders correctly as a `<span>` and wrongly as a `<button>`.

You can read the app's real CSS:

```bash
strings -n 4 /Applications/Obsidian.app/Contents/Resources/obsidian.asar | grep -A 20 "^button {"
```

### 4.1b Obsidian styles `.view-content` too, and outranks you there as well

```css
.workspace-leaf-content .view-content {            /* (0,2,0) */
  padding: var(--size-4-3) var(--size-4-3) var(--size-4-8);   /* 12px 12px 32px */
  padding-bottom: max(var(--safe-area-inset-bottom), var(--size-4-8));
  overflow: auto;
}
```

A custom view's root element **is** `.view-content`, so a plugin's `.prm-view` (0,1,0)
loses both declarations. Consequences that went unnoticed for a long time:

- The `padding: 0` at the top of this file never applied. The desktop layout has always
  been drawn inside Obsidian's 12px — which is fine, and is deliberately left alone.
- `overflow: hidden` never applied either, so the view scrolled instead of clipping. On a
  phone the pane is 24px narrower than it looks, the seven-icon header row did not fit,
  and the whole view scrolled sideways.

`.workspace-leaf-content .view-content.prm-view` is (0,3,0) and settles it. Only `overflow`
is reclaimed everywhere; the horizontal padding is reclaimed on `.is-phone` only, where the
24px matters. Note Obsidian resets this itself for markdown views
(`.workspace-leaf-content[data-type='markdown'] .view-content { padding: 0; overflow: hidden }`) —
custom views do not get that.

Clipping is only safe because every region that can grow has its own scroller:
`.prm-list { overflow-y: auto }`, `.prm-cal-body { overflow: auto }`,
`.prm-cal-detail { max-height: 40%; overflow-y: auto }`. Check that before adding another.

### 4.2 A failed `var()` goes transparent, not to a fallback

`var()` substitution failure is invalid **at computed-value time**, which — unlike a
parse error — does *not* fall back to an earlier declaration in the same rule. The
property becomes `unset`, and an unset `background-color` is transparent. So this buys
nothing:

```css
.cell { background-color: #c6e48b;              /* dead weight */
        background-color: hsl(var(--accent-h) …); }
```

An unsupported `color-mix()`, by contrast, *is* a parse error and does fall back.

Themes make this real: **AnuPpuccin defines none of `--accent-h`, `--accent-s`,
`--accent-l`** and sets `--interactive-accent` directly, so anything built from the
accent *components* is guessing. Prefer whole colour variables.

The pattern that works: level classes set **custom properties** (nothing competes for
those, so their specificity is irrelevant) and one over-specific rule **consumes** them.

### 4.3 A plugin reload is required

Obsidian reads `styles.css` **and registers view types** only when the plugin loads.
Editing files on disk changes nothing in a running session and `Cmd+R` is not enough:
disable and re-enable the plugin. Rule this out before debugging a CSS or new-view
problem — it has wasted a whole debugging session.

### 4.4 Never take a byte offset from the cache into a write

`metadataCache` is correct about structure (it knows what's inside a code fence) and
**wrong about position immediately after a write**, because it updates asynchronously.
Taking a heading's `position.end.offset` from the cache and slicing the file at it put
a log bullet inside the frontmatter and destroyed it — the caller had grown the
frontmatter first, so the offset was short by exactly that many bytes. A length guard
cannot detect this.

Locate structure from **the content passed to `vault.process`**. `markdown.ts` exists
for this: `findHeading`/`sectionEnd`/`shallowestHeadingLevel` scan the real bytes and
skip frontmatter and fenced code, so they are neither stale nor fooled by a heading
shown as an example inside a fence. Both hazards are real and were both live.

### 4.5 The metadata cache updates asynchronously after a write

A rebuild triggered immediately after a write can see a note **without its
frontmatter**, which rendered as "unclassified" in a panel that only drew once. Any
long-lived UI showing record data should subscribe to `engine.onChange` and redraw.

---

### 4.6 Obsidian's `button` rule sets *three* properties

`button:not(.clickable-icon)` sets `background-color`, `box-shadow` **and `color`**.
Covering the first two and forgetting the third is a mistake already made here: every
tier chip rendered neutral grey and the "unknown tier" chip stopped being red, long
after the "fix". If you are fighting this rule, enumerate all three.

### 4.7 A media query measures the window, not the pane

Obsidian sidebars are narrow while the window is wide, so `@media (max-width: …)`
**never fires for the case you wrote it for**. The plugin's entire narrow-layout block
was dead: a 320px sidebar in a 1100px window kept the wide layout, overflowed, and
clipped the sort control out of reach behind `overflow: hidden`. Use `@container`, with
`container-type: inline-size` on the view root — Obsidian's own `app.css` does.

### 4.8 Read Obsidian's real CSS instead of reasoning about it

```bash
strings -n 4 /Applications/Obsidian.app/Contents/Resources/obsidian.asar \
  | grep -A 20 "^button {"
```

Every CSS conclusion in this file came from that command. Three separate rounds of
plausible reasoning about `color-mix`, `--accent-h/s/l` and fallback ordering were all
wrong, and none of it mattered — the declarations were correct and never applied.

### 4.9 Mobile is a body class, not a media query

Obsidian puts `.is-mobile`, `.is-phone`, `.is-tablet`, `.is-ios` and `.is-android` on the
body and keys **288** of its own rules off `.is-phone`. It never uses `pointer: coarse`
anywhere. Follow the host: take its word for the device rather than inferring one, so a
laptop with a touchscreen does not get phone layout.

**`is-phone` vs `is-tablet` is decided by window size, not by hardware.** From the app's
own source:

```js
i = window.matchMedia("(min-width: 600px) and (min-height: 600px)");
Yl.isTablet = i.matches;  Yl.isPhone = !i.matches;
document.body.toggleClass("is-tablet", Yl.isTablet);
document.body.toggleClass("is-phone", Yl.isPhone);
```

It re-evaluates on every resize, and the whole block only runs when `isMobile` — desktop
never gets either class. Consequences for testing:

- **`Cmd+P` → "Emulate mobile"** (or `app.emulateMobile(true)` in the console; it sets a
  localStorage flag and reloads) puts the real classes on the real app with the real vault.
  This is a better test than any harness.
- In a normal-sized window that gives you **`is-mobile is-tablet`** — tap targets but no
  phone compaction. **Shrink the window under 600px** in either dimension to get
  `is-phone`. Testing the phone layout in a large emulated window shows almost nothing and
  reads as "the mobile work did nothing".
- A phone in landscape is still a phone: 844×390 fails `min-height: 600px`. An iPad in
  portrait is a tablet. That matches what the two classes are used for here.

The mobile section of `styles.css` defines four tokens under `body.is-mobile` and nothing
anywhere else:

| Token | Value | Why |
| --- | --- | --- |
| `--prm-tap` | `44px` | the platform minimum tap target on iOS and Android |
| `--prm-field-font` | `16px` | **below 16px, iOS zooms the pane when a field takes focus** |
| `--prm-link-pad` | `8px` | grows an inline link's hit box |
| `--prm-cell-size` | `22px` | calendar day cell; 13px is ~3.4mm |

Every rule reads them with a fallback — `min-height: var(--prm-tap, auto)` — so off mobile
the token is undefined, the fallback applies, and **the desktop layout is byte-identical**.
Verified by loading the harness with and without `?device=phone`. Two consequences:

- **Never declare one of those tokens outside a `body.is-mobile` block.** It would turn
  every fallback in the file into a live value on the desktop at once.
- **Tap sizes are in `px`, never `rem`.** `rem` follows the root font size, which themes
  change; at a 14px root a `2rem` minimum silently becomes 28px. That is a bug this
  codebase already shipped once, inside a single session.

`.is-phone` additionally buys back vertical space, because the chrome was taking ~700px of
an 804px pane and leaving room for one and a half people:

- the `<h2>` goes — Obsidian's own view header already names the view on a phone;
- header button labels go, leaving an icon-only row. This is why `renderHeader` wraps every
  label in `.prm-btn-label` and gives every button an `aria-label` **and** an icon. Adding a
  header button without all three leaves an unnamed blank square on a phone; `test-mobile`
  fails if you do. Seven buttons still do not fit at 44px each, so the four `.clickable-icon`
  ones sit flush and shrink from 40px toward a 28px floor while the three filled ones hold
  full size. **Do not make that row `flex-wrap: wrap`** — a flex line wraps before it
  shrinks, so wrapping puts a whole second 44px row on screen as soon as the pane tightens,
  which is worse than a slightly narrower glyph. Height stays 44px regardless, and adjacent
  targets mean a near-miss hits a neighbour rather than nothing;
- the filter tabs and the stats strip become one horizontally-scrolling row each;
- **the per-row icon buttons go.** At 21×28 they were unusable and at 44px they cost a line
  per row, and every one of them is in the panel a row-tap opens — the fast path on touch.
  Tablets and desktops keep them.

Chrome 700px → 196px, rows 190px → 144px, one and a half rows visible → six.

**Selection is a mode.** A live selection used to add the bulk bar *on top of* the filter
chrome: six labelled buttons wrapped to three rows, 157px on top of an already 232px
chrome — 49% of the pane, three people visible out of five. On `.is-phone` the stats strip
and the whole toolbar (tabs, Select all, search, sort) hide instead, because none of them is
what you are using mid-selection, and the bar is one line:

```
phone:   [✕ 2 selected]   [⧩ Tracked]   [Actions ⋯]
wide:    [✕ 2 selected]   [Select all]  [Log contact][Set cadence][Add tag]…
```

Chrome 389px → 108px, so selecting shows **more** rows than not selecting (6 vs 5). Four
things hold that together:

- `renderBulkBar` toggles `.prm-selecting` on the view root. A class rather than `:has()`,
  so it cannot depend on selector support, set from the one place the selection size
  changes.
- **The count is the clear**, and carries an `x` icon. There is no separate Clear button on
  any platform.
- **Select all lives in the selection bar, not the toolbar.** The toolbar used to carry its
  own, which meant two buttons with the same name — and the toolbar's is hidden on a phone
  mid-selection anyway. It is *not* a dead slot to reuse when everything listed is already
  selected: change the filter and the listed set changes under it.
- **A filter button stands in for the hidden toolbar.** Hiding the toolbar took the tabs and
  the search with it, and selecting across filters ("all of Due, then all of Drifting") is
  the flow that makes Select all worth having. `FilterSheetModal` carries both, and the
  button's label is the only thing left saying which filter is active — it turns the accent
  colour when a search is also narrowing the list.

**A filter change must redraw the bulk bar.** The tab handler called `renderToolbar` and
`renderList` but not `renderBulkBar`, so the bar's label went on describing the tab you had
left. Everything that changes the listed set goes through `setFilter` or `setQuery`, both of
which redraw all three.

The actions are defined once as `BulkAction[]` and rendered twice — as the button row a wide
pane shows, and as `BulkActionsModal`'s rows on a phone, where Select all leads them because
its own button is hidden at that width. **Both renderings are always in the DOM and CSS
picks one**, so a resize across the phone/tablet boundary (which Obsidian re-evaluates live,
§4.9) cannot leave the bar in the other width's shape. The sheet is labelled, not icon-only,
because `tag` and `tags` are near-identical glyphs and getting Add/Remove tag wrong edits
every selected note.

One consequence worth knowing: with the toolbar's Select all gone, selecting everything
starts by ticking one row, on every platform. There is no bar until there is a selection.

Two traps that are not about size:

- `.prm-row-meta` and `.prm-name-row` are **flex** containers, so `padding-block` on a link
  inside them grows the box for real rather than just overflowing a line box, and fights
  the default `align-items: stretch`. They set `align-items: center` on mobile.
- `flex-wrap: wrap` in a `flex-direction: column` container makes items wrap into extra
  **columns**. The narrow toolbar inherited `wrap` from the wide layout, grew to its
  483px max-content width inside a 331px pane, and pushed the sort control off the edge
  behind `.prm-view { overflow: hidden }`. Any pane under 700px had this, phone or not.

## 5. Build, deploy, verify

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint, incl. the official obsidianmd ruleset
npm run build                     # typecheck + bundle
./deploy.local.sh                 # build + copy into the author's vault (gitignored)
```

Both `typecheck` and `lint` are expected to be **completely clean**. The lint config
includes `eslint-plugin-obsidianmd`; if it objects to direct `element.style.x =`, the
sanctioned APIs are `setCssProps` (custom properties) and `setCssStyles`.

### Tests

```bash
npm test                          # typecheck + lint + all 26 suites
npm run test:only                 # just the suites (skips typecheck/lint)
node tests/test-drift.cjs         # one suite, directly
```

`tests/run.cjs` builds the bundle **once** into `tests/.build/` (gitignored), then runs
each `tests/test-*.cjs` as its own child process and prints a one-line summary per suite.
It exits non-zero if any suite fails. Child stderr is captured rather than inherited,
because several suites deliberately exercise error paths and log to stderr — you only see
that output when a suite actually fails.

Each suite is a standalone Node script with its own tiny `check()` helper. They bundle the
**real** source with esbuild and drive it against a fake vault (`tests/stub-obsidian.cjs`)
that stores real text and computes a realistic metadata cache. ~550 assertions across 26
files.

Shared helpers live in `tests/build.cjs`:

| Helper | What it gives you |
| --- | --- |
| `buildOnce()` | builds `src/main.ts` into `tests/.build/`, idempotent per process |
| `loadPlugin()` | `require`s the built plugin bundle |
| `bundleModule("src/x.ts")` | bundles one module standalone and returns its path |
| `realVault()` | the path from `PRM_TEST_VAULT`, or `null` |

`obsidian` is not a real package. Every suite must intercept it **before** requiring any
bundle:

```js
const Module = require("module");
const { makeStub } = require("./stub-obsidian.cjs");
const stub = makeStub([]);
Module._load = ((o) => (r, p, m) => (r === "obsidian" ? stub : o(r, p, m)))(Module._load);
```

Two **opt-in** env vars, because **this repo is public**:

| Var | Effect when set |
| --- | --- |
| `PRM_TEST_VAULT` | additionally exercises the heuristics against a real vault (§7) |
| `PRM_TEST_PRIVATE_TERMS` | comma-separated strings `test-defaults` asserts never appear in shipped defaults |

Leave both unset — as CI does — and those assertions skip. **Never hardcode a vault path,
a home-relative repo path, a real person's name, a real email, or a real phone number into
a fixture.** Use `harness.repoRoot` and `process.execPath`; a suite that passes locally and
fails in CI has almost always assumed a path. Fixture people
are fictional (`Dana Ochoa`, `Initech`, `@example.com`, `555-555-xxxx`); a contacts-import
fixture in particular is tempting to paste straight out of a real Google Contacts export,
and that would publish a third party's PII.

CI (`.github/workflows/ci.yml`) runs `npm test` on every push to `main` and every PR.
`release.yml` only typechecks and lints, and only on a tag, so CI is the only thing that
runs behaviour.

### Verifying UI changes

```bash
npm run ui                        # build the harness bundles + copy styles.css
python3 -m http.server 8731       # from tests/ui/ — file:// blocks the module loads
```

Browser harnesses under `tests/ui/` render the **real** components against the **real**
`styles.css` in Chrome: `dashboard.html` (`?n=3000` for scale), `calendar.html`,
`modals.html`, `create.html`, `import.html`. Each loads a `*-entry.ts` that imports
straight from `../../src/`, so they cannot drift from the source; `obsidian-shim.js` and
`obsidian-shim-modals.js` stand in for the host API. Bundles and the stylesheet copy are
gitignored — **run `npm run ui` again after any change to `src/` or `styles.css`**, or you
are looking at the previous build.

`?device=phone` and `?device=tablet` put the same body classes on that Obsidian does and
make the shim's `Platform` agree with them (see §4.9). Omit it for desktop. Compare the
two: a mobile change that alters the desktop layout is a bug.

**Treat harness output with suspicion.** It has flattered reality five separate times,
each hiding a real bug:

| The stub did this | What it hid |
| --- | --- |
| `button { … }` instead of `button:not(.clickable-icon)` | the entire specificity bug above |
| `querySelectorAll()` returning `[]` | every structural assertion passed vacuously |
| `Setting` components returning the Setting, not the component | no modal could be render-tested at all |
| `setIcon()` building a 2-element SVG | icon cost looked free; it is ~14% of a large render |
| `applyOpts` ignoring `value` | `<option>`s were valueless, so the sort dropdown was never exercised |
| `debounce` as a passthrough | made the search path look dearer than it is |
| no `<meta name="viewport">` in the browser harnesses | mobile emulation used the legacy 980px layout viewport, so a "390px phone" laid out at 940px and no narrow rule fired |
| `__matches` treating a space as part of a class name | `querySelectorAll(".prm-header-buttons button")` returned `[]`, and three assertions over the result passed against nothing |
| `setIcon` as a no-op in the Node stub | "does this button have an icon?" was unanswerable, which matters once a phone hides the label |
| a leaf with no padding, clipping on the wrapper instead of on `.view-content` | Obsidian's own 12px side padding and `overflow: auto` on `.view-content` — 24px of missing width, and the horizontal scrollbar it caused, invisible |

The lesson: **when a stub reimplements host behaviour, copy the host's real shape** —
including selector specificity. A harness that cannot fail is not evidence. If a user
reports a UI bug the harness says is fixed, suspect the harness.

---

## 6. Performance budgets

Measured, and worth re-measuring rather than assuming. Vault: 2,372 files, 239 people,
1,898 journals, ~2,883 interactions.

| Path | Budget | Notes |
| --- | --- | --- |
| Index rebuild | **~3 ms** | Whole vault. Runs on every metadata change. |
| Dashboard first paint | **~3 ms** | Windowed; 3,000 people is also ~3 ms |
| Search keystroke | **~3 ms** | Debounced 70 ms, keys cached |
| Selection change | **~0.2 ms** | Must not rebuild the list |
| Calendar bucketing | **0.2–1 ms** | 3.9–11.8 ms at 200,000 interactions |
| Person panel open | **~2 ms** | Includes reading follow-up text |

Rules of thumb learned the hard way:

- **Measure before optimising.** `normalizeName` over every row *looked* like the
  obvious hotspot; it is 2% of a render. Two earlier "optimisations" were reverted for
  being guesses.
- **Never rebuild the list for state that isn't the list.** Selection, filtering, and
  outline changes each got their own in-place path after each was found rebuilding
  everything.
- **Watch for accidental quadratics.** `selected()` used `Array.includes` inside a loop
  over the selection; at 3,000 selected that was 4.2 ms on a path that runs on every
  click.

---

## 7. Verify heuristics against the real vault

Any new heuristic must be run over real data and *read* before shipping. Every time this
was done it changed the design; unit tests with hand-made fixtures never did.

- A follow-up feature keyed on `- [ ]` tasks linking to a person: the vault had 2,445
  unchecked tasks and **zero** linked to anyone. It would have shipped as an empty tab.
- A drift signal flagged 59 people; the worst offenders had "1-day rhythms" from bursts
  (someone mentioned daily during a trip, then never). A burst is not a cadence.
- The same signal permanently flagged relationships whose *context* had ended — an
  internship six months over reads as "usually every day, 180 days late".

Write a throwaway script that runs the real index over the real vault and prints the
distribution: how many flagged, the extremes, the tails. Then ask whether the output
would be *useful*, not merely correct.

---

## 8. Conventions

- **Conventional Commits**, always: `type(scope): summary`. Bodies are expected to be
  substantial — explain *why*, and record what was tried and rejected.
- **Never tag or publish a release** unless explicitly asked. Committing and pushing to
  `main` is fine. Releases run through `.github/workflows/release.yml`, which builds,
  attaches artifacts, attests provenance, and takes its notes from the matching
  `CHANGELOG.md` section via `scripts/changelog-section.mjs`.
- Author attribution is **`xuvi`** (`xuvi7@users.noreply.github.com`). The repo lives on
  a *personal* GitHub account, not the work one — pushing needs
  `gh auth switch -u xuvi7` and the `gh` credential helper.
- Keep `CHANGELOG.md` current under `## Unreleased` as you go.
- Comments should explain **why**, especially where the code looks odd. Most of the
  strange-looking code here is strange for a reason that took a while to find; say what
  it was.

---

## 9. Known gaps and deliberate omissions

Don't "fix" these without discussion — each was a decision.

- **Only `manifest.json`'s version matters.** The release workflow checks the git tag
  against it and cross-checks `versions.json`; nothing reads `package.json`'s version.
  Keep them aligned anyway — they had drifted (1.1.0 vs 1.5.0) and it reads as a bug.
- **Reciprocity** ("who always texts first") is not built: it needs a direction bit per
  interaction, and journal mentions carry none, so the signal would be sparse and
  misleading.
- **heatmap-tracker is not a dependency.** Its only integration surface is a markdown
  code block (no JS API), it renders day-cell year heatmaps only (so the weekly/monthly/
  yearly scales would be lost), click-to-see-who needs our own handlers, and Obsidian
  cannot express a plugin dependency. Its *palette* idea was worth borrowing.
- **Known, deliberately not fixed** (from the five-agent review; each has a reason):
  - Derived status is a snapshot of `today`; nothing re-runs at midnight, so a vault
    left open overnight shows yesterday's queue until the next note edit.
  - An ambiguous person name where Obsidian resolves to a *non-person* note discards
    the link rather than falling back to the map hit, so both people lose it.
  - The calendar grid is one tab stop per cell (368 of them) with no arrow-key
    navigation, and dashboard rows aren't focusable, so opening a person panel is
    mouse-only.
  - `skipped` in the import result mixes notes and fields, so one contact with four
    stale fields reports "4 skipped".

- **A follow-up write requires the task's text, not just its position.** `locateTask`
  takes an optional `expect`; every caller that writes must pass what the UI displayed.
  Positions alone cannot tell two tasks apart, and in a list of tasks a shifted offset
  lands on another one. Fixed in 1.6.0 without the `LoopRef` schema change that a stored
  fingerprint would have needed — the text comes from the in-memory `Loop` instead.
- **Link resolution is a map lookup first, Obsidian second.** `resolvePersonLink` is the
  single seam; `buildPersonLinkMap` registers names, aliases, and paths both with and
  without `.md`. Real resolution is reserved for names two people share and for the
  relative or extension-bearing targets the map cannot express (`needsRealResolution`),
  because a miss is usually a link to a non-person and resolving every one would add a
  call per link per dated note. Anything real resolution returns is vetted against
  `byPath` before it counts.
- **`MOC` is in the default person-name exclusions**, which also excludes a person
  legitimately named e.g. "Moc". Matching is whole-word to limit the damage.
- **The `history/pre-conventional` branch** preserves pre-rewrite commit history.
