import type { App, TFile } from "obsidian";
import type { LoopRef } from "./types";
import { isISODate } from "./dates";

/**
 * Reading and completing open loops.
 *
 * The index deliberately stores only a location, so everything that needs the
 * task's words lives here and reads the file at the moment it's shown.
 */

/** Matches an unchecked task marker at the start of a line: `- [ ] `, `* [ ]`, … */
const OPEN_TASK = /^(\s*[-*+]\s+\[)( )(\]\s*)/;

/** Due dates as the Tasks plugin writes them (`📅 2026-08-20`) or a bare ISO date. */
const DUE_PATTERNS = [
	/(?:📅|⏳|🛫)\s*(\d{4}-\d{2}-\d{2})/u,
	/\bdue\s*::?\s*(\d{4}-\d{2}-\d{2})/i,
	/\((\d{4}-\d{2}-\d{2})\)/,
	/\b(\d{4}-\d{2}-\d{2})\b/,
];

export interface Loop {
	ref: LoopRef;
	/** The task's words, with the marker and any due-date syntax removed. */
	text: string;
	/** Due date if the task carries one. */
	due: string | null;
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
export function locateTask(content: string, ref: LoopRef): [number, number] | null {
	const byOffset = lineSpanAt(content, ref.offset);
	if (OPEN_TASK.test(content.slice(byOffset[0], byOffset[1]))) return byOffset;

	const byLine = lineSpanOfLine(content, ref.line);
	if (byLine && OPEN_TASK.test(content.slice(byLine[0], byLine[1]))) return byLine;

	return null;
}

/** Strip the task marker, trailing due-date syntax and wikilink brackets. */
export function loopText(line: string): string {
	let text = line.replace(OPEN_TASK, "");
	for (const pattern of DUE_PATTERNS) {
		const m = pattern.exec(text);
		if (m) {
			text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
			break;
		}
	}
	// Show the display text of a link, not its target syntax.
	text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
	return text.trim();
}

export function loopDue(line: string): string | null {
	for (const pattern of DUE_PATTERNS) {
		const m = pattern.exec(line);
		if (m && isISODate(m[1])) return m[1];
	}
	return null;
}

/**
 * Read the loops a person has, dropping any whose task has since been completed
 * or deleted. One read per distinct file, since several loops usually share one.
 */
export async function readLoops(app: App, refs: LoopRef[]): Promise<Loop[]> {
	const byPath = new Map<string, LoopRef[]>();
	for (const ref of refs) {
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
			const span = locateTask(content, ref);
			if (!span) continue;
			const line = content.slice(span[0], span[1]);
			const text = loopText(line);
			if (text.length === 0) continue;
			out.push({ ref, text, due: loopDue(line) });
		}
	}

	// Dated loops first, soonest at the top; undated keep vault order behind them.
	out.sort((a, b) => {
		if (a.due && b.due) return a.due.localeCompare(b.due);
		if (a.due) return -1;
		if (b.due) return 1;
		return 0;
	});
	return out;
}

/** Flip the task a ref points at to `[x]`, or null when the ref is stale. */
export function completeTask(content: string, ref: LoopRef): string | null {
	const span = locateTask(content, ref);
	if (!span) return null;
	const line = content.slice(span[0], span[1]);
	const done = line.replace(OPEN_TASK, "$1x$3");
	if (done === line) return null;
	return content.slice(0, span[0]) + done + content.slice(span[1]);
}

/**
 * Append `- [ ] text` under `heading` in a note, creating the heading at the end
 * if it isn't there. Returns the new content.
 */
export function appendFollowUp(content: string, heading: string, text: string): string {
	const task = `- [ ] ${text.trim()}`;
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingRe = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "im");
	const match = headingRe.exec(content);

	if (!match) {
		const level = shallowestHeading(content);
		const gap = content.length === 0 || content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		return `${content}${gap}${"#".repeat(level)} ${heading}\n${task}\n`;
	}

	// Insert after the heading's existing lines so the newest follow-up is last,
	// stopping at the next heading of any level.
	const bodyStart = match.index + match[0].length;
	const rest = content.slice(bodyStart);
	const next = /\n#{1,6}\s/.exec(rest);
	const sectionEnd = next ? bodyStart + next.index : content.length;
	const section = content.slice(bodyStart, sectionEnd);
	const trimmed = section.replace(/\s+$/, "");
	return content.slice(0, bodyStart) + trimmed + `\n${task}\n` + content.slice(sectionEnd);
}

/** Match the note's own heading depth so a new section doesn't outrank the rest. */
function shallowestHeading(content: string): number {
	let level = 2;
	const re = /^(#{1,6})\s+\S/gm;
	let m: RegExpExecArray | null;
	let found = 7;
	while ((m = re.exec(content)) !== null) found = Math.min(found, m[1].length);
	if (found <= 6) level = found;
	return level;
}

export function loopFile(app: App, ref: LoopRef): TFile | null {
	return app.vault.getFileByPath(ref.path);
}
