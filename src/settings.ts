import {
	AbstractInputSuggest,
	App,
	Notice,
	PluginSettingTab,
	Setting,
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

/** Folder autocomplete for the path fields. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private input: HTMLInputElement,
		private onPick: (path: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		const out: TFolder[] = [];
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (file instanceof TFolder && file.path.toLowerCase().contains(q)) out.push(file);
			if (out.length >= 50) break;
		}
		return out;
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path === "/" ? "(vault root)" : folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.input.value = folder.path;
		this.onPick(folder.path);
		this.input.trigger("input");
		this.close();
	}
}

export class PrmSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PrmPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		this.renderDiagnostics(containerEl);
		this.renderPeople(containerEl, s);
		this.renderJournals(containerEl, s);
		this.renderContactRules(containerEl, s);
		this.renderTiers(containerEl, s);
		this.renderReminders(containerEl, s);
		this.renderContacts(containerEl);
		this.renderMaintenance(containerEl);
	}

	/** Real counts, so a misconfigured folder is visible instead of looking empty. */
	private renderDiagnostics(containerEl: HTMLElement): void {
		const d = this.plugin.engine.diagnostics();
		const box = containerEl.createDiv({ cls: "prm-diagnostics" });

		const line = (text: string, cls?: string) =>
			box.createDiv({ cls: cls ? `prm-diag-line ${cls}` : "prm-diag-line", text });

		line(
			`${d.personFilesFound} ${d.personFilesFound === 1 ? "person" : "people"} found` +
				(d.personFilesSkipped > 0 ? ` (${d.personFilesSkipped} notes skipped)` : ""),
			d.personFilesFound === 0 ? "prm-diag-bad" : undefined,
		);
		line(
			`${d.journalFilesScanned} notes in your dated folders, ${d.journalFilesDated} with a readable date`,
			d.journalFilesScanned > 0 && d.journalFilesDated === 0 ? "prm-diag-bad" : undefined,
		);
		line(`${d.interactionsFound} interactions derived · indexed in ${d.buildMs.toFixed(0)}ms`);

		if (d.missingFolders.length > 0) {
			line(`Folders that don't exist: ${d.missingFolders.join(", ")}`, "prm-diag-bad");
		}
		if (d.personFilesFound === 0) {
			line("Check the people folder below — nothing matched.", "prm-diag-hint");
		} else if (d.journalFilesScanned > 0 && d.journalFilesDated === 0) {
			line(
				"None of those filenames matched your date format. Copy the format from Daily Notes or Periodic Notes settings.",
				"prm-diag-hint",
			);
		}
	}

	private renderPeople(containerEl: HTMLElement, s: PrmSettings): void {
		new Setting(containerEl).setName("Who counts as a person").setHeading();

		new Setting(containerEl)
			.setName("People folders")
			.setDesc("Comma-separated. Subfolders are included.")
			.addText((t) => {
				t.setPlaceholder("People")
					.setValue(s.personFolders.join(", "))
					.onChange(async (v) => {
						s.personFolders = splitList(v).map(cleanFolderPath).filter((p) => p.length > 0);
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, t.inputEl, (path) => {
					s.personFolders = [cleanFolderPath(path)];
					void this.plugin.saveSettings();
				});
				return t;
			});

		new Setting(containerEl)
			.setName("Person tags")
			.setDesc(
				"Comma-separated, without #. Matched as a prefix, so `person` also matches #person/work. People with these tags are included wherever they live.",
			)
			.addText((t) =>
				t
					.setPlaceholder("person, people")
					.setValue(s.personTags.join(", "))
					.onChange(async (v) => {
						s.personTags = splitList(v).map((x) => x.replace(/^#/, ""));
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Person frontmatter marker")
			.setDesc('For vaults that use a type field, e.g. key "type" and value "person".')
			.addText((t) =>
				t
					.setPlaceholder("type")
					.setValue(s.personTypeKey)
					.onChange(async (v) => {
						s.personTypeKey = v.trim();
						await this.plugin.saveSettings();
					}),
			)
			.addText((t) =>
				t
					.setPlaceholder("person")
					.setValue(s.personTypeValue)
					.onChange(async (v) => {
						s.personTypeValue = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Require a tag or marker inside the folders")
			.setDesc(
				"Off means every note in the people folders is a person. Turn on if those folders hold other things.",
			)
			.addToggle((t) =>
				t.setValue(s.requireTagOrType).onChange(async (v) => {
					s.requireTagOrType = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Never treat these as people")
			.setDesc("Comma-separated fragments matched against the note title, case-insensitive.")
			.addText((t) =>
				t
					.setValue(s.personExclusions.join(", "))
					.onChange(async (v) => {
						s.personExclusions = splitList(v);
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderJournals(containerEl: HTMLElement, s: PrmSettings): void {
		new Setting(containerEl).setName("Where interactions come from").setHeading();
		containerEl.createEl("p", {
			cls: "prm-settings-hint",
			text: "Any note in these folders that links to a person counts as an interaction on that note's date. The format is a moment.js pattern — the same one Daily Notes and Periodic Notes use, so you can paste yours in.",
		});

		s.journalSources.forEach((source, index) => {
			const setting = new Setting(containerEl).setClass("prm-source-setting");

			setting.addText((t) => {
				t.setPlaceholder("Folder")
					.setValue(source.folder)
					.onChange(async (v) => {
						source.folder = cleanFolderPath(v);
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, t.inputEl, (path) => {
					source.folder = cleanFolderPath(path);
					void this.plugin.saveSettings();
				});
				return t;
			});

			setting.addText((t) =>
				t
					.setPlaceholder("YYYY-MM-DD")
					.setValue(source.format)
					.onChange(async (v) => {
						source.format = v.trim();
						await this.plugin.saveSettings();
					}),
			);

			setting.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip("Remove this source")
					.onClick(async () => {
						s.journalSources.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}),
			);
		});

		new Setting(containerEl)
			.addButton((b) =>
				b.setButtonText("Add folder").onClick(async () => {
					s.journalSources.push({ folder: "", format: "YYYY-MM-DD" });
					await this.plugin.saveSettings();
					this.display();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Detect from Daily Notes")
					.setTooltip("Read folder and format from Periodic Notes or core Daily Notes")
					.onClick(async () => {
						const found = await this.plugin.detectJournalSources();
						this.display();
						new Notice(
							found
								? "Picked up your daily note folder and format."
								: "Couldn't find Daily Notes or Periodic Notes settings.",
						);
					}),
			);

		new Setting(containerEl)
			.setName("Also try common date formats")
			.setDesc(
				"Recommended if your vault accumulated more than one naming convention over the years.",
			)
			.addToggle((t) =>
				t.setValue(s.allowFallbackDateFormats).onChange(async (v) => {
					s.allowFallbackDateFormats = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Date field fallback")
			.setDesc(
				"When a filename has no date, use this frontmatter field. Lets a note-per-meeting workflow work. Leave empty to disable.",
			)
			.addText((t) =>
				t
					.setPlaceholder("date")
					.setValue(s.journalDateKey)
					.onChange(async (v) => {
						s.journalDateKey = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Creation date fields")
			.setDesc(
				"Used as the starting point for someone you've never contacted. First match wins; falls back to the file's timestamp.",
			)
			.addText((t) =>
				t.setValue(s.createdDateKeys.join(", ")).onChange(async (v) => {
					s.createdDateKeys = splitList(v);
					await this.plugin.saveSettings();
				}),
			);
	}

	private renderContactRules(containerEl: HTMLElement, s: PrmSettings): void {
		new Setting(containerEl).setName("How contact is counted").setHeading();

		new Setting(containerEl)
			.setName("Links in dated notes count as contact")
			.setDesc(
				"Recommended. Your journal already names who you saw, so contact history builds itself. Individual people can opt out with prm-ignore-journal: true.",
			)
			.addToggle((t) =>
				t.setValue(s.journalMentionsCountAsContact).onChange(async (v) => {
					s.journalMentionsCountAsContact = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ignore mentions that aren't contact")
			.setDesc(
				"Skips links inside unchecked to-dos, quotes, code blocks and embeds — so writing “TODO: reach out to [[X]]” doesn't mark them as contacted and silence the reminder.",
			)
			.addToggle((t) =>
				t.setValue(s.ignoreIntentLinks).onChange(async (v) => {
					s.ignoreIntentLinks = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Due soon window")
			.setDesc("Days before the due date that someone starts showing as coming up.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 30, 1)
					.setValue(s.dueSoonWindowDays)
					.onChange(async (v) => {
						s.dueSoonWindowDays = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Write a log line into the note body")
			.setDesc("Adds a dated bullet under a heading, so the note keeps a readable history.")
			.addToggle((t) =>
				t.setValue(s.logToBody).onChange(async (v) => {
					s.logToBody = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (s.logToBody) {
			new Setting(containerEl).setName("Log heading").addText((t) =>
				t.setValue(s.bodyLogHeading).onChange(async (v) => {
					s.bodyLogHeading = v.trim() || "Contact log";
					await this.plugin.saveSettings();
				}),
			);

			new Setting(containerEl)
				.setName("Link that day's note")
				.setDesc(
					"Writes the date as a wikilink when a note for that day exists, so each log line points at it.",
				)
				.addToggle((t) =>
					t.setValue(s.linkDailyNoteInLog).onChange(async (v) => {
						s.linkDailyNoteInLog = v;
						await this.plugin.saveSettings();
					}),
				);
		}
	}

	private renderTiers(containerEl: HTMLElement, s: PrmSettings): void {
		new Setting(containerEl).setName("Tiers").setHeading();
		containerEl.createEl("p", {
			cls: "prm-settings-hint",
			text: "A tier sets how often you want to be in touch. Assign one from the dashboard, or with prm-tier. A per-person prm-cadence overrides the tier.",
		});

		for (const tier of s.tiers) {
			const setting = new Setting(containerEl).setClass("prm-tier-setting");

			setting.addText((t) =>
				t
					.setPlaceholder("Label")
					.setValue(tier.label)
					.onChange(async (v) => {
						tier.label = v;
						await this.plugin.saveSettings();
					}),
			);

			setting.addText((t) => {
				t.setPlaceholder("Days")
					.setValue(String(tier.cadenceDays))
					.onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n > 0) {
							tier.cadenceDays = Math.round(n);
							await this.plugin.saveSettings();
						}
					});
				t.inputEl.type = "number";
				t.inputEl.addClass("prm-tier-days");
				return t;
			});

			setting.addColorPicker((c) =>
				c.setValue(tier.color).onChange(async (v) => {
					tier.color = v;
					await this.plugin.saveSettings();
				}),
			);

			setting.addExtraButton((b) =>
				b
					.setIcon("trash-2")
					.setTooltip(`Remove "${tier.label}"`)
					.onClick(() => {
						// Deleting a tier silently untracks everyone on it, so say so first.
						const affected = this.plugin.engine
							.all()
							.filter((r) => r.tierId === tier.id).length;

						const remove = () => {
							s.tiers = s.tiers.filter((x) => x.id !== tier.id);
							if (s.defaultTierId === tier.id) s.defaultTierId = s.tiers[0]?.id ?? "";
							void this.plugin.saveSettings();
							this.display();
						};

						if (affected === 0) {
							remove();
							return;
						}
						new ConfirmModal(
							this.app,
							`Remove "${tier.label}"?`,
							`${affected} ${affected === 1 ? "person is" : "people are"} on this tier. ` +
								"Removing it stops tracking them until you assign a new one. " +
								"Their notes aren't changed.",
							"Remove tier",
							remove,
						).open();
					}),
			);

			setting.nameEl.setText(tier.id);
			setting.nameEl.addClass("prm-tier-id");
		}

		new Setting(containerEl).addButton((b) =>
			b
				.setButtonText("Add tier")
				.setCta()
				.onClick(async () => {
					let id = "new-tier";
					let n = 2;
					while (s.tiers.some((t) => t.id === id)) id = `new-tier-${n++}`;
					s.tiers.push({ id, label: "New tier", cadenceDays: 60, color: "#888888" });
					await this.plugin.saveSettings();
					this.display();
				}),
		);

		if (s.tiers.length > 0) {
			new Setting(containerEl)
				.setName("Default tier")
				.setDesc("Pre-selected during triage.")
				.addDropdown((d) => {
					for (const tier of s.tiers) d.addOption(tier.id, tier.label);
					d.setValue(s.defaultTierId).onChange(async (v) => {
						s.defaultTierId = v;
						await this.plugin.saveSettings();
					});
				});
		}
	}

	private renderReminders(containerEl: HTMLElement, s: PrmSettings): void {
		new Setting(containerEl).setName("Reminders").setHeading();

		new Setting(containerEl).setName("Show count in the status bar").addToggle((t) =>
			t.setValue(s.showStatusBar).onChange(async (v) => {
				s.showStatusBar = v;
				await this.plugin.saveSettings();
				this.plugin.refreshStatusBar();
			}),
		);

		new Setting(containerEl)
			.setName("Notify when Obsidian starts")
			.setDesc("A quiet nudge listing who's overdue.")
			.addToggle((t) =>
				t.setValue(s.notifyOnStartup).onChange(async (v) => {
					s.notifyOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("People per reach-out session")
			.addSlider((sl) =>
				sl
					.setLimits(1, 20, 1)
					.setValue(s.nextUpCount)
					.onChange(async (v) => {
						s.nextUpCount = v;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderContacts(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Contacts").setHeading();

		new Setting(containerEl)
			.setName("Import from a Google Contacts export")
			.setDesc(
				"Fills in email, phone, company, title, location and birthday by matching names. You review every change before anything is written.",
			)
			.addButton((b) =>
				b.setButtonText("Import…").onClick(() => this.plugin.openContactImport()),
			);
	}

	private renderMaintenance(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Maintenance").setHeading();

		const retained = this.plugin.undo.retainedBytes();
		new Setting(containerEl)
			.setName("Undo history")
			.setDesc(
				this.plugin.undo.canUndo()
					? `Next undo: ${this.plugin.undo.peekUndo()?.label} · ${(retained / 1024).toFixed(0)} KB retained`
					: "Nothing recorded yet this session.",
			)
			.addButton((b) =>
				b
					.setButtonText("Clear history")
					.setDisabled(!this.plugin.undo.canUndo() && !this.plugin.undo.canRedo())
					.onClick(() => {
						this.plugin.undo.clear();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Rebuild index")
			.setDesc("Re-scans people and dated notes.")
			.addButton((b) =>
				b.setButtonText("Rebuild").onClick(() => {
					this.plugin.engine.rebuild();
					this.plugin.refreshStatusBar();
					this.display();
				}),
			);
	}
}

export { formatDuration };
