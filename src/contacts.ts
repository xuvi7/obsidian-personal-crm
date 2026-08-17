import type { PersonRecord } from "./types";
import { asText } from "./frontmatter";

/** A contact from an external source, normalized to the fields we care about. */
export interface ExternalContact {
	displayName: string;
	firstName?: string;
	lastName?: string;
	nickname?: string;
	emails: string[];
	phones: string[];
	/** YYYY-MM-DD or MM-DD. */
	birthday?: string;
	company?: string;
	title?: string;
	location?: string;
	labels: string[];
}

export type MatchConfidence = "exact" | "alias" | "normalized" | "given-name";

export interface PlannedChange {
	key: string;
	from: string | null;
	to: string | string[];
}

export interface PersonPlan {
	personPath: string;
	personName: string;
	contact: ExternalContact;
	confidence: MatchConfidence;
	changes: PlannedChange[];
}

export interface MatchReport {
	plans: PersonPlan[];
	/** Contacts that matched more than one person; never applied automatically. */
	ambiguous: { contact: ExternalContact; candidates: string[] }[];
	/** Contacts with no corresponding person note. */
	unmatched: ExternalContact[];
	/** Matched people whose notes already hold everything the contact has. */
	unchanged: number;
}

export interface ImportOptions {
	overwriteExisting: boolean;
	includeGivenNameMatches: boolean;
	nicknamesAsAliases: boolean;
}

// ------------------------------------------------------------------ CSV parsing

/** RFC 4180 reader: handles quoted fields containing commas and newlines. */
export function parseCsvRows(input: string): string[][] {
	let text = input;
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}

		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === ",") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (c === "\r") {
			i++;
			continue;
		}
		if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += c;
		i++;
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/**
 * Google Contacts CSV. Column names have changed across export versions, so
 * every lookup accepts the historical aliases.
 */
export function parseGoogleCsv(text: string): ExternalContact[] {
	const rows = parseCsvRows(text);
	if (rows.length < 2) return [];

	const headers = rows[0].map((h) => h.trim());
	const lower = headers.map((h) => h.toLowerCase());

	const col = (...names: string[]): number => {
		for (const name of names) {
			const idx = lower.indexOf(name.toLowerCase());
			if (idx !== -1) return idx;
		}
		return -1;
	};

	const colsMatching = (re: RegExp): number[] =>
		headers.map((h, i) => (re.test(h.trim()) ? i : -1)).filter((i) => i !== -1);

	const iFull = col("Name", "Display Name");
	const iFirst = col("First Name", "Given Name");
	const iMiddle = col("Middle Name", "Additional Name");
	const iLast = col("Last Name", "Family Name");
	const iNick = col("Nickname");
	const iBirthday = col("Birthday");
	const iCompany = col("Organization Name", "Organization 1 - Name", "Company");
	const iTitle = col("Organization Title", "Organization 1 - Title", "Job Title");
	const iCity = col("Address 1 - City", "Address 1 - Locality");
	const iRegion = col("Address 1 - Region");
	const iLabels = col("Labels", "Group Membership");

	const emailCols = colsMatching(/^e-?mail\s*\d*\s*-\s*value$/i);
	const phoneCols = colsMatching(/^phone\s*\d*\s*-\s*value$/i);

	const out: ExternalContact[] = [];

	for (const row of rows.slice(1)) {
		const at = (idx: number): string => (idx >= 0 ? (row[idx] ?? "").trim() : "");

		const first = at(iFirst);
		const middle = at(iMiddle);
		const last = at(iLast);
		const assembled = [first, middle, last].filter((p) => p.length > 0).join(" ");
		const displayName = at(iFull) || assembled;
		if (displayName.length === 0) continue;

		// A single cell can hold several values separated by " ::: ".
		const multi = (cols: number[]): string[] => {
			const seen = new Set<string>();
			for (const c of cols) {
				for (const part of at(c).split(":::")) {
					const v = part.trim();
					if (v.length > 0) seen.add(v);
				}
			}
			return [...seen];
		};

		const city = at(iCity);
		const region = at(iRegion);

		out.push({
			displayName,
			firstName: first || undefined,
			lastName: last || undefined,
			nickname: at(iNick) || undefined,
			emails: multi(emailCols),
			phones: multi(phoneCols),
			birthday: normalizeBirthday(at(iBirthday)),
			company: at(iCompany) || undefined,
			title: at(iTitle) || undefined,
			location: [city, region].filter((p) => p.length > 0).join(", ") || undefined,
			labels: at(iLabels)
				.split(":::")
				.map((l) => l.trim().replace(/^\*\s*/, ""))
				.filter((l) => l.length > 0 && !isSystemLabel(l)),
		});
	}

	return out;
}

// ---------------------------------------------------------------- vCard parsing

/** Unfold continuation lines, then read the properties we map. */
export function parseVCard(text: string): ExternalContact[] {
	const unfolded: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		if (/^[ \t]/.test(raw) && unfolded.length > 0) {
			unfolded[unfolded.length - 1] += raw.slice(1);
		} else {
			unfolded.push(raw);
		}
	}

	const out: ExternalContact[] = [];
	let current: ExternalContact | null = null;

	const unescape = (v: string): string =>
		v.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

	for (const line of unfolded) {
		const trimmed = line.trim();
		if (/^BEGIN:VCARD$/i.test(trimmed)) {
			current = {
				displayName: "",
				emails: [],
				phones: [],
				labels: [],
			};
			continue;
		}
		if (/^END:VCARD$/i.test(trimmed)) {
			if (current && current.displayName.length > 0) out.push(current);
			current = null;
			continue;
		}
		if (!current) continue;

		const sep = trimmed.indexOf(":");
		if (sep === -1) continue;
		const rawName = trimmed.slice(0, sep);
		const value = unescape(trimmed.slice(sep + 1).trim());
		if (value.length === 0) continue;

		// Strip any grouping prefix ("item1.EMAIL") and parameters.
		const name = rawName.split(";")[0].replace(/^[^.]*\./, "").toUpperCase();

		switch (name) {
			case "FN":
				current.displayName = value;
				break;
			case "N": {
				const [family, given, additional] = value.split(";");
				current.lastName = (family ?? "").trim() || undefined;
				current.firstName = (given ?? "").trim() || undefined;
				if (current.displayName.length === 0) {
					current.displayName = [given, additional, family]
						.map((p) => (p ?? "").trim())
						.filter((p) => p.length > 0)
						.join(" ");
				}
				break;
			}
			case "NICKNAME":
				current.nickname = value.split(",")[0].trim() || undefined;
				break;
			case "EMAIL":
				if (!current.emails.includes(value)) current.emails.push(value);
				break;
			case "TEL":
				if (!current.phones.includes(value)) current.phones.push(value);
				break;
			case "BDAY":
				current.birthday = normalizeBirthday(value);
				break;
			case "ORG":
				current.company = value.split(";")[0].trim() || undefined;
				break;
			case "TITLE":
				current.title = value;
				break;
			case "ADR": {
				// ADR is pobox;ext;street;locality;region;postal;country
				const parts = value.split(";").map((p) => p.trim());
				const loc = [parts[3], parts[4]].filter((p) => p && p.length > 0).join(", ");
				if (loc.length > 0) current.location = loc;
				break;
			}
			case "CATEGORIES":
				for (const label of value.split(",")) {
					const l = label.trim();
					if (l.length > 0 && !isSystemLabel(l)) current.labels.push(l);
				}
				break;
		}
	}

	return out;
}

/**
 * Google's own bookkeeping labels, which carry no meaning here. Spelling varies
 * across exports ("myContacts", "My Contacts", "* myContacts"), so compare on a
 * squashed form.
 */
function isSystemLabel(label: string): boolean {
	const squashed = label.toLowerCase().replace(/[^a-z]/g, "");
	return squashed === "mycontacts" || squashed === "starred" || squashed === "starredinandroid";
}

export function parseContactsFile(filename: string, text: string): ExternalContact[] {
	if (/\.vcf$|\.vcard$/i.test(filename) || /BEGIN:VCARD/i.test(text.slice(0, 200))) {
		return parseVCard(text);
	}
	return parseGoogleCsv(text);
}

function pad2(x: string): string {
	return x.length === 1 ? `0${x}` : x;
}

function validMonthDay(month: number, day: number): boolean {
	return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Google emits 1999-04-17, 19990417, or --04-17 when the year is unknown.
 *
 * Ambiguous slash forms are only accepted when the order is unmistakable
 * (a component above 12 can only be the day). Guessing month-first would turn a
 * UK export's 17/04/1999 into month 17, which then silently never displays.
 */
export function normalizeBirthday(value: string): string | undefined {
	const v = value.trim();
	if (v.length === 0) return undefined;

	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(v);
	if (m) {
		const month = Number(m[2]);
		const day = Number(m[3]);
		if (!validMonthDay(month, day)) return undefined;
		return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
	}

	m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
	if (m) {
		if (!validMonthDay(Number(m[2]), Number(m[3]))) return undefined;
		return `${m[1]}-${m[2]}-${m[3]}`;
	}

	m = /^--?-?(\d{2})-?(\d{2})$/.exec(v);
	if (m) {
		if (!validMonthDay(Number(m[1]), Number(m[2]))) return undefined;
		return `${m[1]}-${m[2]}`;
	}

	m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(v);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		// a>12 means day-first; b>12 means month-first. Otherwise unknowable.
		if (a > 12 && b <= 12) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
		if (b > 12 && a <= 12) return `${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
		return undefined;
	}

	return undefined;
}

// -------------------------------------------------------------------- matching

const HONORIFICS = new Set([
	"mr",
	"mrs",
	"ms",
	"miss",
	"dr",
	"prof",
	"professor",
	"sir",
	"madam",
	"rev",
	"fr",
	"sr",
	"jr",
	"ii",
	"iii",
	"iv",
	"phd",
	"md",
]);

/**
 * Fold a name for comparison: strip diacritics, punctuation and symbols, collapse
 * whitespace.
 *
 * Crucially this keeps Unicode letters rather than whitelisting `a-z`. The old
 * ASCII-only version reduced \u674e\u4f1f, \u0418\u0432\u0430\u043d \u041f\u0435\u0442\u0440\u043e\u0432 and \u0645\u062d\u0645\u062f \u0639\u0644\u064a to the empty string,
 * which made the importer silently inert for entire scripts.
 */
export function normalizeName(value: string): string {
	return value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[\p{P}\p{S}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Order-independent, honorific-free key, so "Rivera, Sam", "Sam Rivera" and
 * "Dr. Sam Rivera" all collapse to the same thing. vCard's own `N:` field is
 * family-name-first, so this is the common case, not an edge case.
 */
export function nameKey(value: string): string {
	const tokens = normalizeName(value)
		.split(" ")
		.filter((t) => t.length > 0 && !HONORIFICS.has(t));
	if (tokens.length === 0) return "";
	return tokens.sort().join(" ");
}

interface Lookup {
	byName: Map<string, string[]>;
	byKey: Map<string, string[]>;
	byAlias: Map<string, string[]>;
	byGivenName: Map<string, string[]>;
}

function buildLookup(people: PersonRecord[]): Lookup {
	const byName = new Map<string, string[]>();
	const byKey = new Map<string, string[]>();
	const byAlias = new Map<string, string[]>();
	const byGivenName = new Map<string, string[]>();

	const add = (map: Map<string, string[]>, key: string, path: string) => {
		if (key.length === 0) return;
		const list = map.get(key);
		if (list) {
			if (!list.includes(path)) list.push(path);
		} else {
			map.set(key, [path]);
		}
	};

	for (const person of people) {
		const name = normalizeName(person.name);
		add(byName, name, person.path);
		add(byKey, nameKey(person.name), person.path);
		for (const alias of person.aliases) {
			add(byAlias, normalizeName(alias), person.path);
			add(byAlias, nameKey(alias), person.path);
		}

		// Notes titled with only a first name ("Sam") are common, so index the
		// leading token separately — but as a weaker signal.
		const tokens = name.split(" ");
		if (tokens.length === 1) add(byGivenName, tokens[0], person.path);
	}

	return { byName, byKey, byAlias, byGivenName };
}

export function matchContacts(
	contacts: ExternalContact[],
	people: PersonRecord[],
	existingFrontmatter: (path: string) => Record<string, unknown>,
	options: ImportOptions,
): MatchReport {
	const lookup = buildLookup(people);
	const byPath = new Map(people.map((p) => [p.path, p]));

	const plans: PersonPlan[] = [];
	const ambiguous: MatchReport["ambiguous"] = [];
	const unmatched: ExternalContact[] = [];
	let unchanged = 0;
	const claimed = new Set<string>();

	for (const contact of contacts) {
		const full = normalizeName(contact.displayName);
		const key = nameKey(contact.displayName);
		const nick = contact.nickname ? normalizeName(contact.nickname) : "";
		const given = contact.firstName ? normalizeName(contact.firstName) : full.split(" ")[0];
		// A contact may only have structured name parts and no display name. Requires
		// *both* parts: reconstructing from a first name alone would quietly do
		// given-name matching, which is deliberately opt-in below.
		const assembledKey =
			contact.firstName && contact.lastName
				? nameKey(`${contact.firstName} ${contact.lastName}`)
				: "";

		let candidates: string[] | undefined;
		let confidence: MatchConfidence = "exact";

		if (lookup.byName.has(full)) {
			candidates = lookup.byName.get(full);
			confidence = "exact";
		} else if (key && lookup.byKey.has(key)) {
			// Same tokens in a different order, or with an honorific: "Rivera, Sam".
			candidates = lookup.byKey.get(key);
			confidence = "normalized";
		} else if (assembledKey && lookup.byKey.has(assembledKey)) {
			candidates = lookup.byKey.get(assembledKey);
			confidence = "normalized";
		} else if (nick && lookup.byName.has(nick)) {
			candidates = lookup.byName.get(nick);
			confidence = "normalized";
		} else if (lookup.byAlias.has(full) || (key && lookup.byAlias.has(key))) {
			candidates = lookup.byAlias.get(full) ?? lookup.byAlias.get(key);
			confidence = "alias";
		} else if (nick && lookup.byAlias.has(nick)) {
			candidates = lookup.byAlias.get(nick);
			confidence = "alias";
		} else if (options.includeGivenNameMatches && lookup.byGivenName.has(given)) {
			candidates = lookup.byGivenName.get(given);
			confidence = "given-name";
		}

		if (!candidates || candidates.length === 0) {
			unmatched.push(contact);
			continue;
		}
		if (candidates.length > 1) {
			ambiguous.push({
				contact,
				candidates: candidates.map((p) => byPath.get(p)?.name ?? p),
			});
			continue;
		}

		const personPath = candidates[0];
		// Two contacts pointing at the same note would fight over fields.
		if (claimed.has(personPath)) {
			ambiguous.push({
				contact,
				candidates: [byPath.get(personPath)?.name ?? personPath],
			});
			continue;
		}

		const changes = planChanges(contact, existingFrontmatter(personPath), options);
		if (changes.length === 0) {
			unchanged++;
			continue;
		}

		claimed.add(personPath);
		plans.push({
			personPath,
			personName: byPath.get(personPath)?.name ?? personPath,
			contact,
			confidence,
			changes,
		});
	}

	plans.sort((a, b) => a.personName.localeCompare(b.personName));
	return { plans, ambiguous, unmatched, unchanged };
}

export function asDisplay(value: unknown): string | null {
	if (value == null) return null;
	if (Array.isArray(value)) {
		const joined = value
			.map((v) => asText(v))
			.filter((v): v is string => v !== null && v.length > 0);
		return joined.length > 0 ? joined.join(", ") : null;
	}
	const s = asText(value)?.trim();
	return s !== undefined && s.length > 0 ? s : null;
}

/**
 * Work out which frontmatter keys this contact would change. Existing values are
 * left alone unless `overwriteExisting` is set — notes you wrote by hand win over
 * an address book by default.
 */
export function planChanges(
	contact: ExternalContact,
	existing: Record<string, unknown>,
	options: ImportOptions,
): PlannedChange[] {
	const changes: PlannedChange[] = [];

	const propose = (key: string, value: string | string[] | undefined) => {
		if (value === undefined) return;
		if (Array.isArray(value) && value.length === 0) return;

		const next = Array.isArray(value) && value.length === 1 ? value[0] : value;
		const currentRaw = existing[key];
		const current = asDisplay(currentRaw);
		const nextDisplay = asDisplay(next);

		if (nextDisplay === null) return;
		if (current !== null && !options.overwriteExisting) return;
		if (current === nextDisplay) return;

		changes.push({ key, from: current, to: next });
	};

	propose("email", contact.emails);
	propose("phone", contact.phones);
	propose("company", contact.company);
	propose("title", contact.title);
	propose("location", contact.location);
	propose("prm-birthday", contact.birthday);
	// Google labels are usually how you already group people ("Brown", "Interns"),
	// which is exactly what prm-relationship is for.
	propose("prm-relationship", contact.labels.length > 0 ? contact.labels.join(", ") : undefined);

	// Aliases are merged, never replaced: they drive link resolution, so dropping
	// one would silently break existing [[links]].
	if (options.nicknamesAsAliases && contact.nickname) {
		const nickname = contact.nickname.trim();
		// Write back to whichever key the note already uses, or we'd end up with
		// both `alias:` and `aliases:` holding overlapping values.
		const aliasKey = existing["aliases"] !== undefined
			? "aliases"
			: existing["alias"] !== undefined
				? "alias"
				: "aliases";
		const currentRaw = existing[aliasKey];
		const current = Array.isArray(currentRaw)
			? currentRaw.map((v) => asText(v)).filter((v): v is string => v !== null)
			: ((): string[] => {
					const one = asText(currentRaw);
					return one === null ? [] : [one];
				})();
		const already = current.some((a) => normalizeName(a) === normalizeName(nickname));
		if (!already && normalizeName(nickname).length > 0) {
			changes.push({
				key: aliasKey,
				from: current.length > 0 ? current.join(", ") : null,
				to: [...current, nickname],
			});
		}
	}

	return changes;
}
