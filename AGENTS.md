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

### 4.4 The metadata cache updates asynchronously after a write

A rebuild triggered immediately after a write can see a note **without its
frontmatter**, which rendered as "unclassified" in a panel that only drew once. Any
long-lived UI showing record data should subscribe to `engine.onChange` and redraw.

---

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

⚠️ **The test suites currently live outside the repo**, in the session scratchpad:

```
/private/tmp/claude-502/-Users-vincent-xu-Repos/<session>/scratchpad/test-*.cjs
```

Each is a standalone Node script — no runner, its own tiny `check()` helper — run with
`node <file>`. They bundle the **real** source with esbuild and drive it against a fake
vault (`stub-obsidian.cjs`) that stores real text and computes a realistic metadata
cache. ~650 assertions across ~24 files. **If you are starting fresh work here, moving
these into the repo is the highest-value housekeeping available.**

### Verifying UI changes

Browser harnesses under `scratchpad/ui/` render the **real** components against the
**real** `styles.css` in Chrome: `dashboard.html` (`?n=3000` for scale), `calendar.html`,
`modals.html`.

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
- **`MOC` is in the default person-name exclusions**, which also excludes a person
  legitimately named e.g. "Moc". Matching is whole-word to limit the damage.
- **The `history/pre-conventional` branch** preserves pre-rewrite commit history.
