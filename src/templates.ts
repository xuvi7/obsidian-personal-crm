import { moment } from "obsidian";

/** Obsidian re-exports moment as `any`; narrow it to what formatting needs. */
interface FormattableMoment {
	format(pattern: string): string;
}
type MomentNow = () => FormattableMoment;
const now = moment as unknown as MomentNow;

export interface TemplateVars {
	/** The person's name — the note's title. */
	title: string;
	/** Extra values available as {{key}}, e.g. email or phone from an import. */
	fields?: Record<string, string>;
}

const DEFAULT_DATE = "YYYY-MM-DD";
const DEFAULT_TIME = "HH:mm";

/**
 * Fill a template for a new person note.
 *
 * Supports Obsidian's core template tokens (`{{title}}`, `{{date}}`, `{{time}}`,
 * with optional `{{date:FORMAT}}`), plus any extra field as `{{key}}`.
 *
 * Templater expressions are handled on a best-effort basis rather than ignored:
 * a template written for Templater would otherwise leave `<% … %>` sitting in
 * every new note, which is exactly the placeholder noise the preview has to strip.
 * The three forms that actually appear in person templates are translated, and
 * anything else is removed rather than left behind.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
	const fields = vars.fields ?? {};
	let out = template;

	// --- Templater forms, translated to their result ---
	// <% tp.date.now("FORMAT") %> and tp.date.now() with no arguments.
	out = out.replace(
		/<%[-_]?\s*tp\.date\.now\(\s*(?:["'`]([^"'`]*)["'`])?[^)]*\)\s*[-_]?%>/g,
		(_m, fmt: string | undefined) => now().format(fmt && fmt.length > 0 ? fmt : DEFAULT_DATE),
	);
	// <% tp.file.title %>
	out = out.replace(/<%[-_]?\s*tp\.file\.title\s*[-_]?%>/g, vars.title);
	// <% tp.file.cursor() %> is only a cursor marker; it leaves no text.
	out = out.replace(/<%[-_]?\s*tp\.file\.cursor\([^)]*\)\s*[-_]?%>/g, "");
	// Anything else Templater-shaped can't be evaluated here.
	out = out.replace(/<%[\s\S]*?%>/g, "");

	// --- Core template tokens ---
	out = out.replace(/\{\{\s*title\s*\}\}/gi, vars.title);
	out = out.replace(/\{\{\s*date\s*:\s*([^}]+)\}\}/gi, (_m, fmt: string) =>
		now().format(fmt.trim()),
	);
	out = out.replace(/\{\{\s*time\s*:\s*([^}]+)\}\}/gi, (_m, fmt: string) =>
		now().format(fmt.trim()),
	);
	out = out.replace(/\{\{\s*date\s*\}\}/gi, now().format(DEFAULT_DATE));
	out = out.replace(/\{\{\s*time\s*\}\}/gi, now().format(DEFAULT_TIME));

	// Imported values, then drop any token nothing supplied so the note stays clean.
	out = out.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => fields[key] ?? "");

	return out;
}

/**
 * The note used when no template is configured. Deliberately plain: frontmatter
 * the plugin reads, and two headings to write into.
 */
export function defaultPersonNote(vars: TemplateVars): string {
	const fields = vars.fields ?? {};
	const front: string[] = ["---", "tags:", "  - people", `created: ${now().format(DEFAULT_DATE)}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value.trim().length > 0) front.push(`${key}: ${value}`);
	}
	front.push("---");

	return [...front, "", "# Facts", "", "# Thoughts", ""].join("\n");
}

/** Characters Obsidian and the filesystem won't accept in a note title. */
export function sanitizeNoteName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "")
		.trim();
	return cleaned.slice(0, 180);
}
