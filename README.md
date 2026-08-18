# Personal CRM for Obsidian

A personal relationship manager that answers one question: **who should I reach
out to?**

It works from a premise about how people already use Obsidian. If you keep dated
notes — daily notes, a journal, one note per meeting — and you mention people in
them with `[[wikilinks]]`, you already have a complete interaction log. It just
isn't being read as one. This plugin reads it.

So contact history needs no data entry. Write your notes as usual and the plugin
knows when you last saw someone. The only thing you tell it is **how often you
want to be in touch** with each person.

## Installing

Not in the community plugin directory yet, so either:

**With [BRAT](https://github.com/TfTHacker/obsidian42-brat)** — add the beta plugin
`xuvi7/obsidian-personal-crm`. BRAT keeps it updated.

**By hand** — download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/xuvi7/obsidian-personal-crm/releases/latest)
into `<your vault>/.obsidian/plugins/personal-crm/`, then enable it under Community
plugins.

Requires Obsidian 1.13.0 or newer. Older versions are served the newest release they
can run, so 1.7–1.12 will get 1.1.0.

Release assets are built in CI and carry [build provenance](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations),
so you can check they came from this source:

```bash
gh attestation verify main.js --repo xuvi7/obsidian-personal-crm
```

## How it works

```
Daily/2026-08-14.md                     People/Sam Rivera.md
  …coffee with [[Sam Rivera]]…      →     prm-tier: close   (every 30 days)
            │                                      │
            └────── last contact: 2026-08-14 ──────┘
                              │
                    due 2026-09-13 → overdue after that
```

Dates come from each note's filename, using the same moment.js format that Daily
Notes and Periodic Notes use — including folder-nesting patterns like
`YYYY/MM/YYYY-MM-DD`. A note whose filename has no date can be dated by a
frontmatter field instead, which is what makes note-per-meeting workflows work.

Links resolve through Obsidian's own metadata cache, so aliases work
automatically. Indexing never reads a file from disk, which keeps a full rebuild
in the low milliseconds.

### What counts as contact

An ordinary `[[link]]` in a dated note. Deliberately **not** counted:

- links inside unchecked to-dos — writing “`- [ ] reach out to [[Sam]]`” must not
  mark Sam as contacted and silence the reminder that prompted it
- links inside quotes and code blocks
- embeds (`![[Sam Rivera]]`), so a template or a dashboard that transcludes a
  person doesn't register as contact

A *completed* task (`- [x] called Sam`) does count.

## Setup

Enable the plugin. Nothing is guessed: no folder names are assumed. On first run it
reads your Daily Notes or Periodic Notes configuration for the dated folder and its
format, and looks for a folder named People, Contacts, Friends or similar. If it
finds nothing, the Status block says so and *Detect folders from your vault* will
try again at any time.

Check what it found in settings — the Status box at the top shows real counts and
refreshes itself as the index changes:

> 43 people found · 1,204 notes in your dated folders, 1,204 with a readable date
> · 2,310 interactions derived · indexed in 3ms

If a number there is zero, that's the thing to fix. An empty dashboard always
explains itself rather than implying you have nobody to contact.

Then classify people. Only people with a tier get tracked, so nothing nags you
until you opt them in. Run **Triage unclassified people**: it walks through
people one at a time, most-mentioned first, showing each note for context. Press
`1`–`5` to assign a tier, `p` to never track them, space to skip.

### Where people come from

Any combination of:

| Source | Setting |
| --- | --- |
| Folders | `People folders` — comma-separated, subfolders included |
| Tags | `Person tags` — prefix-matched, so `person` also claims `#person/work` |
| Frontmatter | `Person frontmatter marker` — e.g. key `type`, value `person` |

Tags and frontmatter markers find people anywhere in the vault, so a vault
organised by area rather than by type works fine. Notes titled as templates, MOCs,
indexes or Untitled are excluded, matched **as whole words** so a real surname like
Mochizuki isn't mistaken for a MOC. Notes with unrendered `{{placeholders}}` are
skipped too.

## Adding people

**Add person** in the dashboard header — or **Add a person…** from the command
palette — makes a note in the folder you nominate, optionally from a template, and
asks for the tier in the same step so the person is tracked immediately rather than
sitting unclassified. Three
settings under *Creating new people* control it:

| Setting | Meaning |
| --- | --- |
| New person folder | Where new notes go. Defaults to your first people folder. |
| Template for new people | A note to copy. Leave empty for a plain note. |
| Tier for new people | Assign a cadence immediately, or leave unclassified. |

Templates support `{{title}}`, `{{date}}`, `{{time}}` (and `{{date:FORMAT}}`), plus
any imported field as `{{email}}`, `{{phone}}`, `{{company}}` and so on. Templater's
`tp.date.now`, `tp.file.title` and `tp.file.cursor` are translated to their result;
other Templater expressions are removed rather than left in the note, since the
plugin can't evaluate them.

An existing note is never overwritten — creating someone who already exists just
opens them.

## Tiers

A tier is just a cadence. Defaults, all editable:

| Tier | Cadence |
| --- | --- |
| Inner circle | 14 days |
| Close | 30 days |
| Casual | 90 days |
| Keep warm | 180 days |
| Dormant | 365 days |

## Daily use

**Reach out** (`Who should I reach out to?`) is the main ritual. It queues your
most-overdue people and shows each person's note — the things you already wrote
about them — so there's something concrete to say. From there: log the contact,
snooze, open the note, or skip.

The **dashboard** (ribbon icon, or `Open dashboard`) lists everyone by urgency,
with a hairline under each row showing how far through their cadence they are.
Tabs cover Due, Tracked, Unclassified, Birthdays and Paused. Clicking a “last
contact” date opens the note it came from.

**Click a row** to open that person's panel: their note's own content, a date and
notes box for logging, and one-click access to cadence, snooze, tags and the note
itself. The row's icon buttons stay for the fast path.

The **status bar** shows a live count of who's waiting.

### Selecting several people

**Cmd/Ctrl-click** a row (or tick its checkbox) to select it; **Shift-click**
extends a range through what's currently on screen. **Select all** takes
everyone the filter is showing, so you can filter first and select second.

With a selection, a bar appears above the list: **Log contact** (one date and
note applied to everyone), **Set cadence**, **Add tag**, **Remove tag** and
**Snooze**. Each is a single undo step, not one per person.

### Places

Distance is what breaks contact, so the plugin tracks where people are. Set it
with **Set place** — on one person from their panel, or on a selection from the
bulk bar — or write `prm-location: Lisbon` yourself. A plain `location` (which the
contact importer writes), `city`, or `based-in` are read too, and the keys are
configurable.

The place shows on the row as `@Lisbon`; click it to filter, click again to clear.
An `@`-prefixed search matches places only, and matching is a substring, so `@NY`
finds "Brooklyn, NY". Spellings aren't canonicalised — "NYC" and "New York" stay
different places, because guessing they're the same is how a location field starts
lying to you.

The **Who's in…** command lists the places in your vault with a count for each,
then shows everyone there sorted by who's most overdue: the "I'm in Lisbon next
week, who should I see?" question, answered from what you already wrote down.
Setting a place writes `prm-location` even when a plain `location` is present —
that field belongs to the importer and to whatever else reads it.

### Follow-ups

The other half of losing touch is forgetting what you said you'd do. An
**unchecked task** counts as an open follow-up when it either lives in a person's
own note or links to them from anywhere in the vault:

```markdown
- [ ] send the climbing gym list        ← in Sam's note
- [ ] introduce [[Ana]] to the setter   ← in a project note
```

They show as a chip on the row, get their own **Follow-ups** tab, and are listed
in the person panel where you can tick them off — which writes `- [x]` back to
whichever note holds the task. Due dates are read if the task carries one, in the
Tasks plugin's `📅 2026-08-20` form, as `due:: 2026-08-20`, or in parentheses.

If you don't already write tasks that way, the person panel's **Add follow-up**
box writes one for you, under a heading you can set.

Only the *location* of a task is indexed, never its text: the index reads nothing
but Obsidian's metadata cache, and pulling task text in would mean reading every
file in the vault on every rebuild. The words are read when they're shown, from
the few notes that actually hold follow-ups. On a 2,372-file vault the whole
feature costs 0.2 ms per rebuild, and it can be turned off.

Note that an unchecked `- [ ] reach out to [[Sam]]` is deliberately *not* contact —
it's an intention, so it becomes a follow-up instead of silencing the reminder
that prompted it.

### Tags

Tags are ordinary Obsidian tags — the plugin reads and writes the note's own
`tags:` frontmatter, so they're the same tags the tag pane, `tag:` search, graph
filters and Dataview already see. Nothing is stored in a plugin-only field.

Tags show as chips on each row; click one to filter to it, click again to clear.
A `#`-prefixed search matches tags only, so `#gym` won't also match someone whose
relationship reads “climbing gym”. Sorting by **Tag** groups people by their
first tag and puts untagged people last.

The marker tags that identify person notes (`#people`, `#person`, …) are left out
of the chips, since they'd otherwise appear on everyone.

## Undo

Every write the plugin makes is reversible. Confirmation toasts carry an inline
**Undo** link bound to *that* action, the dashboard header has undo/redo buttons
showing what they'd affect, and both are in the command palette.

Undo works on whole-file snapshots, which makes a bulk contact import a single
step. Before restoring, it checks the note still looks the way it did after the
change — if you edited it in between, the undo is declined rather than
overwriting your edit. A multi-file undo that fails partway rolls back what it
already wrote.

History is per session, capped at 50 actions and 32 MB.

## Google Contacts

**Import contact details from a Google Contacts export…** fills in `email`,
`phone`, `company`, `title`, `location`, `prm-birthday` and `prm-relationship`
(from Google labels) by matching names.

Export from [contacts.google.com](https://contacts.google.com) as **Google CSV**
or **vCard**; both current and older column layouts are handled. Then:

- Names are matched through aliases, ignoring accents, honorifics and word order,
  so `Rivera, Sam` and `Dr. Sam Rivera` both find `Sam Rivera`. Non-Latin scripts
  are matched too.
- A name matching two notes is reported as ambiguous and never applied.
- Existing values are kept unless you turn on overwriting — and that's re-checked
  at the moment of writing, so a value you edited after the preview is never
  clobbered.
- Notes titled with just a first name only match if you opt in.
- A contact with no matching note can be resolved in place: **Create note** makes
  one using the settings above, or **Link to…** attaches the details to an existing
  person whose note is named differently. Both join the same review list.
- Nothing is written until you've reviewed the full list of changes, and the whole
  import — creations included — is one undo away.

This is a file import, not a live connection — re-export to refresh. A live sync
would need a Google Cloud OAuth client of your own, which a distributed plugin
can't ship.

## Frontmatter

Everything the plugin writes lives in `prm-` keys, so it won't collide with your
existing fields.

| Key | Meaning |
| --- | --- |
| `prm-tier` | Tier id, e.g. `close`. Absent means untracked. |
| `prm-cadence` | Days. Overrides the tier for this person. |
| `prm-last-contacted` | `YYYY-MM-DD`. Set when you log contact. |
| `prm-snooze-until` | `YYYY-MM-DD`. Hidden from the queue until then. |
| `prm-paused` | `true` to exclude entirely. |
| `prm-ignore-journal` | `true` to ignore dated-note mentions for this person. |
| `prm-birthday` | `04-17` or `1999-04-17`. |
| `prm-relationship` | Free text, e.g. `climbing gym`. |

The contact importer also writes plain `email`, `phone`, `company`, `title` and
`location` keys — deliberately un-prefixed, since they're useful to Dataview and
to you independently of this plugin.

Effective last contact is the **most recent** of any dated-note mention and
`prm-last-contacted`, so logging a text message works alongside journaling.

### Known limits

- `prm-*` values and tags are read from **frontmatter only**. Dataview inline
  fields (`prm-tier:: close`) and inline `#tags` typed in the body are not read,
  because that would require reading files from disk on every index — and writing
  a body tag would mean editing your prose by position.
- For someone you've never contacted, the cadence counts from the note's creation
  date. If no creation field is found the file's timestamp is used, which sync and
  `git clone` both reset — those rows are labelled *estimated* so you can tell.

## Commands

- Open dashboard
- Who should I reach out to?
- Triage unclassified people
- Log contact with… / Log contact with this person (today)
- Set contact cadence for this person
- Snooze this person
- Jump to person
- Import contact details from a Google Contacts export…
- Undo last change / Redo last undone change
- Rebuild index

No hotkeys are bound by default — notably, undo is *not* mapped to Cmd+Z, so it
can't interfere with normal editor undo. Bind it yourself if you want one.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

- **1.2.0 requires Obsidian 1.13.0** for its declarative settings API, which puts
  every setting in Obsidian's settings search. Older Obsidian versions are served
  1.1.0 automatically.
- **1.1.0 changed how contact is detected** — links in unchecked to-dos, quotes,
  code blocks and embeds no longer count — so some people may appear less
  recently contacted after upgrading.

## Development

```bash
npm install
npm run build                          # typecheck + bundle
PRM_OUT_DIR="/path/to/vault/.obsidian/plugins/personal-crm" npm run build
npm run dev                            # rebuild on change
```

`PRM_OUT_DIR` sets the install target; without it the bundle lands in the repo
root. Reload the plugin in Obsidian to pick up a new build.

| File | Role |
| --- | --- |
| `src/engine.ts` | Indexing, link attribution, cadence and status math |
| `src/journal.ts` | Filename → date, via moment formats |
| `src/detect.ts` | First-run detection of Daily/Periodic Notes settings |
| `src/dates.ts` | UTC-anchored day arithmetic and date validation |
| `src/writes.ts` | Per-path write serialization |
| `src/undo.ts` | Snapshot undo/redo with conflict detection and rollback |
| `src/view.ts` | Dashboard |
| `src/modals.ts` | Reach-out, triage, pickers |
| `src/contacts.ts` | CSV/vCard parsing, name matching, change planning |
| `src/import-modal.ts` | Import review UI |
| `src/settings.ts` | Settings and frontmatter keys |
