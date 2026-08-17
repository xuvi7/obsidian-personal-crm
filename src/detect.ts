import { App, TFolder } from "obsidian";
import type { JournalSource } from "./journal";
import { cleanFolderPath } from "./settings";

/**
 * First-run detection.
 *
 * Obsidian already knows where the user's daily notes live and how they're named
 * — core Daily Notes and the Periodic Notes plugin both store it. Reading that
 * beats shipping defaults that only match the author's own vault.
 *
 * Neither config is in the public API, so every access is narrowed defensively:
 * a schema that doesn't match simply yields nothing, and the user can still set
 * the fields by hand.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

interface Granularity {
	folder: string;
	format: string;
}

function readGranularity(value: unknown): Granularity | null {
	const rec = asRecord(value);
	if (!rec) return null;
	const folder = cleanFolderPath(asString(rec["folder"]));
	const format = asString(rec["format"]).trim();
	if (folder.length === 0 && format.length === 0) return null;
	return { folder, format };
}

/** Core Daily Notes: `app.internalPlugins.getPluginById("daily-notes")`. */
function fromCoreDailyNotes(app: App): Granularity | null {
	const internal = asRecord((app as unknown as Record<string, unknown>)["internalPlugins"]);
	const getPluginById = internal?.["getPluginById"];
	if (typeof getPluginById !== "function") return null;

	let plugin: unknown;
	try {
		plugin = (getPluginById as (id: string) => unknown).call(internal, "daily-notes");
	} catch {
		return null;
	}

	const instance = asRecord(asRecord(plugin)?.["instance"]);
	const options = asRecord(instance?.["options"]);
	if (!options) return null;

	return {
		folder: cleanFolderPath(asString(options["folder"])),
		// Core Daily Notes leaves format empty when the user never changed it.
		format: asString(options["format"]).trim() || "YYYY-MM-DD",
	};
}

/**
 * Periodic Notes, which has two schemas: a legacy flat one keyed by granularity,
 * and a current one built around named calendar sets.
 */
function fromPeriodicNotes(app: App): Granularity[] {
	const plugins = asRecord((app as unknown as Record<string, unknown>)["plugins"]);
	const registry = asRecord(plugins?.["plugins"]);
	const settings = asRecord(asRecord(registry?.["periodic-notes"])?.["settings"]);
	if (!settings) return [];

	const out: Granularity[] = [];
	const push = (g: Granularity | null) => {
		if (g) out.push(g);
	};

	// Current schema: { activeCalendarSet, calendarSets: [{ day, week, month, … }] }
	const calendarSets = settings["calendarSets"];
	if (Array.isArray(calendarSets)) {
		const active = asString(settings["activeCalendarSet"]);
		const sets = calendarSets.filter((s): s is Record<string, unknown> => !!asRecord(s));
		const chosen =
			sets.find((s) => asString(s["id"]) === active && active.length > 0) ?? sets[0];
		if (chosen) {
			for (const key of ["day", "week", "month", "quarter", "year"]) {
				push(readGranularity(chosen[key]));
			}
		}
	}

	// Legacy schema: { daily: { enabled, folder, format }, weekly: { … } }
	for (const key of ["daily", "weekly", "monthly", "quarterly", "yearly"]) {
		const rec = asRecord(settings[key]);
		if (!rec) continue;
		if (rec["enabled"] === false) continue;
		push(readGranularity(rec));
	}

	return out;
}

/** Journal sources detected from the user's other plugins, most specific first. */
export function detectJournalSources(app: App): JournalSource[] {
	const found: Granularity[] = [...fromPeriodicNotes(app)];
	const core = fromCoreDailyNotes(app);
	if (core) found.push(core);

	const out: JournalSource[] = [];
	const seen = new Set<string>();

	for (const g of found) {
		const format = g.format.trim();
		if (format.length === 0) continue;
		const folder = g.folder;
		const key = `${folder}::${format}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ folder, format });
	}

	return out;
}

const PEOPLE_FOLDER_NAMES = [
	"people",
	"contacts",
	"persons",
	"person",
	"friends",
	"humans",
	"who",
];

/**
 * Guess the people folder by name, preferring the shallowest match so a nested
 * `Archive/People` doesn't beat a top-level `People`.
 */
export function detectPeopleFolder(app: App): string | null {
	let best: TFolder | null = null;
	let bestDepth = Number.POSITIVE_INFINITY;

	for (const file of app.vault.getAllLoadedFiles()) {
		if (!(file instanceof TFolder)) continue;
		if (!PEOPLE_FOLDER_NAMES.includes(file.name.toLowerCase())) continue;
		const depth = file.path.split("/").length;
		if (depth < bestDepth) {
			best = file;
			bestDepth = depth;
		}
	}

	return best ? best.path : null;
}
