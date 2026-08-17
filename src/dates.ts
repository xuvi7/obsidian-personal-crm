const MS_PER_DAY = 86_400_000;

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Today in the user's local timezone, as YYYY-MM-DD. */
export function todayISO(): string {
	const d = new Date();
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysInMonth(year: number, month: number): number {
	// Day 0 of the next month is the last day of this one.
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * True only for a real calendar date. Shape alone isn't enough: `2026-13-45`
 * would otherwise sort and compare as a valid date and quietly park someone
 * outside their cadence forever.
 */
export function isISODate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (month < 1 || month > 12 || day < 1) return false;
	return day <= daysInMonth(year, month);
}

/**
 * Anchor a YYYY-MM-DD string at UTC midnight so day arithmetic never drifts
 * across DST boundaries.
 */
function toUTC(iso: string): number | null {
	const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(iso);
	if (!m) return null;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUTC(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Whole days between two ISO dates: `a - b`. NaN if either is unparseable. */
export function diffDays(a: string, b: string): number {
	const ua = toUTC(a);
	const ub = toUTC(b);
	if (ua === null || ub === null) return Number.NaN;
	return Math.round((ua - ub) / MS_PER_DAY);
}

export function addDays(iso: string, days: number): string {
	const u = toUTC(iso);
	if (u === null) return iso;
	return fromUTC(u + days * MS_PER_DAY);
}

/** Largest of the given ISO dates. Lexicographic order works for YYYY-MM-DD. */
export function maxISO(...values: (string | null | undefined)[]): string | null {
	let best: string | null = null;
	for (const v of values) {
		if (v && isISODate(v) && (best === null || v > best)) best = v;
	}
	return best;
}

/**
 * Pull a valid YYYY-MM-DD out of the shapes that actually turn up in
 * frontmatter. Deliberately conservative: ambiguous slash forms like `08/15/2026`
 * are rejected rather than guessed at, because reading them in the wrong order
 * silently shifts someone's whole timeline.
 */
export function coerceISODate(value: unknown): string | null {
	if (value == null) return null;

	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		// The Date came from a UTC-anchored parse, so read it back in UTC.
		const iso = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(
			value.getUTCDate(),
		)}`;
		return isISODate(iso) ? iso : null;
	}

	let s = String(value).trim();
	// Dataview and Templater setups often store dates as links: [[2026-08-15]].
	s = s.replace(/^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/, "$1").trim();

	let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (m) {
		const iso = `${m[1]}-${m[2]}-${m[3]}`;
		return isISODate(iso) ? iso : null;
	}

	m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(s);
	if (m) {
		const iso = `${m[1]}-${m[2]}-${m[3]}`;
		return isISODate(iso) ? iso : null;
	}

	m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
	if (m) {
		const iso = `${m[1]}-${m[2]}-${m[3]}`;
		return isISODate(iso) ? iso : null;
	}

	return null;
}

/** Compact duration for a day count: 4d, 3w, 5mo, 2.1y. */
export function formatDuration(days: number): string {
	if (!Number.isFinite(days)) return "?";
	const d = Math.abs(Math.round(days));
	if (d === 0) return "0d";
	if (d < 14) return `${d}d`;
	if (d < 60) return `${Math.round(d / 7)}w`;
	if (d < 730) return `${Math.round(d / 30)}mo`;
	return `${(d / 365).toFixed(1)}y`;
}

/** Human phrasing relative to today, e.g. "today", "12d ago", "in 3w". */
export function relativeToToday(iso: string, today = todayISO()): string {
	const delta = diffDays(today, iso);
	if (!Number.isFinite(delta)) return "unknown";
	if (delta === 0) return "today";
	if (delta === 1) return "yesterday";
	if (delta > 0) return `${formatDuration(delta)} ago`;
	if (delta === -1) return "tomorrow";
	return `in ${formatDuration(delta)}`;
}

/**
 * Days until the next occurrence of a birthday. Accepts YYYY-MM-DD or MM-DD.
 * Returns 0 when it is today.
 */
export function daysUntilAnniversary(value: string, today = todayISO()): number | null {
	const m = /(?:^|-)(\d{1,2})-(\d{1,2})$/.exec(value.trim());
	if (!m) return null;
	const month = Number(m[1]);
	const day = Number(m[2]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;

	const t = toUTC(today);
	if (t === null) return null;
	const year = new Date(t).getUTCFullYear();

	// Feb 29 in a common year rolls forward to Mar 1, which is the conventional
	// reading and keeps the countdown monotonic.
	let next = Date.UTC(year, month - 1, day);
	if (next < t) next = Date.UTC(year + 1, month - 1, day);
	return Math.round((next - t) / MS_PER_DAY);
}
