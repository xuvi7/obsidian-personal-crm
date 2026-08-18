export type PersonStatus =
	| "overdue"
	| "due-soon"
	| "ok"
	| "snoozed"
	| "paused"
	| "untracked";

export interface Tier {
	/** Stable key written into `prm-tier`. */
	id: string;
	label: string;
	cadenceDays: number;
	color: string;
}

/** Where a person's cadence baseline came from, when they've never been contacted. */
export type BaselineSource = "contact" | "created" | "filesystem" | "none";

/**
 * An unfinished commitment involving a person — "send Sam the climbing list".
 *
 * Only the location is indexed, never the text: the index reads nothing but
 * Obsidian's metadata cache, and pulling task text would mean reading file
 * contents for the whole vault on every rebuild. Text is read on demand, from
 * the few files that actually hold loops.
 */
export interface LoopRef {
	/** Note the task lives in. */
	path: string;
	/** 0-based line of the task, for opening the note at the right place. */
	line: number;
	/** Offset of the task's list item, for a positional completion write. */
	offset: number;
	/** True when the task sits in the person's own note rather than linking to them. */
	own: boolean;
}

export interface PersonRecord {
	path: string;
	name: string;
	aliases: string[];

	// --- from frontmatter ---
	tierId: string | null;
	/** True when `prm-tier` names a tier that no longer exists in settings. */
	tierMissing: boolean;
	cadenceOverride: number | null;
	paused: boolean;
	ignoreJournal: boolean;
	snoozeUntil: string | null;
	birthday: string | null;
	relationship: string | null;
	/** Where they are, for reconnecting when you're in the same place. */
	location: string | null;
	createdDate: string | null;
	/** Frontmatter tags used as groups, without '#' and without the marker tags. */
	tags: string[];

	// --- derived ---
	/** Distinct dates on which an interaction was recorded, newest first. */
	contactDates: string[];
	/** Journal note paths keyed by date, for jumping to the entry. */
	sources: Map<string, string>;
	/** Most recent interaction date, or null if never. */
	lastContact: string | null;
	/** Number of distinct days a journal mentioned them. */
	mentionCount: number;
	/** Resolved cadence in days (tier or override), null when untracked. */
	cadenceDays: number | null;
	/** lastContact + cadence, null when untracked. */
	dueDate: string | null;
	/** Positive = overdue by N days. Negative = N days of slack left. */
	overdueDays: number;
	/** 0..1 progress through the current cadence window. */
	cadenceProgress: number;
	status: PersonStatus;
	baselineSource: BaselineSource;
	/** Days until next birthday, null when no birthday recorded. */
	daysUntilBirthday: number | null;
	/** Unfinished commitments involving them, in vault order. */
	openLoops: LoopRef[];
}

export interface PrmStats {
	overdue: number;
	dueSoon: number;
	tracked: number;
	untracked: number;
	paused: number;
	snoozed: number;
	total: number;
	unknownTier: number;
}

/**
 * Counts that let the UI explain an empty dashboard instead of implying the user
 * simply has no one to contact.
 */
export interface PrmDiagnostics {
	/** False until the first index build completes. */
	built: boolean;
	personFilesFound: number;
	personFilesSkipped: number;
	journalFilesScanned: number;
	journalFilesDated: number;
	interactionsFound: number;
	/** Open tasks attached to somebody, across the whole vault. */
	openLoopsFound: number;
	missingFolders: string[];
	buildMs: number;
}
