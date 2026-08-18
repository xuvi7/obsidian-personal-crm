# Changelog

All notable changes to Personal CRM. Versions follow
[semantic versioning](https://semver.org/).

## Unreleased

### Added

- **Dated links in a person's own note count as interactions.** Both the log lines
  this plugin writes and a sentence like "a deep conversation on `[[2026-01-24]]`"
  record that something happened that day. This is what gives a manually logged
  history: `prm-last-contacted` holds only the latest date, while the links keep all
  of them, so a rhythm can now be measured from manual logs alone. Read from the
  metadata cache, so it costs no file reads. The journal's positional rules apply —
  open tasks, quotations, code and embeds don't count — `prm-ignore-journal` opts a
  person out, and there's a setting to turn it off entirely.
- **Link the date even with no note** (off by default): a log made on a day you
  didn't journal writes a bare date that nothing can read back later. Linking it
  keeps the date in the metadata cache, at the cost of an unresolved link.
- A date shared between a journal entry and a person's own log line still counts
  once, and clicking it opens the journal rather than the log line.
- **Drifting.** The plugin now measures how often you actually talk — the median
  gap between recent interactions — and flags someone when the current silence is
  long against *their own* rhythm rather than the cadence you assigned. Catches a
  friendship cooling off while its tier still says everything is fine: on a
  239-person vault, 21 of the 33 flagged aren't overdue by their tier.
- Drift is a band rather than a threshold. Quiet for more than twice the usual gap
  (never sooner than a fortnight, so a daily correspondent isn't flagged after three
  quiet days), but not more than twelve times it (never sooner than three months).
  The ceiling is there because intensity is often situational — an internship, a
  course — and when that context ends contact stops rather than thins; without it,
  three months of daily contact followed by six months of silence reads as "usually
  every day, 180 days late", forever. 16 people on the author's vault sit past the
  ceiling as ended situations rather than drifting relationships.
- The rhythm window grows until it holds enough gaps *and* spans three weeks, so a
  burst of daily mentions isn't mistaken for a daily rhythm and produces no verdict.
- A **Drifting** tab, a chip on the row, and the measured rhythm shown in the
  person panel next to the cadence you set.
- **A Contact calendar view**, with **daily, weekly, monthly and yearly** scales:
  weekdays by weeks over a year, years by weeks or months over six years, or one row
  of years covering everything on record. Cells are shaded by how many interactions
  fall in the period, with a key; clicking one lists who, and clicking a name opens
  their note. **One person…** narrows the view to a single history. Reachable from
  the dashboard header or the `Open contact calendar` command.
- The person panel carries a **thumbnail** — twelve monthly bars in the top corner,
  clickable to open the full calendar for that person. No single number carries the
  shape of a relationship — "daily for three months then nothing" and "every
  fortnight for years, quiet lately" have the same rhythm figure and mean different
  things — and a thumbnail is enough to tell them apart.

### Fixed

- The person panel's calendar was a full 53-column grid, which overflowed the modal,
  didn't line up with its edges, and pushed the note preview and notes box out of
  reach. Replaced with the thumbnail above; the panel is ~150px shorter.
- Calendar cells declare a solid colour before the `color-mix()` blend, so a
  renderer without `color-mix()` support shows a visible grid rather than an
  invisible one.
- Year rows in the calendar are contiguous even where a year is empty, rather than
  listing only years with data; interactions older than the range are reported as a
  count instead of being dropped.
- **Reach-outs written into your daily note**, off by default. When a dated note
  for today is created, who's overdue goes in as unchecked tasks under a heading
  you choose. A link in an open task already doesn't count as contact, so the nudge
  can't silence the reminder that produced it — and ticking the box makes it a
  completed task, which does count, so the gesture that means "done" is the one
  that logs it.
- Tasks under that heading are excluded from the Follow-ups tab, since they restate
  the Due tab and would accumulate daily. Turning the nudge off makes existing
  blocks ordinary follow-ups again.
- `Add today's reach-outs to this note` command, for notes that already exist.
  Running it twice won't stack a second block.
- **Places.** Where someone is, read from `prm-location` or whichever key the
  vault already uses (`location`, `city`, `based-in`, configurable). Shown on the
  row as `@Lisbon` and clickable to filter; an `@`-prefixed search matches places
  only, by substring, so `@NY` finds "Brooklyn, NY".
- **Who's in…** command: pick a place from the ones your vault records, with a
  count for each, and see everyone there sorted by who's most overdue.
- **Set place** on one person from their panel, or on a whole selection from the
  bulk bar. It writes `prm-location` even when a plain `location` exists, so the
  contact importer's own field is left to the importer.
- **Follow-ups.** An unchecked task counts as an open follow-up for a person when
  it lives in their own note or links to them from anywhere in the vault. They show
  as a chip on the row, get a **Follow-ups** tab, and are listed in the person
  panel where ticking one writes `- [x]` back to whichever note holds it. Due dates
  are read from `📅 2026-08-20`, `due:: 2026-08-20` or `(2026-08-20)`.
- **Add follow-up** in the person panel, writing `- [ ] …` under a configurable
  heading in the person's note — so the feature works without having to adopt a
  task syntax first.
- Completing a follow-up whose task has since moved or changed is declined and
  triggers a reindex, rather than ticking off whatever took its place.

- **Multi-select.** Cmd/Ctrl-click a row or tick its checkbox to select it;
  shift-click extends a range through the rows currently on screen. **Select all**
  takes whatever the filter is showing, so you can narrow first and select second.
- **Bulk actions** on a selection: log contact, set cadence, add tag, remove tag
  and snooze. Each lands as a **single undo step** rather than one per person, and
  bulk logging asks for a date and note once and applies both to everyone.
  A person whose note has gone missing is reported without sinking the rest.
- **Tags**, as ordinary Obsidian tags — read and written in the note's own `tags:`
  frontmatter, so they're the same tags the tag pane, `tag:` search, graph filters
  and Dataview already see. Shown as chips on each row; click to filter, click
  again to clear. The marker tags that identify person notes are left out of the
  chips so they don't appear on everyone.
- **Sort by tag**, grouping people by their first tag with untagged people last.
- A **person panel** on clicking a row: the note's own content, a date and notes
  box for logging, and one click each to cadence, snooze, tags and the note. The
  row's icon buttons stay for the fast path.
- Searching with a leading `#` matches **tags only**, so `#gym` doesn't also match
  someone whose relationship reads "climbing gym".

### Changed

- The row checkbox sits inside the name row rather than being a column of the row
  itself. Below ~700px the row stacks into a column, where a direct child stretched
  to full width — and sidebar leaves are routinely that narrow.
- **Select all** is purely additive instead of toggling. A button labelled "Select
  all" can't announce which way a toggle will go, and the selection bar's *Clear*
  already undoes it.
- The bulk write helpers return what they changed and what failed, so callers no
  longer have to read a toast to find out.

### Performance

- Selecting a period in the calendar updates an outline and the detail panel rather
  than rebuilding the grid: 0.1 ms against a 1.7 ms full render, and the gap widens
  with vault size since a rebuild re-buckets every interaction. The interaction map
  is cached until the index changes.
- Bucketing is 0.2-1.0 ms per scale on a 2,868-interaction vault, and 3.9-11.8 ms at
  200,000 interactions — paid only while the view is open.
- `toUTC` gained a fast path for canonical `YYYY-MM-DD` dates, skipping a regex on
  every date comparison in the plugin — and the rhythm calculation alone makes tens
  per person. Combined with converting each date once instead of twice, measuring a
  rhythm went from 3.5 µs to ~2 µs per person, flat from 10 interactions to 5,000
  because the walk is capped.
- Nothing is written, and no dated-note check runs, until the workspace is ready.
  Obsidian replays `create` for every file in the vault while it loads.
- With all three features on, a rebuild is ~3.1 ms on a 2,372-file vault against a
  2.66 ms baseline, inside a ±0.3 ms run-to-run band. Heading matching rules
  candidates out on length before allocating a lowercased copy.
- Reading locations costs less than the measurement noise on a 2,372-file vault
  (~3.0 ms per rebuild, within a ±0.2 ms band). The key list is built once per
  rebuild rather than once per person.
- Follow-up tracking reads only the metadata cache, so a rebuild costs 0.2 ms more
  on a 2,372-file vault (2.66 ms → 2.86 ms) and nothing measurable on notes that
  have bullets but no tasks. Links are matched to tasks by walking both in document
  order instead of searching the task list per link, and the person link map is now
  built once for both the contact and follow-up passes instead of twice.
- Selecting, deselecting and clearing no longer rebuild the list. Only selection
  state changes, so rows are synced in place — a select-all over 3,000 people went
  from a full render of every row to 2.3 ms of work.
- `selected()` checked membership with `Array.includes` inside a loop over the
  selection, which is quadratic in it. Measured at 3,000 selected: 4.2 ms → 0.2 ms,
  and it runs on every selection change.

## 1.5.0 — 2026-08-17

### Added

- **An "Add person" button in the dashboard header**, and the same dialog offered
  from the empty states — previously creating a person was only reachable through
  the command palette, which is easy to miss.
- The dialog asks for the tier alongside the name. A person with no tier isn't
  tracked at all, so creating one without asking would quietly produce someone the
  plugin ignores.

### Performance

- Exclusion fragments are tokenized once per index build instead of once per
  candidate file, so the cost no longer scales with files × fragments. Measured on
  5,000 people: 20 fragments went from 20.8ms to 13.7ms, and the cost is now flat in
  fragment count rather than linear.
- A file already inside a people folder no longer has its tags and type marker
  evaluated, since neither can change the outcome. Tag-based identification across
  13,000 files: 5.2ms to 4.4ms.
- The unrendered-placeholder check does a cheap substring test before its regex,
  which almost never matches.

## 1.4.0 — 2026-08-17

### Changed

- **No default now assumes a particular vault's layout.** The people folder and the
  dated-note folders ship empty rather than guessing at names, so an unconfigured
  install says "Nothing is set up yet" instead of reporting a folder the user never
  chose as missing. First-run detection, and a *Detect folders from your vault*
  action, fill them in from Daily Notes or Periodic Notes plus a likely people
  folder — and only ever fill what has been left empty.
- The creation-date fields no longer include `creation date`, which came from one
  vault's template rather than any general convention. Existing settings are
  untouched: a persisted value always wins over a default.

### Added

- **Create a person note** from the command palette, with three new settings —
  the folder to create in, a template to copy, and a tier to assign — so a new
  person is tracked from the moment they exist. An existing note is never
  overwritten; creating someone who already exists opens them instead.
- Templates support `{{title}}`, `{{date}}`, `{{time}}` and any imported field as
  `{{email}}`, `{{phone}}` and so on. Templater's `tp.date.now`, `tp.file.title`
  and `tp.file.cursor` are translated to their result; other Templater expressions
  are removed rather than left sitting in the note unevaluated.
- **Contacts with no matching note are now actionable in the import.** Each one
  offers *Create note* — using the same folder, template and tier — or *Link to…*,
  which attaches the details to an existing person filed under a different name.
  Both feed the same review list, and creations are covered by the same single undo.
- Undo now covers created notes. Undoing a creation trashes the note, unless it has
  been edited since, in which case it's left alone as the user's work.

### Fixed

- **A real name containing an exclusion word was silently dropped.** Exclusions were
  matched as substrings, so "MOC" hid anyone called Mochizuki and "index" hid
  Indexa. They are now matched as whole words, which also makes a broader default
  list safe.
- **Rebuild index now reports what it found** — "239 people · 1897/1897 dated
  notes · 2877 interactions · 50ms" — instead of appearing to do nothing. It was
  re-deriving the index correctly, but since the index already updates itself as
  notes change, the counts rarely moved and there was no other feedback.

- Release notes contained the entire changelog rather than the section for the
  version being released. The workflow now extracts just that version's section,
  and fails before building if the version has no changelog entry at all.

## 1.3.0 — 2026-08-17

### Changed
- **The note preview is a bounded, scrollable box again.** It was growing to the
  full height of the note, which pushed the action buttons out of reach and left
  only the top of the file visible with no way to scroll to the rest. The height
  cap now lives on a dedicated scroll container rather than on the element that
  carries Obsidian's `markdown-rendered` class, which was overriding it.
- **The preview skips what isn't worth reading.** Unfilled template syntax
  (`<% … %>`, `{{ … }}`), bullets that are only a label with no value
  (`- First met:`), and headings left empty once those are gone are all omitted.
  A note straight from a template now says "Nothing written about them yet."
  instead of showing a screenful of placeholder.

- **The note field when logging contact is now a full-width, resizable text box**
  rather than a single-line input, so there's room to write something worth
  reading back. Line breaks are preserved: a multi-line note is indented to the
  bullet's text column so every line stays inside the same log entry instead of
  the second line breaking out of the list.
- **The reach-out flow has a note box too.** Whatever you write is saved with the
  contact when you press *Logged it*, and drafts are kept per person while you
  move back and forth through the queue, so navigating away doesn't lose typing.
  ⌘/Ctrl+Enter logs without reaching for the mouse.

### Fixed

- **An appended contact log no longer revives the empty heading above it.** A
  section was judged on everything up to the next heading of the *same or higher*
  level, so a `## Contact log` nested under an empty `# Thoughts` counted as that
  heading's content. Sections are now judged on their own direct content.
- **The contact log heading matches the note's own section level** instead of
  always being `##`. In a note whose sections are `#`, a `##` heading nested the
  log under whichever section happened to come last — wrong in the outline, and
  the cause of the bug above.
- When a note has only template headings, the preview now says which sections are
  empty ("Nothing written down yet — Facts and Thoughts are empty.") rather than a
  bare "nothing written", which read as though the preview had failed on a file
  that visibly has headings in it.
- Arrow keys no longer jump between people while the caret is in a text field —
  the reach-out shortcuts now stand aside when you're typing.

## 1.2.1 — 2026-08-17

### Fixed

- **The dashboard header and filter tabs are now locked in place.** They were
  positioned with `position: sticky`, which only covered the header — the filter
  tabs, search box and sort control scrolled away with the list — and let rows
  show through above the header as they scrolled. The view is now two panes: the
  header and toolbar are fixed, and the list is its own scroll container, so rows
  are clipped by the list's box and cannot appear above the chrome.
- On narrow screens the cadence hairline sat at each row's absolute bottom.
  Because stacked rows put the action buttons on their own line, the line read as
  belonging to the next person's name. It's decorative, so it's hidden at that
  width.

## 1.2.0 — 2026-08-17

Adopts Obsidian's declarative settings API, which raises the minimum Obsidian
version, and clears the plugin review findings.

### Upgrade notes

**`minAppVersion` is now 1.13.0** (was 1.7.2). This is the version that
introduced the declarative settings API, and it is not optional: the deprecated
`display()` path and `getSettingDefinitions()` are mutually exclusive, and
several other calls (`setDestructive`) are 1.13-only too. Users on Obsidian 1.7
through 1.12 stay on 1.1.0, which `versions.json` handles automatically.

Your settings carry over untouched.

### Changed

- **Settings are now declarative**, so every setting appears in Obsidian's
  settings search — including by alias, so searching "periodic notes",
  "troubleshoot" or "vcard" finds the relevant row.
- Journal sources and tiers are now proper lists: each entry is its own page
  showing its current value inline, tiers can be reordered by dragging, and a
  dated folder that doesn't exist — or whose format matches nothing — is flagged
  with a warning on the entry itself.
- Folder fields use Obsidian's built-in folder picker rather than a hand-rolled
  suggester.
- The tier-deletion confirmation is an in-app dialog instead of a native
  `confirm()`, which blocked the whole window.

### Fixed

- A frontmatter value that isn't a scalar — `prm-birthday: {a: b}` — was
  stringified to the literal `"[object Object]"` and written back into the note.
  Non-scalar values are now refused.
- Replaced `builtin-modules` with `node:module`'s `builtinModules`.
- Frontmatter is read through one helper that types it as `unknown` rather than
  `any`, so every read site is checked.
- Obsidian's re-exported `moment` resolves to `any`; date parsing now narrows it
  to the two methods it uses.
- Async work no longer returns promises from positions typed as void
  (`SuggestModal` overrides, button handlers).

### Development

- Added an ESLint setup using `eslint-plugin-obsidianmd` plus
  typescript-eslint's type-checked rules; `npm run lint` is clean.
- Added a release workflow that builds from source on a version tag, verifies the
  tag matches `manifest.json`, and records build provenance attestations so
  published assets can be traced to a commit.

## 1.1.0 — 2026-08-17

A correctness, portability and performance pass. The headline change is that the
plugin no longer mistakes writing *about* someone for having contacted them.

### Upgrade notes

Read these four before upgrading — each changes behaviour you may already rely
on.

1. **Mentions that record an intention no longer count as contact.** A link
   inside an unchecked to-do, a blockquote, a code fence, or an embed is now
   ignored. Previously, writing `- [ ] reach out to [[Sam]]` marked Sam as
   contacted and cleared their overdue status — the reminder deleted itself the
   moment you acted on it. A *completed* task (`- [x] called Sam`) still counts.

   **Effect on existing vaults:** some people will now show as less recently
   contacted, and more will appear overdue. That is the correction, not a
   regression. Turn it off with *Ignore mentions that aren't contact* if you
   prefer the old behaviour.

2. **Settings migrate automatically.** `peopleFolder` becomes `personFolders` (a
   list) and `journalFolders` becomes `journalSources` (a folder plus a moment
   format). Your existing values are carried over and first-run detection is
   suppressed, so nothing is overwritten. No action needed.

3. **Log lines are written differently.** The heading is now a level-2 `##`, and
   the date links the day's note by its real title —
   `- [[Aug 14, 2026|2026-08-14]]` — or is written as a plain date when no note
   exists for that day. Previously it always emitted `[[YYYY-MM-DD]]`, which
   created an unresolvable link in every person note when your daily notes are
   named anything else. Existing log entries are left alone.

4. **`minAppVersion` is now 1.7.2** (was 1.5.0), because `revealLeaf` is awaited.

### Added

- **Configurable date formats.** Dates come from a moment.js pattern per folder,
  the same format Daily Notes and Periodic Notes use, so you can paste yours in
  — including folder-nesting patterns like `YYYY/MM/YYYY-MM-DD`. Previously four
  hardcoded patterns were tried, which silently ignored most real-world naming
  schemes, including three of Periodic Notes' five defaults. Day-first formats
  (`DD-MM-YYYY`) now parse correctly instead of being read a month off.
- **First-run detection.** On a fresh install the plugin reads your Periodic
  Notes or core Daily Notes configuration for the journal folder and format, and
  looks for a folder named People, Contacts, Friends or similar.
- **People can be identified three ways**, in any combination: a list of
  folders, tags matched as a prefix (`person` also claims `#person/work`), or a
  frontmatter marker such as `type: person`. Tags and markers find people
  anywhere in the vault, so a vault organised by area rather than by type works.
- **Date-field fallback.** A note whose filename has no date can be dated by a
  frontmatter field (`date:` by default), which makes note-per-meeting
  workflows work.
- **Diagnostics.** Settings shows real counts — people found, notes scanned,
  notes successfully dated, interactions derived — and every empty state names
  the actual cause rather than implying you have nobody to contact.
- **Unknown-tier warning.** Deleting a tier used to silently stop tracking
  everyone assigned to it. Deletion now warns with the count, and affected
  people are flagged in the dashboard instead of appearing unclassified.
- A clickable last-contact date that opens the note the interaction came from.
- Configurable creation-date fields, with a broader default set (`created`,
  `Created`, `date created`, `ctime`, …) and support for `[[wikilink]]`-wrapped
  dates. People whose baseline came from the file's timestamp rather than real
  data are labelled *estimated*, since sync and `git clone` both reset it.
- An exclusion list for templates, MOCs and index notes, plus automatic skipping
  of notes containing unrendered `{{placeholders}}`.
- Mobile layout: rows stack, and row actions are always visible rather than
  revealed on hover.

### Fixed

**Data integrity**

- The body log write is now atomic. Logging contact and then immediately
  changing that row's tier could silently discard the log entry entirely — both
  actions reported success.
- Writes are serialized per note, and undo snapshots are taken inside that
  sequence. Two overlapping actions previously merged into one snapshot, so a
  single undo reversed a change you never asked to reverse, and the undo/redo
  stacks could desynchronize.
- The **Undo** link in a confirmation toast now reverses *that* action. Because
  toasts last seven seconds, two could be on screen at once and clicking either
  undid whichever action was newest.
- Empty and impossible dates are rejected. Clearing the date field in the log
  dialog wrote an empty value, destroying any existing `prm-last-contacted` and
  writing a `- [[]]` link. A stored date like `2026-13-45` passed validation and
  gave someone a *future* last-contact, so they never became overdue again.
- `processFrontMatter` failures are caught and reported. One note with malformed
  YAML previously produced a written body bullet, no frontmatter update, no undo
  entry, and no message of any kind.
- The contact importer re-checks each field against the note's current value at
  the moment of writing, so *only fill empty fields* still means that if you
  edited the note after generating the preview.
- The log heading is located through the metadata cache, which is fence-aware. A
  `## Contact log` shown as an example inside a code block could capture entries.

**Undo**

- A multi-file undo that fails partway rolls back what it already wrote, rather
  than leaving half a bulk import reverted.
- Snapshot paths follow a note when it is renamed. Previously a rename made undo
  permanently impossible.
- An undo blocked by an external edit is kept rather than silently discarded, so
  it can be retried once the conflict clears.
- History is capped by size (32 MB) as well as count. Repeated bulk imports
  could retain hundreds of megabytes.

**Interaction handling**

- Two notes dated the same day count as one interaction, not two.

**Contact import**

- Names in non-Latin scripts are matched. `李伟`, `Иван Петров` and `محمد علي`
  previously normalized to an empty string, making the importer inert for entire
  scripts.
- Word order and honorifics are handled, so `Rivera, Sam` and `Dr. Sam Rivera`
  both find `Sam Rivera`. vCard's own `N:` field is family-name-first, so this
  was the common case.
- Non-US birthdays are no longer corrupted. `17/04/1999` became month 17, which
  was written to the note and then silently never displayed. Genuinely ambiguous
  dates are dropped rather than guessed.
- Nicknames are merged into whichever alias key the note already uses, instead of
  creating a second `aliases:` alongside an existing `alias:`.
- Google's `myContacts` system label is filtered out of imported labels.

**Interface**

- Folder settings are normalized, so `People\Friends`, a leading `/`, and
  accented folder names typed on macOS all resolve. Folders are validated and
  offer autocomplete.
- Snoozing from the reach-out flow no longer marks someone handled and skips
  them when you press Escape without choosing.
- Note previews release their rendered content as you advance, instead of
  accumulating live render subtrees for every person in a session.
- The status bar element is created once, rather than re-registering its click
  handler each time the setting is toggled.

### Performance

- The dashboard renders once per change on the next animation frame, instead of
  up to three times per click, and skips rendering entirely while its pane is
  hidden — a background tab was previously paying full DOM construction cost on
  every metadata change anywhere in the vault.
- The search box filters rows that are already built. Typing previously rebuilt
  every row per keystroke.
- Each row's tier control is a button that opens the existing picker rather than
  a `<select>` carrying an option per tier, which accounted for roughly 45% of
  render cost.
- `metadataCache` change events are filtered to files that can actually affect
  the index, so editing an unrelated note costs nothing.
- Filename-to-date parsing is memoized, with a fast path that skips moment
  entirely for ISO dates and an early exit for filenames containing no digits.
- Settings writes are debounced. Typing a folder name previously triggered a
  reindex, a render and a disk write per character.
- Bulk imports yield to the event loop in chunks and report progress, instead of
  freezing the window.

Measured on a 2,600-file vault: a dashboard action goes from roughly 124 ms to
under 10 ms, typing a search query from about 405 ms to 25 ms, and a full reindex
sits at 2.6 ms. Figures come from the real bundled code driven in a Node harness
and in Chromium, not from Electron, so treat them as indicative of the direction
and rough magnitude rather than exact.

## 1.0.0

Initial version, developed and used locally rather than released.

- Contact history derived from `[[wikilinks]]` in dated notes, read from
  Obsidian's metadata cache with no filesystem access during indexing.
- Per-person contact cadence via tiers, with a dashboard sorted by urgency.
- Reach-out flow that steps through overdue people and shows each person's own
  notes for context.
- Keyboard-driven triage for classifying people quickly.
- Contact logging to frontmatter and to a log section in the note body.
- Snapshot undo and redo with conflict detection.
- Contact detail import from Google Contacts CSV and vCard exports, with a
  reviewable plan.
- Birthday tracking and a status-bar count.
