import { addDays, dayNumber } from "./dates";

/**
 * A contact calendar, in the shape of a contribution graph.
 *
 * The point is to make a relationship's *shape* visible, which no single number
 * can carry. "Daily for three months, then nothing" and "steadily every fortnight
 * for years, quiet lately" produce the same rhythm figure and mean completely
 * different things — and the difference is obvious at a glance here.
 */

export interface HeatCell {
	/** ISO date, or null for padding before the first column starts. */
	date: string | null;
	contacted: boolean;
	/** True for dates after today, which are padding at the end. */
	future: boolean;
}

export interface Heatmap {
	/** Columns of 7 days, oldest week first, each column starting on `weekStart`. */
	weeks: HeatCell[][];
	/** Month labels keyed by the column they start in. */
	monthLabels: { column: number; label: string }[];
	/** Interactions inside the window. */
	inWindow: number;
	/** First and last day covered. */
	from: string;
	to: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Day of the week for an ISO date, 0 = Sunday. */
function weekday(iso: string): number {
	const n = dayNumber(iso);
	// Day 0 of the epoch (1970-01-01) was a Thursday, hence the +4.
	return n === null ? 0 : (((n + 4) % 7) + 7) % 7;
}

/**
 * Build a calendar of the `weeks` weeks ending today.
 *
 * @param weekStart 0 = Sunday, 1 = Monday. Obsidian has no vault-wide setting for
 *   this, so it's a parameter rather than a guess.
 */
export function buildHeatmap(
	dates: string[],
	today: string,
	weeks = 53,
	weekStart = 0,
): Heatmap {
	const contacted = new Set(dates);

	// End on the last day of the week containing today, so today's column is full
	// width rather than a stub that reads as missing data.
	const offsetToEnd = (weekStart + 6 - weekday(today) + 7) % 7;
	const end = addDays(today, offsetToEnd);
	const start = addDays(end, -(weeks * 7 - 1));

	const out: HeatCell[][] = [];
	const monthLabels: { column: number; label: string }[] = [];
	let inWindow = 0;
	let lastMonth = "";

	let cursor = start;
	for (let w = 0; w < weeks; w++) {
		const column: HeatCell[] = [];
		for (let d = 0; d < 7; d++) {
			const future = cursor > today;
			const hit = !future && contacted.has(cursor);
			if (hit) inWindow++;
			column.push({ date: cursor, contacted: hit, future });

			// Label a column when its first row enters a new month.
			if (d === 0) {
				const month = cursor.slice(0, 7);
				if (month !== lastMonth) {
					lastMonth = month;
					monthLabels.push({
						column: w,
						label: MONTHS[Number(cursor.slice(5, 7)) - 1] ?? "",
					});
				}
			}
			cursor = addDays(cursor, 1);
		}
		out.push(column);
	}

	return { weeks: out, monthLabels, inWindow, from: start, to: end };
}
