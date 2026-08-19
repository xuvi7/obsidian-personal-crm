import {
	App,
	CachedMetadata,
	TFile,
	TFolder,
	getAllTags,
	getLinkpath,
} from "obsidian";
import { FRONTMATTER_KEYS, PrmSettings, tierById } from "./settings";
import type {
	BaselineSource,
	PersonRecord,
	PersonStatus,
	PrmDiagnostics,
	PrmStats,
} from "./types";
import {
	addDays,
	coerceISODate,
	dayNumber,
	daysUntilAnniversary,
	diffDays,
	isISODate,
	todayISO,
} from "./dates";
import { isInFolder, parseJournalDate } from "./journal";
import { asText, dedupeTags, frontmatterOf, readTagList } from "./frontmatter";

interface Range {
	start: number;
	end: number;
}

/**
 * Builds and holds the people index.
 *
 * Everything comes from Obsidian's metadata cache — frontmatter, links and
 * section positions — so a rebuild never reads a file from disk and stays cheap
 * enough to run on every metadata change.
 */
export class PrmEngine {
	private index = new Map<string, PersonRecord>();
	private notesByDate = new Map<string, TFile[]>();
	/** Exclusion fragments, tokenized once per rebuild rather than per file. */
	private exclusionTokens: string[][] = [];
	/** Lowercased marker tags, so group tags can be told from identification ones. */
	private markerTagSet = new Set<string>();
	/** `prm-location` plus the configured fallbacks, in lookup order. */
	private locationKeys: string[] = [];
	private listeners = new Set<() => void>();
	private diag: PrmDiagnostics = emptyDiagnostics();

	constructor(
		private app: App,
		private settings: PrmSettings,
	) {}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	all(): PersonRecord[] {
		return Array.from(this.index.values());
	}

	get(path: string): PersonRecord | null {
		return this.index.get(path) ?? null;
	}

	isPersonFile(file: TFile | null): boolean {
		return !!file && this.index.has(file.path);
	}

	/**
	 * Could a change to this file alter the index?
	 *
	 * `metadataCache.on("changed")` fires for every note in the vault, so without
	 * this an edit to an unrelated note costs a full re-scan. Checked cheaply:
	 * already-indexed, inside a configured folder, or newly carrying a person
	 * tag/type marker.
	 */
	affectsIndex(file: TFile): boolean {
		if (this.index.has(file.path)) return true;

		for (const folder of this.settings.personFolders) {
			if (isInFolder(file.path, folder)) return true;
		}
		for (const source of this.settings.journalSources) {
			if (isInFolder(file.path, source.folder)) return true;
		}

		// A note can become a person by gaining a tag or type marker.
		if (this.settings.personTags.length > 0 || this.settings.personTypeKey.length > 0) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (this.hasPersonTag(cache) || this.hasPersonType(cache)) return true;
		}

		return false;
	}

	diagnostics(): PrmDiagnostics {
		return this.diag;
	}

	/**
	 * A note for the given date, preferring one whose title is exactly the date so
	 * a log line can link it by name.
	 */
	noteForDate(date: string): TFile | null {
		const candidates = this.notesByDate.get(date);
		if (!candidates || candidates.length === 0) return null;
		return candidates.find((f) => f.basename === date) ?? candidates[0];
	}

	/**
	 * The date a note represents, if it's in a journal source at all.
	 *
	 * Public because writing into today's note needs the same date reading the index
	 * does — two answers to "is this today's journal?" would drift apart.
	 */
	dateOfJournalNote(file: TFile): string | null {
		const inJournal = this.settings.journalSources.some(
			(s) => isInFolder(file.path, s.folder),
		);
		if (!inJournal) return null;
		return this.dateForNote(file, this.app.metadataCache.getFileCache(file));
	}

	/** True when a note titled exactly `date` exists — safe to link as [[date]]. */
	hasNoteTitledDate(date: string): boolean {
		return (this.notesByDate.get(date) ?? []).some((f) => f.basename === date);
	}

	rebuild(): void {
		const started = performance.now();
		const today = todayISO();
		const diag = emptyDiagnostics();

		this.exclusionTokens = this.settings.personExclusions
			.map((fragment) => nameTokens(fragment))
			.filter((tokens) => tokens.length > 0);

		// Built once per rebuild, not once per person.
		this.locationKeys = [FRONTMATTER_KEYS.location, ...this.settings.locationKeys];

		this.markerTagSet = new Set<string>();
		for (const tag of [...this.settings.markerTags, ...this.settings.personTags]) {
			const clean = tag.trim().replace(/^#/, "").toLowerCase();
			if (clean.length > 0) this.markerTagSet.add(clean);
		}

		const people = new Map<string, PersonRecord>();
		let skipped = 0;

		// An empty journal folder means the vault root — `isInFolder` documents that,
		// and core Daily Notes leaves the folder empty when the user never moved it.
		// Guarding these call sites with `folder.length > 0` inverted that: a root
		// daily-notes vault matched *nothing*, so contact history was silently and
		// completely disabled, with no diagnostic (missingFolders skips "" too).
		const files = this.app.vault.getMarkdownFiles();
		const journalCandidates: TFile[] = [];
		// Files holding open tasks, gathered here because this pass already has each
		// file's cache in hand; resolving them to people needs the finished index.
		const taskFiles: TaskFile[] = [];
		const trackLoops = this.settings.trackOpenLoops;
		// Only while the nudge is on: turn it off and the blocks it already wrote
		// become ordinary follow-ups, which is what they then are.
		const nudgeHeading = this.settings.dailyNudge
			? this.settings.dailyNudgeHeading.trim().toLowerCase() || null
			: null;

		// One pass, classifying each file once.
		for (const file of files) {
			const inJournal = this.settings.journalSources.some(
				(s) => isInFolder(file.path, s.folder),
			);
			if (inJournal) journalCandidates.push(file);

			const cache = this.app.metadataCache.getFileCache(file);
			const personVerdict = this.personVerdict(file, cache);
			if (personVerdict === "person") {
				people.set(file.path, this.baseRecord(file, cache));
			} else if (personVerdict === "skipped") {
				skipped++;
			}

			if (trackLoops && cache?.listItems && cache.listItems.length > 0) {
				const tasks = openTasks(cache, nudgeHeading);
				if (tasks.length > 0) taskFiles.push({ file, cache, tasks });
			}
		}

		diag.personFilesFound = people.size;
		diag.personFilesSkipped = skipped;
		diag.journalFilesScanned = journalCandidates.length;

		this.notesByDate = new Map();
		const countMentions = this.settings.journalMentionsCountAsContact;
		// One map for both passes: contact attribution and follow-ups resolve links
		// the same way, and building it twice is pure duplication.
		const needsLinks = countMentions || (trackLoops && taskFiles.length > 0);
		const linkMap = needsLinks && people.size > 0 ? buildPersonLinkMap(people) : null;

		for (const file of journalCandidates) {
			const cache = this.app.metadataCache.getFileCache(file);
			const date = this.dateForNote(file, cache);
			if (!date) continue;

			diag.journalFilesDated++;
			const bucket = this.notesByDate.get(date);
			if (bucket) bucket.push(file);
			else this.notesByDate.set(date, [file]);

			if (!countMentions || people.size === 0 || !cache || !linkMap) continue;
			diag.interactionsFound += this.attributeLinks(file, cache, date, people, linkMap);
		}

		if (trackLoops && taskFiles.length > 0 && linkMap) {
			diag.openLoopsFound = this.attachOpenLoops(taskFiles, people, linkMap);
		}

		for (const record of people.values()) this.finalize(record, today);

		diag.missingFolders = this.missingFolders();
		diag.buildMs = performance.now() - started;
		diag.built = true;

		this.index = people;
		this.diag = diag;
		for (const cb of this.listeners) cb();
	}

	stats(): PrmStats {
		const s: PrmStats = {
			overdue: 0,
			dueSoon: 0,
			tracked: 0,
			untracked: 0,
			paused: 0,
			snoozed: 0,
			total: this.index.size,
			unknownTier: 0,
		};
		for (const r of this.index.values()) {
			if (r.tierMissing) s.unknownTier++;
			switch (r.status) {
				case "overdue":
					s.overdue++;
					s.tracked++;
					break;
				case "due-soon":
					s.dueSoon++;
					s.tracked++;
					break;
				case "ok":
					s.tracked++;
					break;
				case "snoozed":
					s.snoozed++;
					s.tracked++;
					break;
				case "paused":
					s.paused++;
					break;
				case "untracked":
					s.untracked++;
					break;
			}
		}
		return s;
	}

	/** Overdue people, most overdue first — the reach-out queue. */
	queue(limit?: number): PersonRecord[] {
		const due = this.all()
			.filter((r) => r.status === "overdue")
			.sort((a, b) => b.overdueDays - a.overdueDays || a.name.localeCompare(b.name));
		return limit === undefined ? due : due.slice(0, limit);
	}

	// ---------------------------------------------------------------- internals

	private missingFolders(): string[] {
		const out: string[] = [];
		const check = (folder: string) => {
			if (folder.length === 0) return;
			const f = this.app.vault.getAbstractFileByPath(folder);
			if (!(f instanceof TFolder)) out.push(folder);
		};
		for (const folder of this.settings.personFolders) check(folder);
		for (const source of this.settings.journalSources) check(source.folder);
		return out;
	}

	private personVerdict(
		file: TFile,
		cache: CachedMetadata | null,
	): "person" | "skipped" | "unrelated" {
		const inFolder = this.settings.personFolders.some(
			(f) => f.length > 0 && isInFolder(file.path, f),
		);

		// Only ask about tags and markers when the answer can still change the
		// outcome: a file already inside a people folder is claimed either way.
		if (!inFolder) {
			if (!this.hasPersonTag(cache) && !this.hasPersonType(cache)) return "unrelated";
		} else if (this.settings.requireTagOrType) {
			if (!this.hasPersonTag(cache) && !this.hasPersonType(cache)) return "skipped";
		}
		if (this.isNotAPerson(file, cache)) return "skipped";
		return "person";
	}

	private hasPersonTag(cache: CachedMetadata | null): boolean {
		const wanted = this.settings.personTags;
		if (wanted.length === 0 || !cache) return false;
		const tags = getAllTags(cache) ?? [];
		for (const raw of tags) {
			const tag = raw.replace(/^#/, "").toLowerCase();
			for (const w of wanted) {
				const want = w.replace(/^#/, "").toLowerCase();
				// Prefix match so `person` also claims `person/work/team`.
				if (tag === want || tag.startsWith(`${want}/`)) return true;
			}
		}
		return false;
	}

	private hasPersonType(cache: CachedMetadata | null): boolean {
		const key = this.settings.personTypeKey;
		if (key.length === 0) return false;
		const raw = frontmatterOf(cache)[key];
		if (raw == null) return false;
		const want = this.settings.personTypeValue.toLowerCase();
		if (want.length === 0) return true;
		const values = Array.isArray(raw) ? raw : [raw];
		return values.some((v) => String(v).trim().toLowerCase() === want);
	}

	/**
	 * Drawings, templates and index notes end up in people folders. They aren't
	 * relationships, so keep them out of the queue.
	 */
	private isNotAPerson(file: TFile, cache: CachedMetadata | null): boolean {
		if (/\.excalidraw$/i.test(file.basename)) return true;

		const fm = frontmatterOf(cache);
		if (fm["excalidraw-plugin"] !== undefined) return true;

		const tags = cache ? (getAllTags(cache) ?? []) : [];
		if (tags.some((t) => t.toLowerCase() === "#excalidraw")) return true;

		if (this.exclusionTokens.length > 0 && matchesExclusion(file.basename, this.exclusionTokens)) {
			return true;
		}

		// An unrendered template placeholder means this is a template, not a person.
		for (const value of Object.values(fm)) {
			// includes() first: the regex is far more expensive and almost never matches.
			if (typeof value === "string" && value.includes("{{") && /\{\{.+\}\}/.test(value)) {
				return true;
			}
		}
		return false;
	}

	private dateForNote(file: TFile, cache: CachedMetadata | null): string | null {
		const source = this.settings.journalSources.find(
			(s) => isInFolder(file.path, s.folder),
		);
		const fromName = parseJournalDate(
			file.basename,
			source?.format,
			this.settings.allowFallbackDateFormats,
		);
		if (fromName) return fromName;

		// Note-per-meeting workflows date the note in frontmatter instead.
		const key = this.settings.journalDateKey;
		if (key.length > 0) {
			return coerceISODate(frontmatterOf(cache)[key]);
		}
		return null;
	}

	/**
	 * The person a link points at, or null.
	 *
	 * A hash lookup against the map built from the index, falling back to Obsidian
	 * only where the map cannot answer: a name two people share, and the relative or
	 * extension-bearing targets that markdown-style links produce.
	 */
	private resolvePersonLink(
		rawLink: string,
		fromPath: string,
		linkMap: PersonLinkMap,
	): string | null {
		const linkpath = getLinkpath(rawLink);
		const key = normalizeLinkKey(linkpath);

		if (linkMap.ambiguous.has(key)) {
			// Two people share this name; only Obsidian knows which is nearer.
			return this.app.metadataCache.getFirstLinkpathDest(linkpath, fromPath)?.path ?? null;
		}

		const hit = linkMap.byName.get(key);
		if (hit) return hit;

		// A markdown link percent-encodes spaces, so `People/Bob%20Smith.md` never
		// matches a key built from the real path.
		if (key.includes("%")) {
			try {
				const decoded = linkMap.byName.get(normalizeLinkKey(decodeURIComponent(linkpath)));
				if (decoded) return decoded;
			} catch {
				// Malformed escape: fall through to real resolution.
			}
		}

		if (!needsRealResolution(linkpath)) return null;
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, fromPath)?.path ?? null;
		// Only report it if it is someone we index; the map is the authority on that.
		return dest !== null && linkMap.byPath.has(dest) ? dest : null;
	}

	/**
	 * Attribute a dated note's links to people.
	 *
	 * Uses `cache.links` rather than `resolvedLinks` so each link's position is
	 * known. That's what lets us skip mentions that record an *intention* —
	 * "- [ ] reach out to [[X]]" — which would otherwise mark X as contacted and
	 * silence the very reminder that prompted it. Embeds are excluded for the same
	 * reason: a template that transcludes a person isn't contact.
	 */
	private attributeLinks(
		file: TFile,
		cache: CachedMetadata,
		date: string,
		people: Map<string, PersonRecord>,
		linkMap: PersonLinkMap,
	): number {
		const links = cache.links;
		if (!links || links.length === 0) return 0;

		const filtering = this.settings.ignoreIntentLinks;
		const excluded = filtering ? excludedRanges(cache) : [];
		let added = 0;

		for (const link of links) {
			const offset = link.position?.start?.offset;
			if (filtering && typeof offset === "number" && inAnyRange(offset, excluded)) {
				continue;
			}

			const targetPath = this.resolvePersonLink(link.link, file.path, linkMap);
			if (!targetPath) continue;

			const record = people.get(targetPath);
			if (!record || record.ignoreJournal) continue;

			// First journal wins, but a journal always beats a date harvested from the
			// person's own note: clicking the date should open the day, not the log
			// line you clicked from.
			const existing = record.sources.get(date);
			if (existing === undefined || existing === record.path) {
				record.sources.set(date, file.path);
			}
			added++;
		}

		return added;
	}

	/**
	 * Attach open tasks to the people they concern.
	 *
	 * Two sources, because both are how people actually write a commitment down:
	 * a task in someone's own note is about them without needing to name them, and
	 * a task anywhere else is about whoever it links to.
	 */
	private attachOpenLoops(
		taskFiles: TaskFile[],
		people: Map<string, PersonRecord>,
		linkMap: PersonLinkMap,
	): number {
		let found = 0;

		// Cheap membership check so the same task can't be attached twice — once for
		// living in a person's note and again for linking to them.
		const seen = new Set<string>();
		const add = (record: PersonRecord, path: string, line: number, offset: number, own: boolean) => {
			const key = `${record.path}\u0000${path}\u0000${offset}`;
			if (seen.has(key)) return;
			seen.add(key);
			record.openLoops.push({ path, line, offset, own });
			found++;
		};

		for (const { file, cache, tasks } of taskFiles) {
			const owner = people.get(file.path);
			if (owner) {
				for (const task of tasks) {
					add(owner, file.path, task.line, task.start, true);
				}
			}

			const links = cache.links;
			if (!links || links.length === 0) continue;

			// Both lists are in document order, so walk them together rather than
			// searching the task list once per link.
			let ti = 0;
			for (const link of links) {
				const offset = link.position?.start?.offset;
				if (typeof offset !== "number") continue;
				while (ti < tasks.length && tasks[ti].end < offset) ti++;
				if (ti >= tasks.length) break;
				const task = tasks[ti];
				if (offset < task.start) continue;

				const targetPath = this.resolvePersonLink(link.link, file.path, linkMap);
				if (!targetPath) continue;

				const record = people.get(targetPath);
				if (!record) continue;
				add(record, file.path, task.line, task.start, targetPath === file.path);
			}
		}

		return found;
	}

	private baseRecord(file: TFile, cache: CachedMetadata | null): PersonRecord {
		const fm = frontmatterOf(cache);
		const K = FRONTMATTER_KEYS;

		// Bounded, not just positive: a cadence of 1e11 overflowed addDays to an
		// Invalid Date, which formatted as the string "NaN-NaN-NaN" and then read back
		// as overdue. A century is past any real cadence.
		const rawCadence = Number(asText(fm[K.cadence]));
		const cadenceOverride =
			Number.isFinite(rawCadence) && rawCadence >= 1 && rawCadence <= MAX_CADENCE_DAYS
				? Math.round(rawCadence)
				: null;

		// `coerceISODate` first, so the link-wrapped and compact forms that Dataview
		// and Templater setups produce give a countdown like every other date field.
		// A bare `MM-DD` isn't a full date, so it falls through to the raw text.
		const birthdayText = asText(fm[K.birthday])?.trim();
		const birthday =
			coerceISODate(fm[K.birthday]) ??
			(birthdayText && birthdayText.length > 0 ? birthdayText : null);

		let createdDate: string | null = null;
		let baselineSource: BaselineSource = "none";
		for (const key of this.settings.createdDateKeys) {
			const candidate = coerceISODate(fm[key]);
			if (candidate) {
				createdDate = candidate;
				baselineSource = "created";
				break;
			}
		}
		if (!createdDate) {
			createdDate = coerceISODate(new Date(file.stat.ctime));
			baselineSource = createdDate ? "filesystem" : "none";
		}

		const record: PersonRecord = {
			path: file.path,
			name: file.basename,
			aliases: normalizeAliases(fm["aliases"] ?? fm["alias"]),
			tags: this.groupTags(fm),

			tierId: typeof fm[K.tier] === "string" ? (fm[K.tier] as string).trim() : null,
			tierMissing: false,
			cadenceOverride,
			paused: fm[K.paused] === true,
			ignoreJournal: fm[K.ignoreJournal] === true,
			snoozeUntil: coerceISODate(fm[K.snoozeUntil]),
			birthday,
			relationship:
				typeof fm[K.relationship] === "string" ? (fm[K.relationship] as string) : null,
			location: this.readLocation(fm),
			createdDate,

			contactDates: [],
			sources: new Map(),
			lastContact: null,
			mentionCount: 0,
			cadenceDays: null,
			dueDate: null,
			overdueDays: 0,
			cadenceProgress: 0,
			status: "untracked",
			baselineSource,
			daysUntilBirthday: null,
			typicalGapDays: null,
			drifting: false,
			openLoops: [],
		};

		const logged = coerceISODate(fm[K.lastContacted]);
		if (logged) record.sources.set(logged, file.path);

		// prm-last-contacted holds one date, so on its own it leaves no history.
		if (this.settings.countPersonNoteDateLinks && !record.ignoreJournal) {
			this.harvestDateLinks(file, cache, record);
		}

		return record;
	}

	/**
	 * Interaction dates written in a person's own note as links to a dated note.
	 *
	 * A log line's `- [[2026-07-04]] — coffee` and a sentence like "a deep
	 * conversation on [[2026-01-24]]" both record that something happened that day,
	 * so both count. This is where a manually logged history comes from: the
	 * frontmatter keeps only the latest date, while the links keep all of them.
	 *
	 * Read from `cache.links`, so it costs no file reads — and unresolved links are
	 * in there too, which is what makes logs written on days with no note readable.
	 */
	private harvestDateLinks(
		file: TFile,
		cache: CachedMetadata | null,
		record: PersonRecord,
	): void {
		const links = cache?.links;
		if (!cache || !links || links.length === 0) return;

		// The same positional rules as a journal: an open task or a quotation
		// records an intention or someone else's words, not an interaction.
		const excluded = this.settings.ignoreIntentLinks ? excludedRanges(cache) : [];
		for (const link of links) {
			const offset = link.position?.start?.offset;
			if (excluded.length > 0 && typeof offset === "number" && inAnyRange(offset, excluded)) {
				continue;
			}
			const date = this.dateOfLinkTarget(link.link);
			if (date !== null && !record.sources.has(date)) record.sources.set(date, file.path);
		}
	}

	/** The date a link target names, if it names one. */
	private dateOfLinkTarget(target: string): string | null {
		const linkpath = getLinkpath(target);
		const basename = linkpath.slice(linkpath.lastIndexOf("/") + 1);
		// No digits, no date — and most links in a person's note are to other people.
		if (!/\d/.test(basename)) return null;

		for (const source of this.settings.journalSources) {
			const hit = parseJournalDate(basename, source.format, false);
			if (hit !== null) return hit;
		}
		// No configured format matched. A bare ISO name is still unambiguous, so
		// read it when the vault allows more than one convention.
		return this.settings.allowFallbackDateFormats
			? parseJournalDate(basename, undefined, true)
			: null;
	}

	/**
	 * The note's frontmatter tags, minus the ones that only say "this is a person".
	 * Sorted so the dashboard and the tag sort are stable.
	 */
	/**
	 * Where someone is, from `prm-location` or whichever key the vault already
	 * uses. A list can hold several places; the first is the one shown.
	 */
	private readLocation(fm: Record<string, unknown>): string | null {
		for (const key of this.locationKeys) {
			const raw = fm[key];
			// Array.isArray narrows to any[]; keep the element unknown so asText
			// stays the only thing deciding what a frontmatter value may become.
			const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
			const text = asText(value)?.trim();
			if (text !== undefined && text.length > 0) return text;
		}
		return null;
	}

	/**
	 * Distinct locations with how many people are in each, most-used first.
	 *
	 * Spellings aren't canonicalised — "NYC" and "New York" are different places
	 * here — so this reports what the vault actually says, and the first spelling
	 * seen wins for display.
	 */
	allLocations(): { place: string; count: number }[] {
		const counts = new Map<string, { place: string; count: number }>();
		for (const record of this.index.values()) {
			if (!record.location) continue;
			const key = record.location.toLowerCase();
			const seen = counts.get(key);
			if (seen) seen.count++;
			else counts.set(key, { place: record.location, count: 1 });
		}
		return [...counts.values()].sort(
			(a, b) => b.count - a.count || a.place.localeCompare(b.place),
		);
	}

	private groupTags(fm: Record<string, unknown>): string[] {
		const raw = readTagList(fm["tags"] ?? fm["tag"]);
		if (raw.length === 0) return [];
		const kept = raw.filter((tag) => !this.markerTagSet.has(tag.toLowerCase()));
		return dedupeTags(kept).sort((a, b) => a.localeCompare(b));
	}

	/** Every group tag in use, for pickers and filters. */
	allTags(): string[] {
		const counts = new Map<string, number>();
		for (const record of this.index.values()) {
			for (const tag of record.tags) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return Array.from(counts.keys()).sort((a, b) => {
			const byUse = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
			return byUse !== 0 ? byUse : a.localeCompare(b);
		});
	}

	private finalize(record: PersonRecord, today: string): void {
		// One entry per date, so two notes on the same day aren't two interactions.
		record.mentionCount = record.sources.size;
		record.contactDates = Array.from(record.sources.keys()).sort().reverse();
		// Not the newest date — the newest date that has actually happened. A dinner
		// booked for next January is a real link in a real note, and taking it as last
		// contact reset the cadence clock forward and dropped the person out of the
		// queue until then.
		record.lastContact = record.contactDates.find((d) => d <= today) ?? null;
		if (record.lastContact) record.baselineSource = "contact";

		if (record.birthday) {
			record.daysUntilBirthday = daysUntilAnniversary(record.birthday, today);
		}

		record.typicalGapDays = typicalGap(record.contactDates);
		record.drifting = isDrifting(record, today);

		const tier = tierById(this.settings, record.tierId);
		record.tierMissing = record.tierId !== null && tier === null;
		const cadence = record.cadenceOverride ?? tier?.cadenceDays ?? null;
		record.cadenceDays = cadence;

		if (record.paused) {
			record.status = "paused";
			return;
		}
		if (cadence === null || cadence < 1) {
			record.status = "untracked";
			return;
		}

		// Never contacted? Measure from when the note appeared, so someone added
		// last week isn't reported as years overdue.
		const baseline = record.lastContact ?? record.createdDate ?? today;
		if (!isISODate(baseline)) {
			record.status = "untracked";
			return;
		}

		record.dueDate = addDays(baseline, cadence);
		const overdue = diffDays(today, record.dueDate);
		record.overdueDays = Number.isFinite(overdue) ? overdue : 0;

		const elapsed = diffDays(today, baseline);
		record.cadenceProgress = Number.isFinite(elapsed)
			? Math.max(0, Math.min(1, elapsed / cadence))
			: 0;

		record.status = deriveStatus(record, today, this.settings.dueSoonWindowDays);
	}
}

/** Split a title into word tokens, so matching can't cut across word boundaries. */
function nameTokens(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
}

/**
 * Does an exclusion fragment appear in this title as whole words?
 *
 * Substring matching looked equivalent and was not: "MOC" is inside "Mochizuki"
 * and "index" is inside "Indexa", so real people were being silently dropped from
 * the index with no explanation. A fragment of several words has to appear as a
 * consecutive run of tokens.
 *
 * Fragments arrive already tokenized — re-splitting them for every file in the
 * vault made the cost scale with files x fragments for no reason.
 */
function matchesExclusion(basename: string, exclusions: string[][]): boolean {
	const tokens = nameTokens(basename);
	if (tokens.length === 0) return false;

	for (const wanted of exclusions) {
		for (let i = 0; i + wanted.length <= tokens.length; i++) {
			let all = true;
			for (let j = 0; j < wanted.length; j++) {
				if (tokens[i + j] !== wanted[j]) {
					all = false;
					break;
				}
			}
			if (all) return true;
		}
	}
	return false;
}

interface PersonLinkMap {
	byName: Map<string, string>;
	/** Names claimed by more than one person, which need real resolution. */
	ambiguous: Set<string>;
	/** Every indexed person's path, to vet what real resolution comes back with. */
	byPath: Set<string>;
}

function normalizeLinkKey(value: string): string {
	return value.trim().normalize("NFC").toLowerCase();
}

/**
 * Whether a link that missed the map is worth asking Obsidian to resolve.
 *
 * A miss is overwhelmingly a link to something that isn't a person — a topic, a
 * project — and resolving every one of those would add a call per link per dated
 * note. Relative and extension-bearing targets are the shapes the map cannot
 * express, so they are the only ones worth the call.
 */
function needsRealResolution(linkpath: string): boolean {
	return linkpath.includes("/") || /\.md$/i.test(linkpath);
}

/**
 * Every way a person note can be addressed by a wikilink: its title, its aliases,
 * and its full path. Built once per rebuild so attributing links is a hash lookup.
 */
function buildPersonLinkMap(people: Map<string, PersonRecord>): PersonLinkMap {
	const byName = new Map<string, string>();
	const ambiguous = new Set<string>();

	const add = (raw: string, path: string) => {
		const key = normalizeLinkKey(raw);
		if (key.length === 0) return;
		const existing = byName.get(key);
		if (existing === undefined) byName.set(key, path);
		else if (existing !== path) ambiguous.add(key);
	};

	for (const [path, record] of people) {
		add(record.name, path);
		add(path.replace(/\.md$/i, ""), path);
		// Also the forms that carry the extension. A markdown-style link — which is
		// what Obsidian writes with "Use [[Wikilinks]]" off — targets `People/Bob.md`,
		// and `[[Bob.md]]` is legal too. Without these the key never matches and the
		// person's whole contact history reads as empty.
		add(path, path);
		add(record.name + ".md", path);
		for (const alias of record.aliases) add(alias, path);
	}

	return { byName, ambiguous, byPath: new Set(people.keys()) };
}

/**
 * Byte ranges whose links record intent rather than contact: unchecked to-dos,
 * quotes, code blocks, and every embed.
 */
/** An unchecked task's span and line, for attributing and later completing it. */
interface OpenTask {
	start: number;
	end: number;
	line: number;
}

interface TaskFile {
	file: TFile;
	cache: CachedMetadata;
	tasks: OpenTask[];
}

/**
 * Unchecked tasks in a note.
 *
 * The same `task === " "` test excludedRanges uses to *ignore* these when
 * counting contact: an open task records an intention, which is exactly what
 * makes it an open loop.
 *
 * `skipHeading` drops the section the daily reach-out block is written under.
 * Those lines are generated from who's already overdue, so counting them as
 * follow-ups would restate the Due tab and pile up a fresh copy every day.
 */
function openTasks(cache: CachedMetadata, skipHeading: string | null): OpenTask[] {
	const skip = skipHeading === null ? [] : headingSections(cache, skipHeading);
	const out: OpenTask[] = [];
	for (const item of cache.listItems ?? []) {
		if (item.task !== " ") continue;
		const start = item.position.start.offset;
		if (skip.length > 0 && inAnyRange(start, skip)) continue;
		out.push({
			start,
			end: item.position.end.offset,
			line: item.position.start.line,
		});
	}
	return out;
}

/**
 * Spans covering every section named `heading`, from the heading to the next
 * heading of any level.
 */
function headingSections(cache: CachedMetadata, heading: string): Range[] {
	const headings = cache.headings;
	if (!headings || headings.length === 0) return [];

	// `heading` arrives trimmed and lowercased. Most headings can't match, so rule
	// them out on length before allocating a lowercased copy of each one.
	const out: Range[] = [];
	for (let i = 0; i < headings.length; i++) {
		const raw = headings[i].heading;
		if (raw.length < heading.length) continue;
		if (raw.trim().toLowerCase() !== heading) continue;
		const start = headings[i].position.start.offset;
		const end = headings[i + 1]?.position.start.offset ?? Number.MAX_SAFE_INTEGER;
		out.push({ start, end });
	}
	return out;
}

function excludedRanges(cache: CachedMetadata): Range[] {
	const ranges: Range[] = [];

	for (const section of cache.sections ?? []) {
		if (section.type === "code" || section.type === "blockquote") {
			ranges.push({
				start: section.position.start.offset,
				end: section.position.end.offset,
			});
		}
	}

	for (const item of cache.listItems ?? []) {
		// `task` is undefined for plain bullets, " " for unchecked, "x" for done.
		// A completed task ("- [x] called Ann") is real contact; an open one isn't.
		if (item.task === " ") {
			ranges.push({
				start: item.position.start.offset,
				end: item.position.end.offset,
			});
		}
	}

	for (const embed of cache.embeds ?? []) {
		ranges.push({
			start: embed.position.start.offset,
			end: embed.position.end.offset,
		});
	}

	return ranges.sort((a, b) => a.start - b.start);
}

function inAnyRange(offset: number, ranges: Range[]): boolean {
	for (const range of ranges) {
		if (offset < range.start) return false;
		if (offset <= range.end) return true;
	}
	return false;
}

/** Any real cadence is well under this; beyond it, date arithmetic overflows. */
const MAX_CADENCE_DAYS = 36_500;

/** A rhythm needs at least this many gaps before a median says anything. */
const MIN_GAPS = 3;

/** A median rather than a mean, so one long silence can't redefine the rhythm. */
function medianOf(gaps: number[]): number | null {
	if (gaps.length === 0) return null;
	const sorted = [...gaps].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
	return median > 0 ? median : null;
}

/**
 * How much time the measured gaps must cover.
 *
 * Without this, a week of daily journal mentions — a trip, a course, a stretch of
 * sitting next to someone — reads as a "one-day rhythm", and then any normal
 * silence looks like a collapse. Three weeks is enough to tell a rhythm from a
 * burst.
 */
const MIN_SPAN_DAYS = 21;

/** Ceiling on the walk, so a decade of daily contact stays cheap to measure. */
const MAX_GAPS = 30;

/** Quiet for longer than this much of their rhythm starts to look like drift. */
const DRIFT_MIN_MULTIPLE = 2;
/** …but never sooner than this, so a daily rhythm needs a fortnight of silence. */
const DRIFT_MIN_DAYS = 14;
/** Past this much, the pattern has ended rather than thinned. */
const DRIFT_MAX_MULTIPLE = 12;
/** …and never sooner than this, so a daily rhythm still gets three months of grace. */
const DRIFT_MAX_DAYS = 90;

/**
 * The median gap between recent interactions, in days.
 *
 * The window grows from the most recent interaction until it holds enough gaps
 * *and* covers enough time, which keeps it short for people you see often and
 * long for people you don't — rather than a fixed count that means something
 * different for each. A median rather than a mean, so one three-year silence in
 * an otherwise weekly friendship doesn't redefine the friendship.
 */
export function typicalGap(contactDates: string[]): number | null {
	if (contactDates.length < MIN_GAPS + 1) return null;

	// contactDates is newest-first, so consecutive pairs are the recent gaps. Each
	// date is converted once and reused as the next pair's other end, rather than
	// being parsed again by a second diffDays call.
	const gaps: number[] = [];
	let previous = dayNumber(contactDates[0]);
	let rhythm: number | null = null;

	for (let i = 1; i < contactDates.length && gaps.length < MAX_GAPS; i++) {
		const current = dayNumber(contactDates[i]);
		if (current === null) continue;
		if (previous !== null) {
			const gap = previous - current;
			if (gap > 0) gaps.push(gap);
		}
		previous = current;

		if (gaps.length < MIN_GAPS) continue;

		// Stop when the rhythm *itself* accounts for enough time: the median gap,
		// repeated across the window, must span at least three weeks.
		//
		// Summing the raw gaps instead let the one long gap that closes the window
		// satisfy the requirement single-handed — three daily mentions plus a contact a
		// month earlier gave [1, 1, 31], which passed on a span of 33 and reported
		// "usually every 1d". That is the burst this test exists to reject. Measured
		// this way it needs 21 one-day gaps, i.e. three actual weeks of daily contact.
		const candidate = medianOf(gaps);
		if (candidate !== null && candidate * gaps.length >= MIN_SPAN_DAYS) {
			rhythm = candidate;
			break;
		}
	}

	return rhythm;
}

/**
 * Whether the current silence is unusual *for this person*.
 *
 * Drift is a band, not a threshold: quiet for longer than usual, but not so much
 * longer that the pattern has plainly ended.
 *
 * The lower edge's `+ 14` floor stops a daily correspondent being flagged after
 * three quiet days — doubling a one-day rhythm is not yet a drifting friendship.
 *
 * The upper edge exists because intensity is often situational: an internship, a
 * course, a season of sitting next to someone. When that context ends the contact
 * stops rather than thins, and measured without a ceiling, three months of daily
 * contact followed by six months of silence reads as "usually every day, 180 days
 * late" — forever. A silence of 180× the rhythm isn't a friendship you can catch by
 * being reminded; it's one whose situation is over, and the cadence you assigned is
 * the right tool for deciding whether to restart it. Drift is the recoverable middle.
 */
function isDrifting(record: PersonRecord, today: string): boolean {
	const rhythm = record.typicalGapDays;
	if (rhythm === null || record.lastContact === null) return false;
	if (record.paused) return false;

	const silence = diffDays(today, record.lastContact);
	if (!Number.isFinite(silence) || silence <= 0) return false;

	const floor = Math.max(rhythm * DRIFT_MIN_MULTIPLE, rhythm + DRIFT_MIN_DAYS);
	const ceiling = Math.max(rhythm * DRIFT_MAX_MULTIPLE, rhythm + DRIFT_MAX_DAYS);
	return silence > floor && silence <= ceiling;
}

function deriveStatus(
	record: PersonRecord,
	today: string,
	dueSoonWindow: number,
): PersonStatus {
	if (record.snoozeUntil && isISODate(record.snoozeUntil) && record.snoozeUntil >= today) {
		return "snoozed";
	}
	if (record.overdueDays >= 0) return "overdue";
	if (record.overdueDays >= -dueSoonWindow) return "due-soon";
	return "ok";
}

function normalizeAliases(value: unknown): string[] {
	if (value == null) return [];
	if (Array.isArray(value)) {
		return value
			.map((v) => asText(v))
			.filter((v): v is string => v !== null && v.length > 0);
	}
	const s = asText(value)?.trim();
	return s !== undefined && s.length > 0 ? [s] : [];
}

function emptyDiagnostics(): PrmDiagnostics {
	return {
		built: false,
		personFilesFound: 0,
		personFilesSkipped: 0,
		journalFilesScanned: 0,
		journalFilesDated: 0,
		interactionsFound: 0,
		openLoopsFound: 0,
		missingFolders: [],
		buildMs: 0,
	};
}
