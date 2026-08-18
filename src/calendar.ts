import { addDays, dayNumber } from "./dates";

/**
 * Bucketing interactions into a grid of periods.
 *
 * One module for all four scales because they're the same shape — rows of cells
 * carrying a count and the people behind it — and because the person panel's
 * year-of-days and the calendar view's day mode should never be able to disagree
 * about what a week is.
 */

export type Granularity = "day" | "week" | "month" | "year";

export interface CalendarCell {
	/** Stable key for the period: `2026-08-18`, `2026-W33`, `2026-08`, `2026`. */
	key: string;
	/** Human label, used in the detail panel and tooltips. */
	label: string;
	/** Interactions in this period. */
	count: number;
	/** Person note paths involved, in first-seen order. */
	people: string[];
	/** True for periods after today — layout padding, not absence of contact. */
	future: boolean;
}

export interface CalendarGrid {
	granularity: Granularity;
	/** Rows of cells. `null` is a hole in the grid, e.g. Feb 30th. */
	rows: { label: string; cells: (CalendarCell | null)[] }[];
	/** Labels above the columns; empty strings where a label would crowd. */
	columnLabels: string[];
	/** Highest count in the grid, for shading. */
	max: number;
	/** Interactions inside the grid, and those older than it. */
	inRange: number;
	older: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day of the week for an ISO date, 0 = Sunday. Epoch day 0 was a Thursday. */
export function weekday(iso: string): number {
	const n = dayNumber(iso);
	return n === null ? 0 : (((n + 4) % 7) + 7) % 7;
}

/** Week of the year, 1-53, counting from Jan 1 rather than by ISO rules. */
function weekOfYear(iso: string): number {
	const jan1 = dayNumber(`${iso.slice(0, 4)}-01-01`);
	const here = dayNumber(iso);
	if (jan1 === null || here === null) return 1;
	return Math.floor((here - jan1) / 7) + 1;
}

/** Which bucket a date falls in, at the given scale. */
export function bucketKey(iso: string, granularity: Granularity): string {
	switch (granularity) {
		case "day":
			return iso;
		case "week":
			return `${iso.slice(0, 4)}-W${String(weekOfYear(iso)).padStart(2, "0")}`;
		case "month":
			return iso.slice(0, 7);
		case "year":
			return iso.slice(0, 4);
	}
}

/** Interactions keyed by date, as `date → person paths`. */
export type Interactions = Map<string, string[]>;

interface Totals {
	count: number;
	people: string[];
	seen: Set<string>;
}

function totalsFor(interactions: Interactions, granularity: Granularity): Map<string, Totals> {
	const out = new Map<string, Totals>();
	for (const [date, people] of interactions) {
		const key = bucketKey(date, granularity);
		let entry = out.get(key);
		if (!entry) {
			entry = { count: 0, people: [], seen: new Set() };
			out.set(key, entry);
		}
		entry.count += people.length;
		for (const path of people) {
			if (entry.seen.has(path)) continue;
			entry.seen.add(path);
			entry.people.push(path);
		}
	}
	return out;
}

function cell(
	key: string,
	label: string,
	totals: Map<string, Totals>,
	future: boolean,
): CalendarCell {
	const found = totals.get(key);
	return {
		key,
		label,
		count: found?.count ?? 0,
		people: found?.people ?? [],
		future,
	};
}

/**
 * A contiguous run of years ending this year, newest first.
 *
 * Contiguous rather than only-years-with-data: rows are a time axis, and putting
 * 2019 directly above 2025 makes an empty stretch look like no stretch at all.
 * Anything older than the run is reported through `older` instead.
 */
function yearsOf(interactions: Interactions, today: string, limit: number): string[] {
	const thisYear = Number(today.slice(0, 4));
	let oldest = thisYear;
	for (const date of interactions.keys()) {
		const year = Number(date.slice(0, 4));
		if (Number.isFinite(year) && year < oldest) oldest = year;
	}

	// A limit of Infinity (the year view) reaches back to the oldest interaction.
	const start = Math.max(oldest, limit >= thisYear ? oldest : thisYear - limit + 1);
	const out: string[] = [];
	for (let year = thisYear; year >= start; year--) out.push(String(year));
	return out;
}

/**
 * Build a grid for one scale.
 *
 * @param weeks How many weeks the day view covers.
 * @param years How many years the week, month and year views cover.
 */
export function buildCalendar(
	interactions: Interactions,
	granularity: Granularity,
	today: string,
	opts: { weeks?: number; years?: number; weekStart?: number } = {},
): CalendarGrid {
	const totals = totalsFor(interactions, granularity);
	const weeks = opts.weeks ?? 53;
	const yearLimit = opts.years ?? 6;
	const weekStart = opts.weekStart ?? 0;

	const grid =
		granularity === "day"
			? dayGrid(totals, today, weeks, weekStart)
			: granularity === "week"
				? weekGrid(totals, interactions, today, yearLimit)
				: granularity === "month"
					? monthGrid(totals, interactions, today, yearLimit)
					: yearGrid(totals, interactions, today);

	let max = 0;
	let inRange = 0;
	const covered = new Set<string>();
	for (const row of grid.rows) {
		for (const c of row.cells) {
			if (!c) continue;
			covered.add(c.key);
			if (c.count > max) max = c.count;
			inRange += c.count;
		}
	}

	let older = 0;
	for (const [key, entry] of totals) {
		if (!covered.has(key)) older += entry.count;
	}

	return { granularity, rows: grid.rows, columnLabels: grid.columnLabels, max, inRange, older };
}

/** Weekday rows by week columns — the contribution-graph layout. */
function dayGrid(
	totals: Map<string, Totals>,
	today: string,
	weeks: number,
	weekStart: number,
): Pick<CalendarGrid, "rows" | "columnLabels"> {
	// End on the last day of the week containing today, so today's column is full
	// width rather than a stub that reads as missing data.
	const end = addDays(today, (weekStart + 6 - weekday(today) + 7) % 7);
	const start = addDays(end, -(weeks * 7 - 1));

	const columns: string[][] = [];
	let cursor = start;
	for (let w = 0; w < weeks; w++) {
		const column: string[] = [];
		for (let d = 0; d < 7; d++) {
			column.push(cursor);
			cursor = addDays(cursor, 1);
		}
		columns.push(column);
	}

	const rows = [];
	for (let d = 0; d < 7; d++) {
		const cells = columns.map((column) => {
			const date = column[d];
			return cell(date, date, totals, date > today);
		});
		// Only alternate weekdays are labelled; seven labels crowd the axis.
		rows.push({ label: d % 2 === 1 ? WEEKDAYS[(weekStart + d) % 7] : "", cells });
	}

	// A column is labelled when its first day opens a new month.
	let lastMonth = "";
	const columnLabels = columns.map((column) => {
		const month = column[0].slice(0, 7);
		if (month === lastMonth) return "";
		lastMonth = month;
		return MONTHS[Number(column[0].slice(5, 7)) - 1] ?? "";
	});

	return { rows, columnLabels };
}

/** Year rows by week columns. */
function weekGrid(
	totals: Map<string, Totals>,
	interactions: Interactions,
	today: string,
	yearLimit: number,
): Pick<CalendarGrid, "rows" | "columnLabels"> {
	const thisYear = today.slice(0, 4);
	const thisWeek = weekOfYear(today);

	const rows = yearsOf(interactions, today, yearLimit).map((year) => {
		const cells: (CalendarCell | null)[] = [];
		for (let w = 1; w <= 53; w++) {
			const key = `${year}-W${String(w).padStart(2, "0")}`;
			const future = year > thisYear || (year === thisYear && w > thisWeek);
			cells.push(cell(key, `week ${w} of ${year}`, totals, future));
		}
		return { label: year, cells };
	});

	const columnLabels = Array.from({ length: 53 }, (_, i) =>
		// Roughly one label a month; weeks don't align to months, so this is a guide.
		i % 4 === 0 ? String(i + 1) : "",
	);
	return { rows, columnLabels };
}

/** Year rows by month columns. */
function monthGrid(
	totals: Map<string, Totals>,
	interactions: Interactions,
	today: string,
	yearLimit: number,
): Pick<CalendarGrid, "rows" | "columnLabels"> {
	const thisMonth = today.slice(0, 7);

	const rows = yearsOf(interactions, today, yearLimit).map((year) => {
		const cells: (CalendarCell | null)[] = [];
		for (let m = 1; m <= 12; m++) {
			const key = `${year}-${String(m).padStart(2, "0")}`;
			cells.push(cell(key, `${MONTHS[m - 1]} ${year}`, totals, key > thisMonth));
		}
		return { label: year, cells };
	});

	return { rows, columnLabels: [...MONTHS] };
}

/** One row of years, oldest first, so time reads left to right as elsewhere. */
function yearGrid(
	totals: Map<string, Totals>,
	interactions: Interactions,
	today: string,
): Pick<CalendarGrid, "rows" | "columnLabels"> {
	const years = yearsOf(interactions, today, Number.MAX_SAFE_INTEGER).reverse();
	const cells = years.map((year) => cell(year, year, totals, year > today.slice(0, 4)));
	return { rows: [{ label: "", cells }], columnLabels: years };
}

/**
 * The trailing `count` months ending this month, oldest first.
 *
 * A rolling window rather than calendar-year rows: for a thumbnail, "the last
 * twelve months" is the useful frame, and January shouldn't restart the picture.
 */
export function trailingMonths(
	interactions: Interactions,
	today: string,
	count = 12,
): { key: string; label: string; count: number }[] {
	const totals = totalsFor(interactions, "month");
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));

	const out: { key: string; label: string; count: number }[] = [];
	for (let back = count - 1; back >= 0; back--) {
		// Month arithmetic in one place, so a December rollover can't be got wrong.
		const index = year * 12 + (month - 1) - back;
		const y = Math.floor(index / 12);
		const m = (index % 12) + 1;
		const key = `${y}-${String(m).padStart(2, "0")}`;
		out.push({ key, label: `${MONTHS[m - 1]} ${y}`, count: totals.get(key)?.count ?? 0 });
	}
	return out;
}

/**
 * The shade for each level, 0 (empty) first.
 *
 * Set inline on the element rather than from a stylesheet. Grid cells are
 * `<button>`s so they're focusable and operable from the keyboard, and Obsidian
 * styles buttons through nested selectors whose specificity a single class of mine
 * can't beat — so a CSS rule lost to the app's own button background, leaving a
 * uniform, colourless grid. The legend's swatches are spans and were coloured
 * correctly the whole time; that mismatch is what identified it. An inline style
 * beats any non-important rule.
 *
 * The ramp is the GitHub-contributions green from the heatmap-tracker plugin
 * (github.com/mokkiebear/heatmap-tracker, Apache 2.0), which sets its colours inline
 * for the same reason. It reads on light and dark themes alike.
 */
export const HEAT_COLORS: readonly string[] = [
	"", // level 0 is drawn as a hollow outline, not a fill
	"#c6e48b",
	"#7bc96f",
	"#49af5d",
	"#196127",
];

/**
 * Shade level 0-4 for a count. Higher means darker.
 *
 * Two regimes, because a relative scale alone gets both ends wrong.
 *
 * When the busiest period holds only a handful, counts map straight to levels: one
 * interaction is the lightest step. Stretching a 0-or-1 range across the full ramp
 * — which is every single-person calendar — painted a solitary contact as the
 * darkest shade, reading as maximum intensity when it's the minimum.
 *
 * Above that, levels are square-rooted rather than linear. Counts are heavily
 * skewed, one busy day being ten times a typical one, and a linear scale against
 * the maximum drops almost every real period onto level 1.
 */
export function shade(count: number, max: number): number {
	if (count <= 0) return 0;
	if (max <= 4) return Math.min(4, count);
	const level = Math.ceil(Math.sqrt(count / max) * 4);
	return Math.min(4, Math.max(1, level));
}
