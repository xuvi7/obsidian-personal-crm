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
	daysUntilAnniversary,
	diffDays,
	isISODate,
	todayISO,
} from "./dates";
import { isInFolder, parseJournalDate } from "./journal";
import { asText, frontmatterOf } from "./frontmatter";

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
			if (folder.length > 0 && isInFolder(file.path, folder)) return true;
		}
		for (const source of this.settings.journalSources) {
			if (source.folder.length > 0 && isInFolder(file.path, source.folder)) return true;
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

		const people = new Map<string, PersonRecord>();
		let skipped = 0;

		const files = this.app.vault.getMarkdownFiles();
		const journalCandidates: TFile[] = [];

		// One pass, classifying each file once.
		for (const file of files) {
			const inJournal = this.settings.journalSources.some(
				(s) => s.folder.length > 0 && isInFolder(file.path, s.folder),
			);
			if (inJournal) journalCandidates.push(file);

			const cache = this.app.metadataCache.getFileCache(file);
			const personVerdict = this.personVerdict(file, cache);
			if (personVerdict === "person") {
				people.set(file.path, this.baseRecord(file, cache));
			} else if (personVerdict === "skipped") {
				skipped++;
			}
		}

		diag.personFilesFound = people.size;
		diag.personFilesSkipped = skipped;
		diag.journalFilesScanned = journalCandidates.length;

		this.notesByDate = new Map();
		const countMentions = this.settings.journalMentionsCountAsContact;
		const linkMap = countMentions ? buildPersonLinkMap(people) : null;

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
			(s) => s.folder.length > 0 && isInFolder(file.path, s.folder),
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

			const linkpath = getLinkpath(link.link);
			const key = normalizeLinkKey(linkpath);

			// Resolve against a map built from the people index: a hash lookup rather
			// than asking Obsidian to resolve every link in every dated note.
			let targetPath = linkMap.byName.get(key);
			if (linkMap.ambiguous.has(key)) {
				// Two people share this name; only Obsidian knows which is nearer.
				targetPath = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path)?.path;
			}
			if (!targetPath) continue;

			const record = people.get(targetPath);
			if (!record || record.ignoreJournal) continue;

			if (!record.sources.has(date)) record.sources.set(date, file.path);
			added++;
		}

		return added;
	}

	private baseRecord(file: TFile, cache: CachedMetadata | null): PersonRecord {
		const fm = frontmatterOf(cache);
		const K = FRONTMATTER_KEYS;

		const rawCadence = Number(fm[K.cadence]);
		const cadenceOverride =
			Number.isFinite(rawCadence) && rawCadence >= 1 ? Math.round(rawCadence) : null;

		const birthdayText = asText(fm[K.birthday])?.trim();
		const birthday = birthdayText && birthdayText.length > 0 ? birthdayText : null;

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

			tierId: typeof fm[K.tier] === "string" ? (fm[K.tier] as string).trim() : null,
			tierMissing: false,
			cadenceOverride,
			paused: fm[K.paused] === true,
			ignoreJournal: fm[K.ignoreJournal] === true,
			snoozeUntil: coerceISODate(fm[K.snoozeUntil]),
			birthday,
			relationship:
				typeof fm[K.relationship] === "string" ? (fm[K.relationship] as string) : null,
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
		};

		const logged = coerceISODate(fm[K.lastContacted]);
		if (logged) record.sources.set(logged, file.path);

		return record;
	}

	private finalize(record: PersonRecord, today: string): void {
		// One entry per date, so two notes on the same day aren't two interactions.
		record.mentionCount = record.sources.size;
		record.contactDates = Array.from(record.sources.keys()).sort().reverse();
		record.lastContact = record.contactDates[0] ?? null;
		if (record.lastContact) record.baselineSource = "contact";

		if (record.birthday) {
			record.daysUntilBirthday = daysUntilAnniversary(record.birthday, today);
		}

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
}

function normalizeLinkKey(value: string): string {
	return value.trim().normalize("NFC").toLowerCase();
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
		for (const alias of record.aliases) add(alias, path);
	}

	return { byName, ambiguous };
}

/**
 * Byte ranges whose links record intent rather than contact: unchecked to-dos,
 * quotes, code blocks, and every embed.
 */
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
		missingFolders: [],
		buildMs: 0,
	};
}
