/**
 * Locating headings in note text.
 *
 * Two call sites needed this and each got it wrong in a different way.
 *
 * `appendBodyLog` took the heading's byte offset from Obsidian's `metadataCache`,
 * which is correct about fences but **stale after a write** — the cache updates
 * asynchronously, and logging contact grows the frontmatter, so the offset was short
 * by exactly that many bytes. The log bullet was then inserted *inside* the YAML,
 * destroying the frontmatter. Scanning the content passed to `vault.process` cannot
 * be stale, because it is the bytes being written.
 *
 * `appendLine` scanned lines with a regex, which is never stale but matches a heading
 * shown as an example inside a code fence — writing a follow-up into the fence, where
 * Obsidian never parses it as a task, so it is invisible to the index forever.
 *
 * This does both: a single pass over the real content that skips frontmatter and
 * fenced blocks.
 */

export interface HeadingSpan {
	level: number;
	/** The heading's text, trimmed. */
	text: string;
	/** Offset of the leading `#`. */
	start: number;
	/**
	 * Offset just past the heading's line terminator — i.e. the start of the next
	 * line. Inserting here keeps CRLF intact, which inserting mid-terminator would
	 * not.
	 */
	afterLine: number;
}

const FENCE = /^(?:```+|~~~+)/;
const HEADING = /^(#{1,6})\s+(.*)$/;

/** Every heading outside frontmatter and fenced code, in document order. */
export function scanHeadings(content: string): HeadingSpan[] {
	const out: HeadingSpan[] = [];
	const lines = content.split("\n");
	let offset = 0;
	let inFrontmatter = false;
	let fence: string | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const next = offset + line.length + 1;
		const trimmed = line.trim();

		// Frontmatter only counts when `---` opens the very first line.
		if (i === 0 && trimmed === "---") {
			inFrontmatter = true;
			offset = next;
			continue;
		}
		if (inFrontmatter) {
			if (trimmed === "---" || trimmed === "...") inFrontmatter = false;
			offset = next;
			continue;
		}

		const opener = FENCE.exec(trimmed);
		if (opener) {
			// Only a fence of the same character closes one, so ``` inside a ~~~ block
			// doesn't end it.
			const marker = opener[0][0];
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			offset = next;
			continue;
		}

		if (fence === null) {
			const h = HEADING.exec(trimmed);
			if (h) out.push({ level: h[1].length, text: h[2].trim(), start: offset, afterLine: next });
		}
		offset = next;
	}

	return out;
}

/** The first heading whose text matches, compared case-insensitively and trimmed. */
export function findHeading(content: string, heading: string): HeadingSpan | null {
	const want = heading.trim().toLowerCase();
	return scanHeadings(content).find((h) => h.text.toLowerCase() === want) ?? null;
}

/**
 * Where a heading's section ends: the start of the next heading of any level, or the
 * end of the content.
 */
export function sectionEnd(content: string, heading: HeadingSpan): number {
	const after = scanHeadings(content).find((h) => h.start > heading.start);
	return after ? after.start : content.length;
}

/**
 * The shallowest heading level in the note, for choosing the level of a new section.
 * Defaults to 2 when the note has none — a lone `#` would outrank a title.
 */
export function shallowestHeadingLevel(content: string, fallback = 2): number {
	let best = 7;
	for (const h of scanHeadings(content)) best = Math.min(best, h.level);
	return best <= 6 ? best : fallback;
}
