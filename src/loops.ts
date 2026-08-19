import type { App, TFile } from "obsidian";
import type { LoopRef } from "./types";
import { isISODate } from "./dates";
import { findHeading, sectionEnd, shallowestHeadingLevel } from "./markdown";

/**
 * Reading and completing open loops.
 *
 * The index deliberately stores only a location, so everything that needs the
 * task's words lives here and reads the file at the moment it's shown.
 */

/** An unchecked task marker at the start of a line: `- [ ] `, `* [ ]`, … */
const OPEN_TASK = /^(\s*[-*+]\s+\[)( )(\]\s*)/;
/** Either state, so a completed task can be found again and reopened. */
const ANY_TASK = /^(\s*[-*+]\s+\[)([ xX])(\]\s*)/;

/**
 * Due dates, most explicit first.
 *
 * The unmarked forms are anchored to the end of the line. Accepting a bare date
 * *anywhere* meant any task that merely mentioned one had it deleted from its text
 * and reported as a deadline: "recap the [[2026-01-24]] chat" rendered as "recap the
 * [[]] chat", overdue by years. That shape is common here — dated wikilinks in a
 * person's note are themselves a tracked interaction — so a date only reads as a due
 * date when it carries a marker or trails the line.
 */
const DUE_PATTERNS = [
	/(?:📅|⏳|🛫)\s*(\d{4}-\d{2}-\d{2})/u,
	/\bdue\s*::?\s*(\d{4}-\d{2}-\d{2})/i,
	/\((\d{4}-\d{2}-\d{2})\)\s*$/,
	/\b(\d{4}-\d{2}-\d{2})\s*$/,
];

/**
 * Placeholder for a set-aside wikilink. U+FFFC is OBJECT REPLACEMENT CHARACTER,
 * which exists for exactly this and won't appear in a note.
 */
const LINK_SLOT = /\uFFFC(\d+)\uFFFC/g;

export interface Loop {
	ref: LoopRef;
	/** The task's words, with the marker and any due-date syntax removed. */
	text: string;
	/** Due date if the task carries one. */
	due: string | null;
	/** True when the task is already ticked off. */
	done: boolean;
}

/** The line `offset` starts on, as `[start, endExclusive]`. */
function lineSpanAt(content: string, offset: number): [number, number] {
	const start = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
	const nl = content.indexOf("\n", start);
	return [start, nl === -1 ? content.length : nl];
}

function lineSpanOfLine(content: string, line: number): [number, number] | null {
	let start = 0;
	for (let i = 0; i < line; i++) {
		const nl = content.indexOf("\n", start);
		if (nl === -1) return null;
		start = nl + 1;
	}
	const nl = content.indexOf("\n", start);
	return [start, nl === -1 ? content.length : nl];
}

/**
 * Find the open task a ref points at.
 *
 * Prefers the recorded offset, then the recorded line: an edit elsewhere in the
 * file shifts offsets while leaving line numbers alone, and vice versa. If
 * neither still holds an open task the ref is stale and nothing is returned,
 * rather than guessing at a line and rewriting the wrong one.
 */
export function locateTask(
	content: string,
	ref: LoopRef,
	pattern: RegExp = OPEN_TASK,
): [number, number] | null {
	const byOffset = lineSpanAt(content, ref.offset);
	if (pattern.test(content.slice(byOffset[0], byOffset[1]))) return byOffset;

	const byLine = lineSpanOfLine(content, ref.line);
	if (byLine && pattern.test(content.slice(byLine[0], byLine[1]))) return byLine;

	return null;
}

/**
 * A task line's words and its due date, in one pass.
 *
 * Wikilinks are set aside before the due date is looked for, so a date inside one is
 * never mistaken for a deadline and stripping a deadline can never hollow a link out
 * to `[[]]`. They come back as their display text.
 */
export function parseTask(line: string): { text: string; due: string | null } {
	let body = line.replace(ANY_TASK, "");

	const links: string[] = [];
	body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => {
		links.push(alias ?? target);
		return `\uFFFC${links.length - 1}\uFFFC`;
	});

	let due: string | null = null;
	for (const pattern of DUE_PATTERNS) {
		const m = pattern.exec(body);
		if (m && isISODate(m[1])) {
			due = m[1];
			body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
			break;
		}
	}

	body = body.replace(LINK_SLOT, (_match, index: string) => links[Number(index)] ?? "");
	// Collapse the gap a removed due date leaves behind.
	return { text: body.replace(/\s+/g, " ").trim(), due };
}

/** Just the words. Kept as a seam for tests. */
export function loopText(line: string): string {
	return parseTask(line).text;
}

/** Just the due date. Kept as a seam for tests. */
export function loopDue(line: string): string | null {
	return parseTask(line).due;
}

/**
 * Read the loops a person has, dropping any whose task has been deleted. One read
 * per distinct file, since several loops usually share one.
 *
 * Completed tasks are read too, reported as `done`: the caller may be showing one
 * it just ticked off, and a row that vanishes on click can't be un-ticked.
 */
export async function readLoops(app: App, refs: LoopRef[]): Promise<Loop[]> {
	const byPath = new Map<string, LoopRef[]>();
	const seen = new Set<string>();
	for (const ref of refs) {
		const key = `${ref.path}\u0000${ref.offset}\u0000${ref.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const bucket = byPath.get(ref.path);
		if (bucket) bucket.push(ref);
		else byPath.set(ref.path, [ref]);
	}

	const out: Loop[] = [];
	for (const [path, group] of byPath) {
		const file = app.vault.getFileByPath(path);
		if (!file) continue;
		let content: string;
		try {
			content = await app.vault.cachedRead(file);
		} catch {
			continue;
		}
		for (const ref of group) {
			const span = locateTask(content, ref, ANY_TASK);
			if (!span) continue;
			const line = content.slice(span[0], span[1]);
			const { text, due } = parseTask(line);
			if (text.length === 0) continue;
			out.push({ ref, text, due, done: !OPEN_TASK.test(line) });
		}
	}

	// Outstanding first, then dated by soonest; completed sink to the bottom.
	out.sort((a, b) => {
		if (a.done !== b.done) return a.done ? 1 : -1;
		if (a.due && b.due) return a.due.localeCompare(b.due);
		if (a.due) return -1;
		if (b.due) return 1;
		return 0;
	});
	return out;
}

/**
 * Set the task a ref points at to done or open, or null when the ref is stale.
 *
 * Both directions, because ticking a follow-up off by accident has to be
 * undoable in the place you did it — the index drops a completed task, so the
 * checkbox is the only handle left on it.
 */
export function setTask(content: string, ref: LoopRef, done: boolean): string | null {
	const span = locateTask(content, ref, ANY_TASK);
	if (!span) return null;
	const line = content.slice(span[0], span[1]);
	const next = line.replace(ANY_TASK, done ? "$1x$3" : "$1 $3");
	if (next === line) return null;
	return content.slice(0, span[0]) + next + content.slice(span[1]);
}

/**
 * Append `- [ ] text` under `heading` in a note, creating the heading at the end
 * if it isn't there. Returns the new content.
 */
export function appendFollowUp(content: string, heading: string, text: string): string {
	return appendLine(content, heading, `- [ ] ${text.trim()}`);
}

/** Put one literal line at the end of `heading`'s section. */
function appendLine(content: string, heading: string, task: string): string {
	// Fence-aware, via the shared scanner. A line-scanning regex matched a heading
	// shown as an example inside a code fence, and wrote the task into the fence —
	// where Obsidian never parses it as a task, so it was invisible to the index while
	// the user was told it had been added.
	const found = findHeading(content, heading);

	if (!found) {
		const level = shallowestHeadingLevel(content);
		const gap =
			content.length === 0 || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		return `${content}${gap}${"#".repeat(level)} ${heading}\n${task}\n`;
	}

	// Insert at the end of the heading's own section, so the newest is last.
	const bodyStart = found.afterLine;
	const end = sectionEnd(content, found);
	const section = content.slice(bodyStart, end);
	// Trailing blank lines are the user's spacing; keep them after the new item.
	const trailing = /(\s*)$/.exec(section)?.[1] ?? "";
	const body = section.slice(0, section.length - trailing.length);
	const separator = body.length === 0 || body.endsWith("\n") ? "" : "\n";
	return content.slice(0, bodyStart) + body + separator + `${task}\n` + trailing + content.slice(end);
}

/**
 * Whether a note already has a section under `heading`.
 *
 * Used to avoid writing the reach-out block twice into the same note. Fence-aware,
 * so a daily-note template that *documents* the block's format inside a code fence
 * doesn't read as already having one.
 */
export function hasHeading(content: string, heading: string): boolean {
	return findHeading(content, heading) !== null;
}

/**
 * Append several lines under `heading`, creating the heading if absent.
 *
 * One insertion, not one per line: appending individually re-scanned and rebuilt the
 * whole document for every line, which is quadratic in the block's length.
 */
export function appendUnder(content: string, heading: string, lines: string[]): string {
	if (lines.length === 0) return content;
	return appendLine(content, heading, lines.join("\n"));
}

export function loopFile(app: App, ref: LoopRef): TFile | null {
	return app.vault.getFileByPath(ref.path);
}
