import {
	App,
	Notice,
	debounce,
	PluginSettingTab,
	SettingDefinitionItem,
	SettingDefinitionPage,
	SettingGroupItem,
	TFolder,
	normalizePath,
} from "obsidian";
import type PrmPlugin from "./main";
import type { Tier } from "./types";
import type { JournalSource } from "./journal";
import { formatDuration } from "./dates";
import { ConfirmModal } from "./modals";

export interface PrmSettings {
	/** Folders whose notes are people. */
	personFolders: string[];
	/** Tags marking a person note. Matched as a prefix, so `person` hits `person/work`. */
	personTags: string[];
	/** Frontmatter key/value marking a person note, e.g. `type: person`. */
	personTypeKey: string;
	personTypeValue: string;
	/** Only treat notes in the person folders as people if they also carry a tag/type. */
	requireTagOrType: boolean;
	/** Basename fragments that are never people (templates, MOCs, indexes). */
	personExclusions: string[];

	/** Folder new person notes are created in. Empty = the first people folder. */
	newPersonFolder: string;
	/** Note used as the template for new people. Empty = a plain built-in note. */
	newPersonTemplate: string;
	/** Tier assigned to a newly created person. Empty = leave unclassified. */
	newPersonTier: string;

	/** Folders of dated notes, each with its own moment format. */
	journalSources: JournalSource[];
	/** Try a set of well-known date formats when a source's format doesn't match. */
	allowFallbackDateFormats: boolean;
	/** Frontmatter key to date a note by when its filename has no date. */
	journalDateKey: string;

	/** Frontmatter keys consulted for a person note's creation date, in order. */
	createdDateKeys: string[];

	tiers: Tier[];
	defaultTierId: string;

	/** A dated note linking to someone counts as contact. */
	journalMentionsCountAsContact: boolean;
	/** Ignore links in unchecked tasks, quotes, code and embeds. */
	ignoreIntentLinks: boolean;
	dueSoonWindowDays: number;

	showStatusBar: boolean;
	notifyOnStartup: boolean;
	nextUpCount: number;

	/** Also append a human-readable line under a heading in the person's note. */
	logToBody: boolean;
	bodyLogHeading: string;
	/** Write the log date as a [[wikilink]] to that day's note. */
	linkDailyNoteInLog: boolean;

	importOverwriteExisting: boolean;
	importIncludeGivenNameMatches: boolean;
	importNicknamesAsAliases: boolean;

	/** Set once the first run has seeded folders from the user's other plugins. */
	configured: boolean;
}

export const DEFAULT_SETTINGS: PrmSettings = {
	personFolders: ["People"],
	personTags: [],
	personTypeKey: "",
	personTypeValue: "",
	requireTagOrType: false,
	personExclusions: ["template", "MOC", "index", "dashboard", "untitled"],

	newPersonFolder: "",
	newPersonTemplate: "",
	newPersonTier: "",

	journalSources: [{ folder: "Daily Notes", format: "YYYY-MM-DD" }],
	allowFallbackDateFormats: true,
	journalDateKey: "date",

	createdDateKeys: [
		"created",
		"Created",
		"creation date",
		"creation-date",
		"date created",
		"date-created",
		"ctime",
	],

	tiers: [
		{ id: "inner", label: "Inner circle", cadenceDays: 14, color: "#e0567a" },
		{ id: "close", label: "Close", cadenceDays: 30, color: "#e8913a" },
		{ id: "casual", label: "Casual", cadenceDays: 90, color: "#3aa0e8" },
		{ id: "warm", label: "Keep warm", cadenceDays: 180, color: "#8b7ce8" },
		{ id: "dormant", label: "Dormant", cadenceDays: 365, color: "#7c8b8f" },
	],
	defaultTierId: "casual",

	journalMentionsCountAsContact: true,
	ignoreIntentLinks: true,
	dueSoonWindowDays: 7,

	showStatusBar: true,
	notifyOnStartup: true,
	nextUpCount: 5,

	logToBody: true,
	bodyLogHeading: "Contact log",
	linkDailyNoteInLog: true,

	importOverwriteExisting: false,
	importIncludeGivenNameMatches: false,
	importNicknamesAsAliases: false,

	configured: false,
};

export const FRONTMATTER_KEYS = {
	tier: "prm-tier",
	cadence: "prm-cadence",
	lastContacted: "prm-last-contacted",
	snoozeUntil: "prm-snooze-until",
	paused: "prm-paused",
	ignoreJournal: "prm-ignore-journal",
	birthday: "prm-birthday",
	relationship: "prm-relationship",
} as const;

export function tierById(settings: PrmSettings, id: string | null): Tier | null {
	if (!id) return null;
	return settings.tiers.find((t) => t.id === id) ?? null;
}

/** Normalize a user-typed vault path: handles `\`, leading `/`, and Unicode form. */
export function cleanFolderPath(raw: string): string {
	const trimmed = raw.trim().replace(/\\/g, "/");
	if (trimmed === "" || trimmed === "/") return "";
	return normalizePath(trimmed).replace(/^\/+/, "").replace(/\/+$/, "");
}

function splitList(raw: string): string[] {
	return raw
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

/** Settings that hold a list but are edited as one comma-separated field. */
const CSV_KEYS: Record<string, "personTags" | "personExclusions" | "createdDateKeys"> = {
	personTagsCsv: "personTags",
	personExclusionsCsv: "personExclusions",
	createdDateKeysCsv: "createdDateKeys",
};

/**
 * Declarative settings.
 *
 * `getSettingDefinitions` describes the settings instead of rendering them, which
 * is what lets Obsidian index them for settings search. When it returns a
 * non-empty array the deprecated `display()` is never called, so there isn't one.
 */
export class PrmSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PrmPlugin) {
		super(app, plugin);

		// The Status block is derived from the index, but getSettingDefinitions()
		// only runs when the tab opens or update() is called. Without this it shows
		// whatever was true at open time — including all zeros, since the first
		// build is deferred off Obsidian's startup frame.
		plugin.register(plugin.engine.onChange(() => this.refreshIfVisible()));
	}

	/** Re-read the definitions, but never out from under someone's cursor. */
	private refreshIfVisible = debounce(
		() => {
			if (!this.containerEl.isShown()) return;
			const active = activeDocument.activeElement;
			const editing =
				(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
				this.containerEl.contains(active);
			if (editing) return;
			this.update();
		},
		300,
		true,
	);

	// ------------------------------------------------------------- value routing

	/**
	 * Read a control's value. A key is either a settings property, a synthetic
	 * `…Csv` key for a list edited as text, or a dotted path into one of the
	 * collections (`journalSources.0.folder`).
	 */
	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		const parts = key.split(".");

		if (parts.length > 1) {
			const index = Number(parts[1]);
			switch (parts[0]) {
				case "personFolders":
					return s.personFolders[index] ?? "";
				case "journalSources": {
					const source = s.journalSources[index];
					if (!source) return "";
					return parts[2] === "folder" ? source.folder : source.format;
				}
				case "tiers": {
					const tier = s.tiers[index];
					if (!tier) return "";
					if (parts[2] === "label") return tier.label;
					if (parts[2] === "cadenceDays") return tier.cadenceDays;
					if (parts[2] === "color") return tier.color;
					return "";
				}
			}
			return "";
		}

		const csv = CSV_KEYS[key];
		if (csv) return s[csv].join(", ");

		return (s as unknown as Record<string, unknown>)[key];
	}

	setControlValue(key: string, value: unknown): void {
		const s = this.plugin.settings;
		const parts = key.split(".");

		if (parts.length > 1) {
			const index = Number(parts[1]);
			switch (parts[0]) {
				case "personFolders":
					s.personFolders[index] = cleanFolderPath(String(value));
					break;
				case "journalSources": {
					const source = s.journalSources[index];
					if (!source) break;
					if (parts[2] === "folder") source.folder = cleanFolderPath(String(value));
					else source.format = String(value).trim();
					break;
				}
				case "tiers": {
					const tier = s.tiers[index];
					if (!tier) break;
					if (parts[2] === "label") tier.label = String(value);
					else if (parts[2] === "cadenceDays") {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 1) tier.cadenceDays = Math.round(n);
					} else if (parts[2] === "color") tier.color = String(value);
					break;
				}
			}
			void this.plugin.saveSettings();
			return;
		}

		const csv = CSV_KEYS[key];
		if (csv) {
			const list = splitList(String(value));
			// Tags are stored without the leading #.
			s[csv] = csv === "personTags" ? list.map((t) => t.replace(/^#/, "")) : list;
			void this.plugin.saveSettings();
			return;
		}

		(s as unknown as Record<string, unknown>)[key] = value;
		void this.plugin.saveSettings();

		// The status bar can appear or disappear without the index changing.
		if (key === "showStatusBar") this.plugin.refreshStatusBar();
	}

	// -------------------------------------------------------------- definitions

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.statusDefinition(),
			this.peopleGroup(),
			this.personFoldersList(),
			this.newPeopleGroup(),
			this.journalGroup(),
			this.journalSourcesList(),
			this.contactRulesGroup(),
			this.tiersList(),
			this.tierDefaultGroup(),
			this.remindersGroup(),
			this.maintenanceGroup(),
		];
	}

	/** Real counts, so a misconfigured folder is visible rather than looking empty. */
	private statusDefinition(): SettingDefinitionItem {
		const d = this.plugin.engine.diagnostics();
		const stats = this.plugin.engine.stats();

		if (!d.built) {
			return {
				name: "Status",
				desc: "Still indexing — this updates on its own in a moment.",
				aliases: ["diagnostics", "counts", "troubleshooting"],
			};
		}

		const desc = createFragment((frag) => {
			const line = (text: string, bad = false) => {
				const el = frag.createDiv({ cls: "prm-diag-line", text });
				if (bad) el.addClass("prm-diag-bad");
			};

			line(
				`${d.personFilesFound} ${d.personFilesFound === 1 ? "person" : "people"} found` +
					(d.personFilesSkipped > 0 ? ` (${d.personFilesSkipped} notes skipped)` : ""),
				d.personFilesFound === 0,
			);
			line(
				`${d.journalFilesScanned} notes in your dated folders, ${d.journalFilesDated} with a readable date`,
				d.journalFilesScanned > 0 && d.journalFilesDated === 0,
			);
			line(
				`${d.interactionsFound} interactions · ${stats.tracked} tracked, ` +
					`${stats.untracked} unclassified · indexed in ${d.buildMs.toFixed(0)}ms`,
			);
			if (d.missingFolders.length > 0) {
				line(`These folders don't exist: ${d.missingFolders.join(", ")}`, true);
			}
			if (d.personFilesFound === 0) {
				frag.createDiv({
					cls: "prm-diag-hint",
					text: "Nothing matched. Check the people folders below.",
				});
			} else if (d.journalFilesScanned > 0 && d.journalFilesDated === 0) {
				frag.createDiv({
					cls: "prm-diag-hint",
					text: "No filenames matched your date format. Copy it from your Daily Notes or Periodic Notes settings.",
				});
			}
		});

		return {
			name: "Status",
			desc,
			aliases: ["diagnostics", "counts", "troubleshooting", "empty dashboard"],
		};
	}

	private peopleGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Who counts as a person",
			items: [
				{
					name: "Person tags",
					desc: "Comma-separated, without #. Matched as a prefix, so person also claims #person/work. People with these tags are found anywhere in the vault.",
					aliases: ["tag", "hierarchical"],
					control: { type: "text", key: "personTagsCsv", placeholder: "person, people" },
				},
				{
					name: "Person frontmatter field",
					desc: "For vaults that mark people with a field of their own.",
					aliases: ["type", "frontmatter", "metadata"],
					control: { type: "text", key: "personTypeKey", placeholder: "type" },
				},
				{
					name: "Person frontmatter value",
					desc: "The value that field must have. Leave empty to accept any value.",
					visible: () => this.plugin.settings.personTypeKey.length > 0,
					control: { type: "text", key: "personTypeValue", placeholder: "person" },
				},
				{
					name: "Require a tag or field inside the folders",
					desc: "Off means every note in the people folders is a person. Turn on if those folders hold other things too.",
					control: { type: "toggle", key: "requireTagOrType" },
				},
				{
					name: "Never treat these as people",
					desc: "Comma-separated fragments matched against the note title, case-insensitive.",
					aliases: ["exclude", "template", "ignore"],
					control: {
						type: "text",
						key: "personExclusionsCsv",
						placeholder: "template, MOC, index",
					},
				},
			],
		};
	}

	private personFoldersList(): SettingDefinitionItem {
		const folders = this.plugin.settings.personFolders;

		return {
			type: "list",
			heading: "People folders",
			emptyState: "No folders. Add one, or identify people by tag or field above.",
			items: folders.map((folder, index) => ({
				name: `Folder ${index + 1}`,
				desc: this.folderExists(folder) ? undefined : "This folder doesn't exist.",
				control: {
					type: "folder" as const,
					key: `personFolders.${index}`,
					placeholder: "People",
					includeRoot: false,
				},
			})),
			onDelete: (index: number) => {
				folders.splice(index, 1);
				void this.plugin.saveSettings();
				this.update();
			},
			addItem: {
				name: "Add a people folder",
				action: () => {
					folders.push("");
					void this.plugin.saveSettings();
					this.update();
				},
			},
		};
	}

	private newPeopleGroup(): SettingDefinitionItem {
		const tierOptions: Record<string, string> = { "": "Leave unclassified" };
		for (const tier of this.plugin.settings.tiers) tierOptions[tier.id] = tier.label;
		const fallback = this.plugin.settings.personFolders[0] ?? "People";

		return {
			type: "group",
			heading: "Creating new people",
			items: [
				{
					name: "New person folder",
					desc: `Where "Create a person note" and the contact importer put new notes. Leave empty to use ${fallback}.`,
					aliases: ["create", "new", "location"],
					control: {
						type: "folder",
						key: "newPersonFolder",
						placeholder: fallback,
						includeRoot: false,
					},
				},
				{
					name: "Template for new people",
					desc: "A note to copy. Supports {{title}}, {{date}}, {{time}} and any imported field as {{email}}, {{phone}} and so on. Templater's tp.date.now, tp.file.title and tp.file.cursor are translated; other Templater expressions are removed, since they can't be evaluated here. Leave empty for a plain note.",
					aliases: ["template", "create", "new"],
					control: {
						type: "file",
						key: "newPersonTemplate",
						placeholder: "Templates/Person.md",
					},
				},
				{
					name: "Tier for new people",
					desc: "Assign a cadence straight away, so a new person is tracked without a separate step.",
					aliases: ["create", "cadence"],
					control: { type: "dropdown", key: "newPersonTier", options: tierOptions },
				},
			],
		};
	}

	private journalGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Where interactions come from",
			items: [
				{
					name: "Also try common date formats",
					desc: "Recommended if your vault accumulated more than one naming convention over the years.",
					aliases: ["fallback", "legacy"],
					control: { type: "toggle", key: "allowFallbackDateFormats" },
				},
				{
					name: "Date field fallback",
					desc: "When a filename has no date, use this frontmatter field instead. This is what makes a note-per-meeting workflow work. Leave empty to disable.",
					aliases: ["meeting", "frontmatter date"],
					control: { type: "text", key: "journalDateKey", placeholder: "date" },
				},
				{
					name: "Creation date fields",
					desc: "The starting point for someone you've never contacted. First match wins; falls back to the file's timestamp.",
					aliases: ["created", "ctime", "baseline"],
					control: {
						type: "text",
						key: "createdDateKeysCsv",
						placeholder: "created, date created",
					},
				},
				{
					name: "Detect from Daily Notes",
					desc: "Read the folder and date format from Periodic Notes or core Daily Notes.",
					aliases: ["periodic notes", "autodetect"],
					action: () => {
						void (async () => {
							const found = await this.plugin.detectJournalSources();
							this.update();
							new Notice(
								found
									? "Picked up your daily note folder and format."
									: "Couldn't find Daily Notes or Periodic Notes settings.",
							);
						})();
					},
				},
			],
		};
	}

	private journalSourcesList(): SettingDefinitionItem {
		const sources = this.plugin.settings.journalSources;
		const d = this.plugin.engine.diagnostics();
		const nothingDated = d.journalFilesScanned > 0 && d.journalFilesDated === 0;

		const pages: SettingDefinitionPage[] = sources.map((source, index) => ({
			type: "page" as const,
			name: source.folder.length > 0 ? source.folder : `Source ${index + 1}`,
			desc: "A folder of dated notes, and the format its filenames use.",
			displayValue: () => source.format || "no format",
			// Flag a folder that doesn't resolve, or one where nothing could be dated.
			status: () => (!this.folderExists(source.folder) || nothingDated ? "warning" : null),
			items: [
				{
					name: "Folder",
					desc: this.folderExists(source.folder)
						? undefined
						: "This folder doesn't exist.",
					control: {
						type: "folder" as const,
						key: `journalSources.${index}.folder`,
						placeholder: "Daily Notes",
						includeRoot: false,
					},
				},
				{
					name: "Date format",
					desc: "A moment.js pattern — the same one Daily Notes and Periodic Notes use, so you can paste yours in. Folder-nesting patterns work too.",
					control: {
						type: "text" as const,
						key: `journalSources.${index}.format`,
						placeholder: "YYYY-MM-DD",
						validate: (value: string) =>
							value.trim().length === 0 ? "Enter a date format." : undefined,
					},
				},
			],
		}));

		return {
			type: "list",
			heading: "Dated note folders",
			emptyState: "No folders yet. Add one, or use Detect from Daily Notes above.",
			items: pages,
			onDelete: (index: number) => {
				sources.splice(index, 1);
				void this.plugin.saveSettings();
				this.update();
			},
			addItem: {
				name: "Add a dated folder",
				action: () => {
					sources.push({ folder: "", format: "YYYY-MM-DD" });
					void this.plugin.saveSettings();
					this.update();
				},
			},
		};
	}

	private contactRulesGroup(): SettingDefinitionItem {
		const items: SettingGroupItem[] = [
			{
				name: "Links in dated notes count as contact",
				desc: "Recommended. Your journal already names who you saw, so contact history builds itself. Individual people can opt out with prm-ignore-journal.",
				control: { type: "toggle", key: "journalMentionsCountAsContact" },
			},
			{
				name: "Ignore mentions that aren't contact",
				desc: "Skips links inside unchecked to-dos, quotes, code blocks and embeds — so writing a reminder to reach out to someone doesn't mark them as contacted and silence it.",
				aliases: ["todo", "task", "embed", "quote"],
				control: { type: "toggle", key: "ignoreIntentLinks" },
			},
			{
				name: "Due soon window",
				desc: "How long before the due date someone starts showing as coming up.",
				control: {
					type: "slider",
					key: "dueSoonWindowDays",
					min: 0,
					max: 30,
					step: 1,
					displayFormat: (v: number) => (v === 0 ? "off" : `${v} days`),
				},
			},
			{
				name: "Write a log line into the note body",
				desc: "Adds a dated bullet under a heading, so the note keeps a readable history.",
				control: { type: "toggle", key: "logToBody" },
			},
			{
				name: "Log heading",
				visible: () => this.plugin.settings.logToBody,
				control: {
					type: "text",
					key: "bodyLogHeading",
					placeholder: "Contact log",
					validate: (value: string) =>
						value.trim().length === 0 ? "Enter a heading." : undefined,
				},
			},
			{
				name: "Link that day's note",
				desc: "Writes the date as a wikilink when a note for that day exists, so each log line points at it.",
				visible: () => this.plugin.settings.logToBody,
				control: { type: "toggle", key: "linkDailyNoteInLog" },
			},
		];

		return { type: "group", heading: "How contact is counted", items };
	}

	private tiersList(): SettingDefinitionItem {
		const tiers = this.plugin.settings.tiers;

		const pages: SettingDefinitionPage[] = tiers.map((tier, index) => ({
			type: "page" as const,
			name: tier.label,
			desc: `Stored as prm-tier: ${tier.id}`,
			displayValue: () => `every ${formatDuration(tier.cadenceDays)}`,
			items: [
				{
					name: "Label",
					control: {
						type: "text" as const,
						key: `tiers.${index}.label`,
						placeholder: "Close",
					},
				},
				{
					name: "Contact every",
					desc: "Days between one contact and the next being due.",
					control: {
						type: "number" as const,
						key: `tiers.${index}.cadenceDays`,
						min: 1,
						step: 1,
						validate: (value: number) =>
							!Number.isFinite(value) || value < 1 ? "Enter at least 1 day." : undefined,
					},
				},
				{
					name: "Colour",
					control: { type: "color" as const, key: `tiers.${index}.color` },
				},
			],
		}));

		return {
			type: "list",
			heading: "Tiers",
			emptyState: "No tiers. Add one — nobody is tracked until they have a tier.",
			items: pages,
			onReorder: (oldIndex: number, newIndex: number) => {
				const [moved] = tiers.splice(oldIndex, 1);
				if (moved) tiers.splice(newIndex, 0, moved);
				void this.plugin.saveSettings();
				this.update();
			},
			onDelete: (index: number) => {
				const tier = tiers[index];
				if (!tier) return;

				const affected = this.plugin.engine.all().filter((r) => r.tierId === tier.id).length;
				const remove = () => {
					tiers.splice(index, 1);
					const s = this.plugin.settings;
					if (s.defaultTierId === tier.id) s.defaultTierId = tiers[0]?.id ?? "";
					void this.plugin.saveSettings();
					this.update();
				};

				// Deleting a tier silently untracks everyone on it, so say so first.
				if (affected === 0) {
					remove();
					return;
				}
				new ConfirmModal(
					this.app,
					`Remove "${tier.label}"?`,
					`${affected} ${affected === 1 ? "person is" : "people are"} on this tier. ` +
						"Removing it stops tracking them until you assign a new one. Their notes aren't changed.",
					"Remove tier",
					remove,
				).open();
			},
			addItem: {
				name: "Add a tier",
				action: () => {
					const s = this.plugin.settings;
					let id = "new-tier";
					let n = 2;
					while (s.tiers.some((t) => t.id === id)) id = `new-tier-${n++}`;
					s.tiers.push({ id, label: "New tier", cadenceDays: 60, color: "#888888" });
					void this.plugin.saveSettings();
					this.update();
				},
			},
		};
	}

	private tierDefaultGroup(): SettingDefinitionItem {
		const tiers = this.plugin.settings.tiers;
		const options: Record<string, string> = {};
		for (const tier of tiers) options[tier.id] = tier.label;

		return {
			type: "group",
			items: [
				{
					name: "Default tier",
					desc: "Pre-selected during triage.",
					visible: () => tiers.length > 0,
					control: { type: "dropdown", key: "defaultTierId", options },
				},
			],
		};
	}

	private remindersGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Reminders",
			items: [
				{
					name: "Show count in the status bar",
					control: { type: "toggle", key: "showStatusBar" },
				},
				{
					name: "Notify when Obsidian starts",
					desc: "A quiet nudge listing who's overdue.",
					control: { type: "toggle", key: "notifyOnStartup" },
				},
				{
					name: "People per reach-out session",
					desc: "How many people the reach-out flow queues up.",
					control: {
						type: "slider",
						key: "nextUpCount",
						min: 1,
						max: 20,
						step: 1,
						displayFormat: (v: number) => String(v),
					},
				},
			],
		};
	}

	private maintenanceGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Contacts and maintenance",
			items: [
				{
					name: "Import from a Google Contacts export",
					desc: "Fills in email, phone, company, title, location and birthday by matching names. You review every change before anything is written.",
					aliases: ["google", "csv", "vcard", "contacts"],
					action: () => this.plugin.openContactImport(),
				},
				{
					name: "Clear undo history",
					desc: this.plugin.undo.canUndo()
						? `Next undo: ${this.plugin.undo.peekUndo()?.label ?? ""} · ${(
								this.plugin.undo.retainedBytes() / 1024
							).toFixed(0)} KB retained`
						: "Nothing recorded yet this session.",
					disabled: () => !this.plugin.undo.canUndo() && !this.plugin.undo.canRedo(),
					action: () => {
						this.plugin.undo.clear();
						this.update();
					},
				},
				{
					name: "Rebuild index",
					desc: "Re-scans people and dated notes, and reports what it found. The index already updates itself as notes change, so this is for checking rather than fixing.",
					aliases: ["reindex", "refresh"],
					action: () => {
						this.plugin.rebuildAndReport();
						this.update();
					},
				},
			],
		};
	}

	// ------------------------------------------------------------------ helpers

	private folderExists(path: string): boolean {
		if (path.length === 0) return false;
		return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
	}
}
