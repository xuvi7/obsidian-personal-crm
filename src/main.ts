import { Notice, Plugin, TFile, debounce, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	FRONTMATTER_KEYS,
	PrmSettingTab,
	PrmSettings,
	cleanFolderPath,
} from "./settings";
import { PrmEngine } from "./engine";
import { PRM_VIEW_TYPE, PrmDashboardView } from "./view";
import {
	CreatePersonModal,
	LogContactModal,
	PersonPickerModal,
	ReachOutModal,
	SnoozeModal,
	TierPickerModal,
	TriageModal,
} from "./modals";
import { ContactImportModal } from "./import-modal";
import { FileSnapshot, UndoEntry, UndoManager } from "./undo";
import { WriteQueue } from "./writes";
import { detectJournalSources, detectPeopleFolder } from "./detect";
import { formatDuration, isISODate, todayISO } from "./dates";
import type { LoopRef, PersonRecord } from "./types";
import { appendFollowUp, completeTask } from "./loops";
import {
	asDisplay,
	contactFields,
	ImportOptions,
	PersonCreation,
	PersonPlan,
} from "./contacts";
import {
	dedupeTags,
	frontmatterOf,
	MutableFrontmatter,
	readTagList,
} from "./frontmatter";
import { defaultPersonNote, renderTemplate, sanitizeNoteName } from "./templates";

interface WriteOptions {
	silent?: boolean;
}

/** What a bulk edit actually did, so callers don't have to parse a toast. */
export interface BulkResult {
	changed: number;
	failed: string[];
}

function describeCount(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

export default class PrmPlugin extends Plugin {
	settings!: PrmSettings;
	engine!: PrmEngine;
	undo!: UndoManager;
	private writes = new WriteQueue();
	private statusBarEl: HTMLElement | null = null;
	private statusTextEl: HTMLElement | null = null;
	private firstBuildDone = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.engine = new PrmEngine(this.app, this.settings);
		this.undo = new UndoManager(this.app, this.writes);

		this.registerView(PRM_VIEW_TYPE, (leaf) => new PrmDashboardView(leaf, this));
		this.addSettingTab(new PrmSettingTab(this.app, this));

		this.addRibbonIcon("users", "Personal CRM", () => void this.openDashboard());

		this.registerCommands();
		this.refreshStatusBar();

		// The metadata cache is the source of truth, so a rebuild is a re-read of
		// in-memory data. `resetTimer: true` is deliberate — it collapses a sync
		// burst of hundreds of files into a single rebuild.
		const rebuild = debounce(() => this.reindex(), 700, true);

		this.registerEvent(this.app.metadataCache.on("resolved", () => this.onResolved(rebuild)));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				// `changed` fires for every note in the vault. On a large vault, editing
				// something unrelated must not cost a re-scan.
				if (this.engine.affectsIndex(file)) rebuild();
			}),
		);
		this.registerEvent(this.app.vault.on("delete", rebuild));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// Snapshots key on path, so without this an undo becomes impossible
				// the moment a note is renamed.
				this.undo.remapPath(oldPath, file.path);
				rebuild();
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			void this.firstRunSetup();
			// Keep the first build off Obsidian's startup frame. `resolved` usually
			// beats this; whichever lands first wins and the other is a no-op.
			window.setTimeout(() => this.reindex(), 0);
		});
	}

	onunload(): void {
		// Obsidian tears down registered views, events and DOM for us.
	}

	// ------------------------------------------------------------------- indexing

	private reindex(): void {
		this.engine.rebuild();
		this.refreshStatusBar();
		if (!this.firstBuildDone) {
			this.firstBuildDone = true;
			if (this.settings.notifyOnStartup) this.startupNotice();
		}
	}

	/**
	 * `resolved` is the point at which link resolution is actually complete. A
	 * build before it can see empty `resolvedLinks` and report everyone as never
	 * contacted, so the startup notice waits for this.
	 */
	private onResolved(rebuild: () => void): void {
		if (!this.firstBuildDone) this.reindex();
		else rebuild();
	}

	// ------------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		const raw: unknown = await this.loadData();
		const stored: Record<string, unknown> =
			typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
		this.settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<PrmSettings>) };

		// Repair anything a hand-edited or older data.json might have dropped.
		if (!Array.isArray(this.settings.tiers) || this.settings.tiers.length === 0) {
			this.settings.tiers = DEFAULT_SETTINGS.tiers.map((t) => ({ ...t }));
		}
		for (const key of [
			"personFolders",
			"personTags",
			"personExclusions",
			"createdDateKeys",
		] as const) {
			if (!Array.isArray(this.settings[key])) {
				this.settings[key] = [...DEFAULT_SETTINGS[key]];
			}
		}
		if (!Array.isArray(this.settings.journalSources)) {
			this.settings.journalSources = DEFAULT_SETTINGS.journalSources.map((s) => ({ ...s }));
		}

		// Normalize here, not just in the settings UI: a data.json can be hand-edited
		// or synced from another OS, where `People\Friends` would match nothing.
		this.settings.personFolders = this.settings.personFolders
			.map(cleanFolderPath)
			.filter((p) => p.length > 0);
		for (const source of this.settings.journalSources) {
			source.folder = cleanFolderPath(source.folder);
		}

		// Migrate the pre-1.1 shape, which had a single folder and no formats.
		const oldPeople = stored["peopleFolder"];
		if (typeof oldPeople === "string" && oldPeople.length > 0 && !stored["personFolders"]) {
			this.settings.personFolders = [cleanFolderPath(oldPeople)];
		}
		const oldJournals = stored["journalFolders"];
		if (Array.isArray(oldJournals) && !stored["journalSources"]) {
			this.settings.journalSources = oldJournals
				.map((f) => cleanFolderPath(String(f)))
				.filter((f) => f.length > 0)
				.map((folder) => ({ folder, format: "YYYY-MM-DD" }));
			this.settings.configured = true;
		}
	}

	/** Debounced: settings fields fire per keystroke and each save reindexes. */
	private persist = debounce(
		() => {
			void this.saveData(this.settings);
			this.engine.rebuild();
			this.refreshStatusBar();
		},
		400,
		false,
	);

	async saveSettings(): Promise<void> {
		this.persist();
	}

	async saveImportOptions(options: ImportOptions): Promise<void> {
		this.settings.importOverwriteExisting = options.overwriteExisting;
		this.settings.importIncludeGivenNameMatches = options.includeGivenNameMatches;
		this.settings.importNicknamesAsAliases = options.nicknamesAsAliases;
		await this.saveData(this.settings);
	}

	/**
	 * On a genuinely first run, take the journal folder and format from whatever
	 * the user already configured in Daily Notes or Periodic Notes, and guess the
	 * people folder. Better than shipping one vault's conventions as defaults.
	 */
	private async firstRunSetup(): Promise<void> {
		if (this.settings.configured) return;
		this.settings.configured = true;

		const sources = detectJournalSources(this.app);
		if (sources.length > 0) this.settings.journalSources = sources;

		const people = detectPeopleFolder(this.app);
		if (people) this.settings.personFolders = [people];

		await this.saveData(this.settings);

		if (sources.length > 0 || people) {
			new Notice(
				`Personal CRM set up from your vault: people in "${
					this.settings.personFolders[0] ?? "?"
				}", dated notes in "${this.settings.journalSources[0]?.folder ?? "?"}". Adjust in settings.`,
				9000,
			);
		}
	}

	/**
	 * Fill in the folders from what the vault already knows: Daily/Periodic Notes
	 * for the dated folders, and a likely-looking folder name for people.
	 *
	 * Only fills what is empty — it should never overwrite a choice already made.
	 */
	async detectFromVault(): Promise<{ sources: number; people: string | null }> {
		const sources = detectJournalSources(this.app);
		if (sources.length > 0 && this.settings.journalSources.length === 0) {
			this.settings.journalSources = sources;
		}

		let people: string | null = null;
		if (this.settings.personFolders.length === 0) {
			people = detectPeopleFolder(this.app);
			if (people) this.settings.personFolders = [people];
		}

		await this.saveData(this.settings);
		this.engine.rebuild();
		this.refreshStatusBar();
		return { sources: sources.length, people };
	}

	/** Frontmatter for a person note, for the import planner. */
	frontmatterFor(path: string): Record<string, unknown> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return {};
		return frontmatterOf(this.app.metadataCache.getFileCache(file));
	}

	// ------------------------------------------------------------------- commands

	private registerCommands(): void {
		this.addCommand({
			id: "open-dashboard",
			name: "Open dashboard",
			callback: () => void this.openDashboard(),
		});

		this.addCommand({
			id: "reach-out",
			name: "Who should I reach out to?",
			callback: () => this.startReachOutSession(),
		});

		this.addCommand({
			id: "triage",
			name: "Triage unclassified people",
			callback: () => this.startTriage(),
		});

		this.addCommand({
			id: "log-contact-picker",
			name: "Log contact with…",
			callback: () => {
				new PersonPickerModal(
					this,
					this.engine.all(),
					(record) => new LogContactModal(this, record).open(),
					"Who did you talk to?",
				).open();
			},
		});

		this.addCommand({
			id: "log-contact-current",
			name: "Log contact with this person (today)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.engine.isPersonFile(file)) return false;
				if (!checking && file) void this.logContact(file, todayISO());
				return true;
			},
		});

		this.addCommand({
			id: "set-tier-current",
			name: "Set contact cadence for this person",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const record = this.engine.get(file.path);
				if (!record) return false;
				if (!checking) new TierPickerModal(this, record).open();
				return true;
			},
		});

		this.addCommand({
			id: "snooze-current",
			name: "Snooze this person",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const record = this.engine.get(file.path);
				if (!record) return false;
				if (!checking) new SnoozeModal(this, record).open();
				return true;
			},
		});

		this.addCommand({
			id: "jump-to-person",
			name: "Jump to person",
			callback: () => {
				new PersonPickerModal(this, this.engine.all(), (record) => {
					void this.openPerson(record);
				}).open();
			},
		});

		this.addCommand({
			id: "create-person",
			name: "Add a person…",
			callback: () => this.openCreatePerson(),
		});

		this.addCommand({
			id: "import-contacts",
			name: "Import contact details from a Google Contacts export…",
			callback: () => this.openContactImport(),
		});

		this.addCommand({
			id: "undo",
			name: "Undo last change",
			checkCallback: (checking) => {
				if (!this.undo.canUndo()) return false;
				if (!checking) void this.performUndo();
				return true;
			},
		});

		this.addCommand({
			id: "redo",
			name: "Redo last undone change",
			checkCallback: (checking) => {
				if (!this.undo.canRedo()) return false;
				if (!checking) void this.performRedo();
				return true;
			},
		});

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild index",
			callback: () => this.rebuildAndReport(),
		});
	}

	/**
	 * Re-derive the index and say what came back.
	 *
	 * The index already rebuilds itself on metadata changes, so a manual rebuild
	 * usually finds exactly what was there before. Reporting the counts is what
	 * makes it evident that it ran at all.
	 */
	rebuildAndReport(): void {
		this.engine.rebuild();
		this.refreshStatusBar();
		const d = this.engine.diagnostics();
		new Notice(
			`${d.personFilesFound} ${d.personFilesFound === 1 ? "person" : "people"} · ` +
				`${d.journalFilesDated}/${d.journalFilesScanned} dated notes · ` +
				`${d.interactionsFound} interactions · ${d.buildMs.toFixed(0)}ms`,
			6000,
		);
	}

	// ---------------------------------------------------------------------- flows

	async openDashboard(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(PRM_VIEW_TYPE);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: PRM_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	startReachOutSession(): void {
		new ReachOutModal(this, this.engine.queue(this.settings.nextUpCount)).open();
	}

	startTriage(): void {
		const queue = this.engine
			.all()
			.filter((r) => r.status === "untracked")
			// Most-mentioned people first: those are the relationships worth
			// classifying, and the ones you have context for.
			.sort((a, b) => b.mentionCount - a.mentionCount || a.name.localeCompare(b.name));

		if (queue.length === 0) {
			new Notice("Nothing to triage — everyone has a cadence or is paused.");
			return;
		}
		new TriageModal(this, queue).open();
	}

	openContactImport(): void {
		new ContactImportModal(this).open();
	}

	openCreatePerson(): void {
		new CreatePersonModal(this).open();
	}

	// -------------------------------------------------------- creating people

	/** Where new person notes go: the dedicated setting, else the first people folder. */
	newPersonFolder(): string {
		const configured = cleanFolderPath(this.settings.newPersonFolder);
		if (configured.length > 0) return configured;
		return this.settings.personFolders[0] ?? "People";
	}

	/** Build the text of a new person note, from the configured template if any. */
	async personNoteContent(name: string, fields: Record<string, string>): Promise<string> {
		const templatePath = this.settings.newPersonTemplate.trim();
		if (templatePath.length > 0) {
			const file = this.app.vault.getAbstractFileByPath(templatePath);
			if (file instanceof TFile) {
				const raw = await this.app.vault.cachedRead(file);
				return renderTemplate(raw, { title: name, fields });
			}
			// Say so rather than silently falling back to a different shape.
			new Notice(`Template "${templatePath}" not found — using a plain note.`);
		}
		return defaultPersonNote({ title: name, fields });
	}

	/**
	 * Create one person note.
	 *
	 * Returns the existing note untouched if one already has that name — creating a
	 * person is not a reason to overwrite what's already written about them.
	 */
	async createPerson(
		rawName: string,
		opts: { fields?: Record<string, string>; tierId?: string | null; open?: boolean } = {},
	): Promise<{ file: TFile; created: boolean } | null> {
		const name = sanitizeNoteName(rawName);
		if (name.length === 0) {
			new Notice("That name can't be used as a note title.");
			return null;
		}

		const folder = this.newPersonFolder();
		const path = folder.length > 0 ? `${folder}/${name}.md` : `${name}.md`;

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			new Notice(`${name} already exists.`);
			if (opts.open) await this.app.workspace.getLeaf(false).openFile(existing);
			return { file: existing, created: false };
		}

		try {
			await this.ensureFolder(folder);
			const content = await this.personNoteContent(name, opts.fields ?? {});
			const file = await this.app.vault.create(path, content);

			const tierId = opts.tierId ?? this.settings.newPersonTier;
			await this.applyPersonFields(file, opts.fields ?? {}, tierId);

			const finalContent = await this.app.vault.read(file);
			this.undo.record(`Create ${name}`, [], [{ path: file.path, content: finalContent }]);

			this.engine.rebuild();
			this.refreshStatusBar();
			if (opts.open) await this.app.workspace.getLeaf(false).openFile(file);
			return { file, created: true };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			console.error(`[personal-crm] could not create ${path}`, err);
			new Notice(`Could not create ${name}: ${detail}`);
			return null;
		}
	}

	/**
	 * Write the plugin's own fields into a freshly created note.
	 *
	 * Done through processFrontMatter rather than by string-building, so the result
	 * is valid YAML whatever shape the user's template is in — and so a template
	 * that already sets one of these keeps its value.
	 */
	private async applyPersonFields(
		file: TFile,
		fields: Record<string, string>,
		tierId: string | null,
	): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
			if (tierId && tierId.length > 0 && fm[FRONTMATTER_KEYS.tier] === undefined) {
				fm[FRONTMATTER_KEYS.tier] = tierId;
			}
			for (const [key, value] of Object.entries(fields)) {
				if (value.trim().length === 0) continue;
				if (fm[key] === undefined) fm[key] = value;
			}
		});
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (folder.length === 0) return;
		if (this.app.vault.getAbstractFileByPath(folder)) return;
		try {
			await this.app.vault.createFolder(folder);
		} catch {
			// Another writer may have created it in between; only a genuine failure
			// matters, and vault.create() below will report that.
		}
	}

	async openPerson(record: PersonRecord, newTab = false): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (!(file instanceof TFile)) {
			new Notice(`Could not find ${record.path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
		await leaf.openFile(file);
	}

	/** Open the dated note an interaction came from. */
	async openInteraction(record: PersonRecord, date: string): Promise<void> {
		const path = record.sources.get(date);
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile)) {
			new Notice(`No note found for ${date}.`);
			return;
		}
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	// ----------------------------------------------------------------- undo/redo

	async performUndo(): Promise<void> {
		const result = await this.undo.undo();
		this.engine.rebuild();
		this.refreshStatusBar();
		new Notice(result.ok ? `Undid: ${result.label}` : result.reason);
	}

	async performRedo(): Promise<void> {
		const result = await this.undo.redo();
		this.engine.rebuild();
		this.refreshStatusBar();
		new Notice(result.ok ? `Redid: ${result.label}` : result.reason);
	}

	/**
	 * Run a write, snapshotting the file either side so it can be reversed.
	 *
	 * Queued per path: our own multi-step actions must not interleave, or the
	 * snapshots capture a mixture of two changes and one undo reverses both.
	 */
	private async tracked(
		file: TFile,
		label: string,
		mutate: () => Promise<void>,
	): Promise<UndoEntry | null> {
		return this.writes.run(file.path, async () => {
			const before = await this.app.vault.read(file);
			await mutate();
			const after = await this.app.vault.read(file);
			return this.undo.record(label, [{ path: file.path, before, after }]);
		});
	}

	// ----------------------------------------------------------------- bulk writes

	/**
	 * Apply the same edit to many notes as one undoable step.
	 *
	 * Each note is snapshotted inside its own queued turn, so a concurrent write to
	 * one of them can't be absorbed into this entry — and one failure doesn't lose
	 * the notes that already succeeded, since they are recorded either way.
	 */
	private async trackedMany(
		paths: string[],
		label: string,
		mutate: (file: TFile) => Promise<void>,
		onProgress?: (done: number, total: number) => void,
	): Promise<BulkResult> {
		const snapshots: FileSnapshot[] = [];
		const failed: string[] = [];

		for (let i = 0; i < paths.length; i++) {
			const file = this.app.vault.getAbstractFileByPath(paths[i]);
			if (!(file instanceof TFile)) {
				failed.push(paths[i]);
				continue;
			}
			try {
				await this.writes.run(file.path, async () => {
					const before = await this.app.vault.read(file);
					await mutate(file);
					const after = await this.app.vault.read(file);
					if (before !== after) snapshots.push({ path: file.path, before, after });
				});
			} catch (err) {
				failed.push(file.basename);
				console.error(`[personal-crm] bulk edit failed for ${file.path}`, err);
			}
			onProgress?.(i + 1, paths.length);
			// Yield periodically so a large selection doesn't freeze the window.
			if (i % 25 === 24) await new Promise((r) => window.setTimeout(r, 0));
		}

		const entry = snapshots.length > 0 ? this.undo.record(label, snapshots) : null;
		this.engine.rebuild();
		this.refreshStatusBar();

		const message = [
			snapshots.length === 0 ? "Nothing needed changing" : label,
			failed.length > 0 ? `${failed.length} failed` : "",
		]
			.filter((p) => p.length > 0)
			.join(" · ");
		if (entry) this.noticeWithUndo(message, entry);
		else new Notice(`${message}.`);

		return { changed: snapshots.length, failed };
	}

	async bulkLogContact(paths: string[], date = todayISO(), note?: string): Promise<BulkResult> {
		if (!isISODate(date)) {
			new Notice(`"${date}" isn't a valid date.`);
			return { changed: 0, failed: [] };
		}
		const label = `Log contact with ${describeCount(paths.length, "person", "people")}`;
		return this.trackedMany(paths, label, async (file) => {
			if (this.settings.logToBody) await this.appendBodyLog(file, date, note);
			await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
				fm[FRONTMATTER_KEYS.lastContacted] = date;
				delete fm[FRONTMATTER_KEYS.snoozeUntil];
			});
		});
	}

	async bulkSetTier(paths: string[], tierId: string | null): Promise<BulkResult> {
		const tier = this.settings.tiers.find((t) => t.id === tierId);
		const label = tier
			? `Set ${describeCount(paths.length, "person", "people")} to ${tier.label}`
			: `Stop tracking ${describeCount(paths.length, "person", "people")}`;
		return this.trackedMany(paths, label, async (file) => {
			await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
				if (tierId === null) delete fm[FRONTMATTER_KEYS.tier];
				else fm[FRONTMATTER_KEYS.tier] = tierId;
				if (tierId !== null) delete fm[FRONTMATTER_KEYS.paused];
			});
		});
	}

	async bulkSnooze(paths: string[], until: string): Promise<BulkResult> {
		if (!isISODate(until)) {
			new Notice(`"${until}" isn't a valid date.`);
			return { changed: 0, failed: [] };
		}
		return this.trackedMany(
			paths,
			`Snooze ${describeCount(paths.length, "person", "people")} until ${until}`,
			async (file) => {
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					fm[FRONTMATTER_KEYS.snoozeUntil] = until;
				});
			},
		);
	}

	/**
	 * Add or remove a tag across a selection.
	 *
	 * Writes the note's own `tags` frontmatter, so the tag is a real Obsidian tag —
	 * it shows in search, the tag pane and Dataview, not only in this plugin. Tags
	 * written in the body with `#` are left alone; only frontmatter is managed.
	 */
	async bulkTag(paths: string[], tag: string, add: boolean): Promise<BulkResult> {
		const clean = tag.trim().replace(/^#/, "");
		if (clean.length === 0) {
			new Notice("Enter a tag.");
			return { changed: 0, failed: [] };
		}
		const label = add
			? `Tag ${describeCount(paths.length, "person", "people")} with ${clean}`
			: `Remove ${clean} from ${describeCount(paths.length, "person", "people")}`;

		return this.trackedMany(paths, label, async (file) => {
			await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
				const current = readTagList(fm["tags"] ?? fm["tag"]);
				const key = clean.toLowerCase();
				const without = current.filter((t) => t.toLowerCase() !== key);
				const next = add ? dedupeTags([...without, clean]) : without;

				// Keep using whichever key the note already has, or `tags` for a new one.
				const field = fm["tags"] !== undefined ? "tags" : fm["tag"] !== undefined ? "tag" : "tags";
				if (next.length === 0) delete fm[field];
				else fm[field] = next;
			});
		});
	}

	// --------------------------------------------------------------------- writes

	/**
	 * Tick an open loop's task off in whichever note holds it.
	 *
	 * The ref carries an offset and a line, both of which an edit can invalidate.
	 * If neither still points at an open task the write is declined rather than
	 * ticking off whatever moved into its place.
	 */
	async completeLoop(ref: LoopRef): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(ref.path);
		if (!(file instanceof TFile)) {
			new Notice(`${ref.path} is gone.`);
			return false;
		}

		let done = false;
		const entry = await this.tracked(file, `Complete follow-up in ${file.basename}`, async () => {
			try {
				await this.app.vault.process(file, (content) => {
					const next = completeTask(content, ref);
					if (next === null) return content;
					done = true;
					return next;
				});
			} catch (error) {
				this.reportWriteError(file, error);
			}
		});

		if (!done) {
			new Notice("That follow-up has already changed — reindexing.");
			this.reindex();
			return false;
		}
		this.afterWrite("Follow-up completed.", entry);
		return true;
	}

	/** Add a follow-up to a person's note, under the configured heading. */
	async addFollowUp(record: PersonRecord, text: string): Promise<boolean> {
		const clean = text.trim();
		if (clean.length === 0) {
			new Notice("Write the follow-up first.");
			return false;
		}
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (!(file instanceof TFile)) {
			new Notice(`${record.path} is gone.`);
			return false;
		}

		const heading = this.settings.followUpHeading.trim() || "Follow-ups";
		const entry = await this.tracked(file, `Add follow-up for ${record.name}`, async () => {
			try {
				await this.app.vault.process(file, (content) =>
					appendFollowUp(content, heading, clean),
				);
			} catch (error) {
				this.reportWriteError(file, error);
			}
		});
		this.afterWrite(`Follow-up added for ${record.name}.`, entry);
		return true;
	}

	async logContact(file: TFile, date = todayISO(), note?: string): Promise<void> {
		if (!isISODate(date)) {
			new Notice(`"${date}" isn't a valid date (expected YYYY-MM-DD).`);
			return;
		}

		const label = `Log contact with ${file.basename}`;
		try {
			const entry = await this.tracked(file, label, async () => {
				if (this.settings.logToBody) await this.appendBodyLog(file, date, note);
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					fm[FRONTMATTER_KEYS.lastContacted] = date;
					// An explicit "I've handled this" makes any snooze meaningless.
					delete fm[FRONTMATTER_KEYS.snoozeUntil];
				});
			});
			this.afterWrite(`Logged contact with ${file.basename}.`, entry);
		} catch (err) {
			this.reportWriteError(file, err);
		}
	}

	async setTier(file: TFile, tierId: string | null, opts: WriteOptions = {}): Promise<void> {
		const tier = this.settings.tiers.find((t) => t.id === tierId);
		const label = tier
			? `Set ${file.basename} to ${tier.label}`
			: `Stop tracking ${file.basename}`;

		try {
			const entry = await this.tracked(file, label, async () => {
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					if (tierId === null) delete fm[FRONTMATTER_KEYS.tier];
					else fm[FRONTMATTER_KEYS.tier] = tierId;
					if (tierId !== null) delete fm[FRONTMATTER_KEYS.paused];
				});
			});
			this.afterWrite(
				tier
					? `${file.basename}: every ${formatDuration(tier.cadenceDays)}.`
					: `${file.basename} is no longer tracked.`,
				entry,
				opts,
			);
		} catch (err) {
			this.reportWriteError(file, err);
		}
	}

	async setCadence(file: TFile, days: number | null): Promise<void> {
		const label =
			days === null
				? `Clear custom cadence for ${file.basename}`
				: `Set ${file.basename} to every ${days} days`;

		try {
			const entry = await this.tracked(file, label, async () => {
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					if (days === null) delete fm[FRONTMATTER_KEYS.cadence];
					else fm[FRONTMATTER_KEYS.cadence] = days;
				});
			});
			this.afterWrite(
				days === null
					? `${file.basename}: custom cadence removed.`
					: `${file.basename}: every ${days} days.`,
				entry,
			);
		} catch (err) {
			this.reportWriteError(file, err);
		}
	}

	async setPaused(file: TFile, paused: boolean, opts: WriteOptions = {}): Promise<void> {
		const label = paused ? `Stop tracking ${file.basename}` : `Resume ${file.basename}`;
		try {
			const entry = await this.tracked(file, label, async () => {
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					if (paused) fm[FRONTMATTER_KEYS.paused] = true;
					else delete fm[FRONTMATTER_KEYS.paused];
				});
			});
			this.afterWrite(
				paused ? `${file.basename} won't be tracked.` : `${file.basename} is tracked again.`,
				entry,
				opts,
			);
		} catch (err) {
			this.reportWriteError(file, err);
		}
	}

	async snooze(file: TFile, until: string): Promise<void> {
		if (!isISODate(until)) {
			new Notice(`"${until}" isn't a valid date.`);
			return;
		}
		try {
			const entry = await this.tracked(file, `Snooze ${file.basename}`, async () => {
				await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
					fm[FRONTMATTER_KEYS.snoozeUntil] = until;
				});
			});
			this.afterWrite(`${file.basename} snoozed until ${until}.`, entry);
		} catch (err) {
			this.reportWriteError(file, err);
		}
	}

	/**
	 * Apply a reviewed contact-import plan as one undoable step.
	 *
	 * Re-checks each change against the note's current value: the preview may be
	 * minutes old, and "only fill empty fields" has to still mean that at the
	 * moment of writing.
	 */
	async applyContactImport(
		plans: PersonPlan[],
		overwriteExisting: boolean,
		onProgress?: (done: number, total: number) => void,
		creations: PersonCreation[] = [],
	): Promise<{ written: number; created: number; skipped: number; failed: string[] }> {
		const snapshots: FileSnapshot[] = [];
		const created: { path: string; content: string }[] = [];
		const failed: string[] = [];
		let skipped = 0;
		const total = plans.length + creations.length;

		// Create the new notes first, so a failure happens before anything is edited.
		for (let i = 0; i < creations.length; i++) {
			const creation = creations[i];
			const name = sanitizeNoteName(creation.name);
			if (name.length === 0) {
				failed.push(creation.name);
				continue;
			}
			const folder = this.newPersonFolder();
			const path = folder.length > 0 ? `${folder}/${name}.md` : `${name}.md`;
			if (this.app.vault.getAbstractFileByPath(path)) {
				// Someone else made it, or it was in the list twice.
				skipped++;
				continue;
			}
			try {
				await this.ensureFolder(folder);
				const fields = contactFields(creation.contact);
				const content = await this.personNoteContent(name, fields);
				const file = await this.app.vault.create(path, content);
				await this.applyPersonFields(file, fields, this.settings.newPersonTier);
				created.push({ path: file.path, content: await this.app.vault.read(file) });
			} catch (err) {
				failed.push(creation.name);
				console.error(`[personal-crm] could not create ${path}`, err);
			}
			onProgress?.(i + 1, total);
			if (i % 25 === 24) await new Promise((r) => window.setTimeout(r, 0));
		}

		for (let i = 0; i < plans.length; i++) {
			const plan = plans[i];
			const file = this.app.vault.getAbstractFileByPath(plan.personPath);
			if (!(file instanceof TFile)) {
				failed.push(plan.personName);
				continue;
			}

			try {
				await this.writes.run(file.path, async () => {
					const before = await this.app.vault.read(file);
					await this.app.fileManager.processFrontMatter(file, (fm: MutableFrontmatter) => {
						for (const change of plan.changes) {
							const current = asDisplay(fm[change.key]);
							// Someone edited it since the preview — leave theirs alone.
							if (current !== change.from) {
								if (!overwriteExisting) {
									skipped++;
									continue;
								}
							}
							fm[change.key] = change.to;
						}
					});
					const after = await this.app.vault.read(file);
					if (before !== after) snapshots.push({ path: file.path, before, after });
				});
			} catch (err) {
				failed.push(plan.personName);
				console.error(`[personal-crm] import failed for ${plan.personPath}`, err);
			}

			onProgress?.(creations.length + i + 1, total);
			// Yield so a few thousand notes don't freeze the window.
			if (i % 25 === 24) await new Promise((r) => window.setTimeout(r, 0));
		}

		if (snapshots.length > 0 || created.length > 0) {
			const parts: string[] = [];
			if (created.length > 0) parts.push(`create ${created.length}`);
			if (snapshots.length > 0) parts.push(`update ${snapshots.length}`);
			this.undo.record(`Contact import: ${parts.join(", ")}`, snapshots, created);
		}

		this.engine.rebuild();
		this.refreshStatusBar();
		return { written: snapshots.length, created: created.length, skipped, failed };
	}

	/**
	 * Insert a dated bullet under the log heading, newest first.
	 *
	 * Heading positions come from the metadata cache, which is fence-aware — a
	 * line-scan would happily match a `# Contact log` inside a code block.
	 * `vault.process` makes the read-modify-write atomic.
	 */
	private async appendBodyLog(file: TFile, date: string, note?: string): Promise<void> {
		const heading = this.settings.bodyLogHeading;
		const entry = this.logEntry(date, note);
		const target = heading.trim().toLowerCase();

		const cache = this.app.metadataCache.getFileCache(file);
		const match = (cache?.headings ?? []).find(
			(h) => h.heading.trim().toLowerCase() === target,
		);

		// Match the note's own top-level sections rather than always using `##`.
		// A deeper heading would nest the log under whatever section precedes it,
		// which is wrong in the outline and makes that section look non-empty.
		const levels = (cache?.headings ?? []).map((h) => h.level);
		const hashes = "#".repeat(levels.length > 0 ? Math.min(...levels) : 2);

		await this.app.vault.process(file, (data) => {
			if (match) {
				const offset = match.position.end.offset;
				// Guard against a cache that lags the file.
				if (offset <= data.length) {
					return `${data.slice(0, offset)}\n${entry}${data.slice(offset)}`;
				}
			}
			const separator = data.length === 0 || data.endsWith("\n") ? "" : "\n";
			return `${data}${separator}\n${hashes} ${heading}\n${entry}\n`;
		});
	}

	/**
	 * One log entry: a dated bullet, plus the note if there is one.
	 *
	 * A multi-line note is indented to the bullet's text column so every line stays
	 * inside the same list item — otherwise the second line would terminate the
	 * list and render as body text. Blank lines are kept (as indented whitespace) so
	 * paragraph breaks survive.
	 */
	private logEntry(date: string, note?: string): string {
		const bullet = `- ${this.dateToken(date)}`;
		const text = (note ?? "").trim();
		if (text.length === 0) return bullet;

		const [first, ...rest] = text.split(/\r?\n/);
		const indented = rest.map((line) => (line.trim().length === 0 ? "  " : `  ${line}`));
		return [`${bullet} — ${first}`, ...indented].join("\n");
	}

	/**
	 * A log line's date, linked to that day's note when one exists under exactly
	 * that name. Otherwise the plain date — a bracketed link to a note that will
	 * never exist just litters the graph with phantoms.
	 */
	private dateToken(date: string): string {
		if (!this.settings.linkDailyNoteInLog) return date;
		if (this.engine.hasNoteTitledDate(date)) return `[[${date}]]`;

		const note = this.engine.noteForDate(date);
		// Keep the display text a date even when the note is named something else.
		if (note) return `[[${note.basename}|${date}]]`;
		return date;
	}

	private afterWrite(
		message: string,
		entry: UndoEntry | null,
		opts: WriteOptions = {},
	): void {
		this.engine.rebuild();
		this.refreshStatusBar();
		if (opts.silent) return;

		if (entry) this.noticeWithUndo(message, entry);
		else new Notice(message);
	}

	private reportWriteError(file: TFile, err: unknown): void {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`[personal-crm] write failed for ${file.path}`, err);
		new Notice(
			`Couldn't update ${file.basename}: ${detail}. Check the note's frontmatter is valid YAML.`,
			10000,
		);
	}

	/**
	 * A confirmation that can be reversed straight from the toast.
	 *
	 * Bound to the specific entry, not "whatever is newest" — two toasts can be on
	 * screen at once, and clicking one must not undo the other's action.
	 */
	private noticeWithUndo(message: string, entry: UndoEntry): void {
		const fragment = createFragment((frag) => {
			frag.appendText(`${message} `);
			const link = frag.createEl("a", { text: "Undo", cls: "prm-notice-undo" });
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				notice.hide();
				void this.undoSpecific(entry);
			});
		});

		const notice = new Notice(fragment, 7000);
	}

	private async undoSpecific(entry: UndoEntry): Promise<void> {
		const result = await this.undo.undoSpecific(entry);
		this.engine.rebuild();
		this.refreshStatusBar();
		new Notice(result.ok ? `Undid: ${result.label}` : result.reason);
	}

	// ------------------------------------------------------------------ status bar

	refreshStatusBar(): void {
		if (!this.settings.showStatusBar) {
			if (this.statusBarEl) this.statusBarEl.hide();
			return;
		}

		if (!this.statusBarEl) {
			// Created once: re-creating it would re-register the click handler, which
			// is only released on plugin unload.
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClasses(["mod-clickable", "prm-status"]);
			setIcon(this.statusBarEl.createSpan({ cls: "prm-status-icon" }), "users");
			this.statusTextEl = this.statusBarEl.createSpan({ cls: "prm-status-count" });
			this.registerDomEvent(this.statusBarEl, "click", () => void this.openDashboard());
		}
		this.statusBarEl.show();

		const stats = this.engine.stats();
		if (this.statusTextEl) {
			this.statusTextEl.setText(stats.overdue > 0 ? String(stats.overdue) : "");
		}
		this.statusBarEl.toggleClass("prm-status-alert", stats.overdue > 0);
		this.statusBarEl.setAttribute(
			"aria-label",
			stats.overdue > 0
				? `${stats.overdue} to reach out to, ${stats.dueSoon} due soon`
				: stats.dueSoon > 0
					? `All caught up — ${stats.dueSoon} due soon`
					: "Personal CRM — all caught up",
		);
	}

	private startupNotice(): void {
		const stats = this.engine.stats();
		if (stats.overdue === 0) return;
		const queue = this.engine.queue(3);
		const names = queue.map((r) => r.name).join(", ");
		const more = stats.overdue > queue.length ? ` and ${stats.overdue - queue.length} more` : "";
		new Notice(`Personal CRM: reach out to ${names}${more}.`, 8000);
	}
}
