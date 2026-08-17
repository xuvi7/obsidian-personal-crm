import type { CachedMetadata } from "obsidian";

/**
 * Obsidian types frontmatter values as `any`, which spreads untyped values
 * through every read site. Narrowing once here — from `unknown`, so the
 * assertion genuinely changes the type — keeps the rest of the codebase honest
 * about the fact that frontmatter is user-controlled data of unknown shape.
 */
export function frontmatterOf(
	cache: CachedMetadata | null | undefined,
): Record<string, unknown> {
	const raw: unknown = cache?.frontmatter;
	if (typeof raw !== "object" || raw === null) return {};
	return raw as Record<string, unknown>;
}

/**
 * The shape `fileManager.processFrontMatter` hands to its callback. Declaring it
 * as a record rather than accepting `any` means writes are checked too.
 */
export type MutableFrontmatter = Record<string, unknown>;

/**
 * Coerce a frontmatter value to text, or `null` if it has no sensible single-string
 * form.
 *
 * Plain `String(value)` turns a mapping like `prm-birthday: {a: b}` into the
 * literal `"[object Object]"`, which would then be written back into the user's
 * note. Frontmatter is arbitrary user data, so refuse rather than guess.
 */
export function asText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}
	return null;
}
