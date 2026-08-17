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

**Create a person note…** makes a note in the folder you nominate, optionally from
a template, and can assign a tier so the person is tracked straight away. Three
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

The **status bar** shows a live count of who's waiting.

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

- `prm-*` values are read from **frontmatter only**. Dataview inline fields
  (`prm-tier:: close`) are not read, because that would require reading files
  from disk on every index.
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
