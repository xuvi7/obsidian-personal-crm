import {
	App,
	Component,
	FuzzySuggestModal,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
	Setting,
	SuggestModal,
	TFile,
	setIcon,
} from "obsidian";
import type PrmPlugin from "./main";
import { tierById } from "./settings";
import type { LoopRef, PersonRecord, Tier } from "./types";
import { addDays, formatDuration, isISODate, relativeToToday, todayISO } from "./dates";
import { trailingMonths } from "./calendar";
import { loopFile, readLoops } from "./loops";

/**
 * Reduce a person note to the part worth reading in a preview.
 *
 * Strips frontmatter, leading inline fields (`up::`, `parent::`, Breadcrumbs),
 * unrendered template syntax, and sections that turn out to be empty once those
 * are gone. A note straight from a template is mostly placeholder — showing it
 * verbatim fills the preview with nothing.
 */
export interface PreviewContent {
	/** The markdown worth showing. Empty when the note is all placeholder. */
	text: string;
	/** Names of sections that exist but hold nothing, for the empty state. */
	emptySections: string[];
}

export function previewBody(markdown: string): PreviewContent {
	let body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	// Only leading field lines: a `::` deeper in the note is probably real prose.
	body = body.replace(/^(?:\s*[A-Za-z][\w -]*::.*(?:\r?\n|$))+/, "");
	// Templater / placeholder syntax that was never filled in.
	body = body.replace(/<%[\s\S]*?%>/g, "").replace(/\{\{[^{}]*\}\}/g, "");
	// A bullet that is only a label with no value, e.g. "- First met:".
	body = body.replace(/^[ \t]*[-*+]\s*[^:\n]{1,40}:[ \t]*$/gm, "");

	const { kept, empty } = dropEmptySections(body);
	return {
		text: kept.replace(/\n{3,}/g, "\n\n").trim(),
		emptySections: empty,
	};
}

/**
 * Drop headings that hold nothing themselves.
 *
 * A heading is judged on its *direct* content — the scan stops at the next
 * heading of any level, not just the same or higher. Otherwise a deeper section's
 * content counts for its parent, so appending a `## Contact log` under an empty
 * `# Thoughts` would resurrect the empty heading.
 */
function dropEmptySections(markdown: string): { kept: string; empty: string[] } {
	const lines = markdown.split(/\r?\n/);
	const keep: string[] = [];
	const empty: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (!heading) {
			keep.push(lines[i]);
			continue;
		}

		let hasContent = false;
		for (let j = i + 1; j < lines.length; j++) {
			if (/^#{1,6}\s+/.test(lines[j])) break;
			if (lines[j].replace(/^[ \t]*[-*+]\s*/, "").trim().length > 0) {
				hasContent = true;
				break;
			}
		}

		if (hasContent) keep.push(lines[i]);
		else {
			const name = heading[2].trim();
			if (name.length > 0) empty.push(name);
		}
	}

	return { kept: keep.join("\n"), empty };
}

/** "Facts", "Facts and Thoughts", "Facts, Thoughts and Log". */
function listNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Render a note into a bounded, scrollable box.
 *
 * The rendered markdown goes in a child rather than the scroll container itself:
 * Obsidian's own `markdown-rendered` styles apply to that child, so they can't
 * interfere with the container's height cap. Previously the container carried both
 * roles and grew to the full height of the file, pushing the modal's buttons out
 * of reach and making only the top of the note visible.
 */
async function renderNotePreview(
	app: App,
	scroller: HTMLElement,
	file: TFile,
	component: Component,
): Promise<void> {
	scroller.empty();
	const raw = await app.vault.cachedRead(file);
	const { text, emptySections } = previewBody(raw);

	if (text.length === 0) {
		// Say *why* it's empty. The file usually isn't blank — it has the template's
		// headings — so "nothing written" on its own reads as though the preview is
		// broken rather than the note being unfilled.
		scroller.createEl("p", {
			cls: "prm-preview-empty",
			text:
				emptySections.length > 0
					? `Nothing written down yet — ${listNames(emptySections)} ${
							emptySections.length === 1 ? "is" : "are"
						} empty.`
					: "This note is empty.",
		});
		return;
	}

	const rendered = scroller.createDiv({ cls: "prm-preview-body markdown-rendered" });
	await MarkdownRenderer.render(app, text, rendered, file.path, component);
}

function lastContactLabel(record: PersonRecord): string {
	if (!record.lastContact) return "no contact on record";
	return `last contact ${relativeToToday(record.lastContact)}`;
}

function renderTierChip(el: HTMLElement, tier: Tier | null): void {
	const chip = el.createSpan({ cls: "prm-chip", text: tier ? tier.label : "unclassified" });
	if (tier) chip.style.setProperty("--prm-chip-color", tier.color);
	else chip.addClass("prm-chip-muted");
}

/**
 * True when a keystroke is going into a text field. Modal-wide shortcuts have to
 * stand aside for these, or arrow keys move between people instead of moving the
 * caret.
 */
function isTyping(evt: KeyboardEvent): boolean {
	const target = evt.target;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return true;
	return target instanceof HTMLElement && target.isContentEditable;
}

interface NoteEditorOptions {
	label: string;
	hint?: string;
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	/** Cmd/Ctrl+Enter, so a long note can be committed without reaching for the mouse. */
	onSubmit?: () => void;
}

/** A full-width, resizable note box. */
function noteEditor(parent: HTMLElement, opts: NoteEditorOptions): HTMLTextAreaElement {
	const field = parent.createDiv({ cls: "prm-note-field" });
	field.createEl("label", { cls: "prm-note-label", text: opts.label });
	if (opts.hint) field.createDiv({ cls: "prm-note-hint", text: opts.hint });

	const input = field.createEl("textarea", {
		cls: "prm-note-input",
		attr: { rows: "5", placeholder: opts.placeholder, spellcheck: "true" },
	});
	input.value = opts.value;
	input.addEventListener("input", () => opts.onChange(input.value));
	input.addEventListener("keydown", (evt) => {
		if (opts.onSubmit && evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
			evt.preventDefault();
			opts.onSubmit();
		}
	});
	return input;
}

/**
 * A labelled date input.
 *
 * Not a `Setting` row. Setting carries its own vertical padding and pushes its
 * control into a narrow right-hand column, which left a gap between the date and
 * the notes box and made the date field conspicuously smaller than everything
 * around it. This matches noteEditor's markup so the two read as one form.
 */
function dateEditor(
	parent: HTMLElement,
	opts: { label: string; value: string; onChange: (value: string) => void },
): HTMLInputElement {
	const field = parent.createDiv({ cls: "prm-note-field prm-date-field" });
	field.createEl("label", { cls: "prm-note-label", text: opts.label });
	const input = field.createEl("input", {
		cls: "prm-date-input",
		attr: { type: "date" },
	});
	input.value = opts.value;
	input.addEventListener("input", () => opts.onChange(input.value.trim()));
	// A date picker commits on change, not on every keystroke of typing.
	input.addEventListener("change", () => opts.onChange(input.value.trim()));
	return input;
}

// ---------------------------------------------------------------- person picker

export class PersonPickerModal extends FuzzySuggestModal<PersonRecord> {
	constructor(
		private plugin: PrmPlugin,
		private records: PersonRecord[],
		private onChoose: (record: PersonRecord) => void,
		placeholder = "Search people…",
	) {
		super(plugin.app);
		this.setPlaceholder(placeholder);
	}

	getItems(): PersonRecord[] {
		return [...this.records].sort((a, b) => a.name.localeCompare(b.name));
	}

	getItemText(item: PersonRecord): string {
		return [item.name, ...item.aliases, item.relationship ?? ""].join(" ");
	}

	onChooseItem(item: PersonRecord): void {
		this.onChoose(item);
	}
}

// ------------------------------------------------------------------ tier picker

type TierChoice =
	| { kind: "tier"; tier: Tier }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "unpause" }
	| { kind: "cadence" };

export class TierPickerModal extends SuggestModal<TierChoice> {
	constructor(
		private plugin: PrmPlugin,
		private record: PersonRecord,
		private onDone?: () => void,
	) {
		super(plugin.app);
		this.setPlaceholder(`How often do you want to be in touch with ${record.name}?`);
	}

	getSuggestions(query: string): TierChoice[] {
		const choices: TierChoice[] = this.plugin.settings.tiers.map((tier) => ({
			kind: "tier" as const,
			tier,
		}));
		choices.push({ kind: "cadence" });
		if (this.record.tierId || this.record.cadenceOverride) choices.push({ kind: "clear" });
		choices.push(this.record.paused ? { kind: "unpause" } : { kind: "pause" });

		const q = query.toLowerCase().trim();
		if (!q) return choices;
		return choices.filter((c) => this.label(c).toLowerCase().includes(q));
	}

	private label(choice: TierChoice): string {
		switch (choice.kind) {
			case "tier":
				return `${choice.tier.label} — every ${formatDuration(choice.tier.cadenceDays)}`;
			case "cadence":
				return "Custom cadence…";
			case "clear":
				return "Clear tier (stop tracking)";
			case "pause":
				return "Never track this person";
			case "unpause":
				return "Resume this person";
		}
	}

	renderSuggestion(choice: TierChoice, el: HTMLElement): void {
		el.addClass("prm-suggestion");
		if (choice.kind === "tier") {
			const dot = el.createSpan({ cls: "prm-dot" });
			dot.style.setProperty("--prm-chip-color", choice.tier.color);
			el.createSpan({ text: choice.tier.label, cls: "prm-suggestion-title" });
			el.createSpan({
				text: `every ${formatDuration(choice.tier.cadenceDays)}`,
				cls: "prm-suggestion-aux",
			});
			return;
		}
		el.createSpan({ text: this.label(choice), cls: "prm-suggestion-title" });
	}

	// SuggestModal declares this as returning void, so the async work is detached
	// rather than making the override promise-returning.
	onChooseSuggestion(choice: TierChoice): void {
		void this.apply(choice);
	}

	private async apply(choice: TierChoice): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.record.path);
		if (!(file instanceof TFile)) return;

		switch (choice.kind) {
			case "tier":
				await this.plugin.setTier(file, choice.tier.id);
				break;
			case "clear":
				await this.plugin.setTier(file, null);
				break;
			case "pause":
				await this.plugin.setPaused(file, true);
				break;
			case "unpause":
				await this.plugin.setPaused(file, false);
				break;
			case "cadence":
				new PromptModal(
					this.app,
					`Contact ${this.record.name} every how many days?`,
					this.record.cadenceDays ? String(this.record.cadenceDays) : "30",
					async (value) => {
						const n = Number(value);
						if (!Number.isFinite(n) || n < 1) {
							new Notice("Enter a positive number of days.");
							return;
						}
						await this.plugin.setCadence(file, Math.round(n));
					},
				).open();
				break;
		}
		this.onDone?.();
	}
}

// -------------------------------------------------------- bulk tier / tag pickers

type BulkTier = { kind: "tier"; tier: Tier } | { kind: "clear" };

/** Choose one cadence to apply to a whole selection. */
export class TierChooserModal extends SuggestModal<BulkTier> {
	constructor(
		private plugin: PrmPlugin,
		count: number,
		private onPick: (tierId: string | null) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(
			`How often do you want to be in touch with these ${count} people?`,
		);
	}

	getSuggestions(query: string): BulkTier[] {
		const choices: BulkTier[] = this.plugin.settings.tiers.map((tier) => ({
			kind: "tier" as const,
			tier,
		}));
		choices.push({ kind: "clear" });
		const q = query.toLowerCase().trim();
		if (!q) return choices;
		return choices.filter((c) =>
			(c.kind === "tier" ? c.tier.label : "clear tier").toLowerCase().includes(q),
		);
	}

	renderSuggestion(choice: BulkTier, el: HTMLElement): void {
		el.addClass("prm-suggestion");
		if (choice.kind === "clear") {
			el.createSpan({ text: "Clear tier (stop tracking)", cls: "prm-suggestion-title" });
			return;
		}
		const dot = el.createSpan({ cls: "prm-dot" });
		dot.style.setProperty("--prm-chip-color", choice.tier.color);
		el.createSpan({ text: choice.tier.label, cls: "prm-suggestion-title" });
		el.createSpan({
			text: `every ${formatDuration(choice.tier.cadenceDays)}`,
			cls: "prm-suggestion-aux",
		});
	}

	onChooseSuggestion(choice: BulkTier): void {
		this.onPick(choice.kind === "clear" ? null : choice.tier.id);
	}
}

interface TagChoice {
	tag: string;
	/** True when this is the query itself rather than an existing tag. */
	isNew: boolean;
}

/**
 * Pick an existing tag or type a new one.
 *
 * Existing tags come first and are ordered by how many people already carry them,
 * which is what makes a large tag list usable.
 */
export class TagPickerModal extends SuggestModal<TagChoice> {
	constructor(
		private plugin: PrmPlugin,
		private mode: "add" | "remove",
		private choices: string[],
		private onPick: (tag: string) => void,
	) {
		super(plugin.app);
		this.setPlaceholder(
			mode === "add" ? "Tag them with… (type to create)" : "Remove which tag?",
		);
	}

	getSuggestions(query: string): TagChoice[] {
		const q = query.trim().replace(/^#/, "");
		const matches = this.choices
			.filter((tag) => tag.toLowerCase().includes(q.toLowerCase()))
			.map((tag) => ({ tag, isNew: false }));

		if (this.mode === "remove" || q.length === 0) return matches;
		const exact = matches.some((m) => m.tag.toLowerCase() === q.toLowerCase());
		return exact ? matches : [...matches, { tag: q, isNew: true }];
	}

	renderSuggestion(choice: TagChoice, el: HTMLElement): void {
		el.addClass("prm-suggestion");
		el.createSpan({ text: `#${choice.tag}`, cls: "prm-suggestion-title" });
		if (choice.isNew) el.createSpan({ text: "new tag", cls: "prm-suggestion-aux" });
	}

	onChooseSuggestion(choice: TagChoice): void {
		this.onPick(choice.tag);
	}
}

// ------------------------------------------------------------------ place picker

interface PlaceChoice {
	place: string;
	count: number;
	isNew?: boolean;
	clears?: boolean;
}

/**
 * Pick a place to see who's there.
 *
 * Locations are free text and spelled however the vault spells them ("NYC" and
 * "New York" are different places here), so the list is what's actually written
 * down rather than anything canonicalised — and matching is a substring, so "NY"
 * finds "Brooklyn, NY".
 */
export class PlacePickerModal extends SuggestModal<PlaceChoice> {
	private choices: PlaceChoice[];

	/**
	 * @param mode "show" lists places that exist; "set" also offers whatever the
	 *   user types, plus a way to clear the field.
	 */
	constructor(
		private plugin: PrmPlugin,
		private onPick: (place: string) => void,
		private mode: "show" | "set" = "show",
	) {
		super(plugin.app);
		this.setPlaceholder(mode === "show" ? "Who's in…" : "Set place to… (type to add)");
		this.choices = plugin.engine.allLocations();
	}

	getSuggestions(query: string): PlaceChoice[] {
		const raw = query.trim().replace(/^@/, "");
		const q = raw.toLowerCase();
		const matches =
			q.length === 0 ? this.choices : this.choices.filter((c) => c.place.toLowerCase().includes(q));
		if (this.mode === "show") return matches;

		const out = [...matches];
		if (q.length > 0 && !matches.some((m) => m.place.toLowerCase() === q)) {
			out.push({ place: raw, count: 0, isNew: true });
		}
		out.push({ place: "", count: 0, clears: true });
		return out;
	}

	renderSuggestion(choice: PlaceChoice, el: HTMLElement): void {
		el.addClass("prm-suggestion");
		if (choice.clears) {
			el.createSpan({ text: "Clear the place", cls: "prm-suggestion-title" });
			return;
		}
		el.createSpan({ text: choice.place, cls: "prm-suggestion-title" });
		el.createSpan({
			text: choice.isNew
				? "new place"
				: `${choice.count} ${choice.count === 1 ? "person" : "people"}`,
			cls: "prm-suggestion-aux",
		});
	}

	onChooseSuggestion(choice: PlaceChoice): void {
		this.onPick(choice.place);
	}

	onNoSuggestion(): void {
		this.emptyStateText =
			this.choices.length === 0
				? "No locations recorded yet. Add prm-location: Lisbon to a person's note."
				: "Nobody recorded there.";
	}
}

// ----------------------------------------------------------------- snooze modal

interface SnoozeChoice {
	label: string;
	days: number;
}

export class SnoozeModal extends SuggestModal<SnoozeChoice> {
	private chose = false;

	private static readonly CHOICES: SnoozeChoice[] = [
		{ label: "3 days", days: 3 },
		{ label: "1 week", days: 7 },
		{ label: "2 weeks", days: 14 },
		{ label: "1 month", days: 30 },
		{ label: "3 months", days: 90 },
	];

	constructor(
		private plugin: PrmPlugin,
		private record: PersonRecord,
		/**
		 * Called with whether a choice was made, and the date chosen. Callers must not
		 * advance on Escape, and the bulk path needs the date without the write.
		 */
		private onDone?: (chosen: boolean, until?: string) => void,
		/** When set, the modal reports the choice instead of writing it itself. */
		private reportOnly = false,
	) {
		super(plugin.app);
		this.setPlaceholder(`Hide ${record.name} from the queue for…`);
	}

	getSuggestions(query: string): SnoozeChoice[] {
		const q = query.toLowerCase().trim();
		return SnoozeModal.CHOICES.filter((c) => c.label.toLowerCase().includes(q));
	}

	renderSuggestion(choice: SnoozeChoice, el: HTMLElement): void {
		el.addClass("prm-suggestion");
		el.createSpan({ text: choice.label, cls: "prm-suggestion-title" });
		el.createSpan({
			text: `until ${addDays(todayISO(), choice.days)}`,
			cls: "prm-suggestion-aux",
		});
	}

	onChooseSuggestion(choice: SnoozeChoice): void {
		this.chose = true;
		void this.apply(choice);
	}

	private async apply(choice: SnoozeChoice): Promise<void> {
		const until = addDays(todayISO(), choice.days);
		if (this.reportOnly) {
			this.onDone?.(true, until);
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(this.record.path);
		if (file instanceof TFile) await this.plugin.snooze(file, until);
		this.onDone?.(true, until);
	}

	onClose(): void {
		if (!this.chose) this.onDone?.(false);
	}
}

// ----------------------------------------------------------- create person modal

/**
 * Add a person, with their cadence set in the same step.
 *
 * Asking for the tier here matters: a person with no tier isn't tracked, so
 * creating one without it would quietly produce someone the plugin ignores.
 */
export class CreatePersonModal extends Modal {
	private name = "";
	private tierId: string;
	private createButton: HTMLButtonElement | null = null;
	private error: HTMLElement | null = null;

	constructor(
		private plugin: PrmPlugin,
		private onCreated?: (file: TFile) => void,
	) {
		super(plugin.app);
		this.tierId = plugin.settings.newPersonTier;
	}

	onOpen(): void {
		this.titleEl.setText("Add a person");
		const { contentEl } = this;
		contentEl.addClass("prm-log-modal");

		const folder = this.plugin.newPersonFolder();
		contentEl.createEl("p", {
			cls: "prm-muted",
			text: folder.length > 0 ? `A new note in ${folder}.` : "A new note in the vault root.",
		});

		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("Their name").onChange((v) => {
				this.name = v;
				this.validate();
			});
			t.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					void this.submit();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
			return t;
		});

		this.error = contentEl.createDiv({ cls: "prm-form-error" });

		new Setting(contentEl)
			.setName("Contact every")
			.setDesc("Nobody is tracked without a tier.")
			.addDropdown((d) => {
				d.addOption("", "Not yet — leave unclassified");
				for (const tier of this.plugin.settings.tiers) {
					d.addOption(tier.id, `${tier.label} — every ${formatDuration(tier.cadenceDays)}`);
				}
				d.setValue(this.tierId).onChange((v) => (this.tierId = v));
				return d;
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Create").setCta().onClick(() => void this.submit());
				this.createButton = b.buttonEl;
				return b;
			});

		this.validate();
	}

	private validate(): void {
		const ok = this.name.trim().length > 0;
		if (this.createButton) this.createButton.disabled = !ok;
		if (this.error) this.error.setText("");
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();
		if (name.length === 0) return;
		this.close();
		const result = await this.plugin.createPerson(name, {
			tierId: this.tierId,
			open: true,
		});
		if (result) this.onCreated?.(result.file);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------- confirm modal

/**
 * A destructive-action confirmation. Native `window.confirm` blocks the whole
 * app and looks nothing like Obsidian, so this replaces it.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.body });

		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmLabel)
					.setDestructive()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ----------------------------------------------------------------- prompt modal

export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private title: string,
		initial: string,
		private onSubmit: (value: string) => void | Promise<void>,
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		const { contentEl } = this;

		new Setting(contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.addClass("prm-prompt-input");
			window.setTimeout(() => {
				t.inputEl.focus();
				t.inputEl.select();
			}, 0);
			t.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
			return t;
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));
	}

	private submit(): void {
		const value = this.value;
		this.close();
		void this.onSubmit(value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// -------------------------------------------------------------- log contact modal

export class LogContactModal extends Modal {
	private date = todayISO();
	private note = "";
	private saveButton: HTMLButtonElement | null = null;
	private error: HTMLElement | null = null;

	/**
	 * @param bulk When set, the modal collects a date and note for a whole
	 *   selection and hands them back instead of writing one person's note, so
	 *   bulk logging gets the same notes box as logging one person.
	 */
	constructor(
		private plugin: PrmPlugin,
		private record: PersonRecord | null,
		private bulk?: { count: number; onSubmit: (date: string, note?: string) => void },
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText(
			this.bulk
				? `Log contact with ${this.bulk.count} ${this.bulk.count === 1 ? "person" : "people"}`
				: `Log contact with ${this.record?.name ?? "person"}`,
		);
		const { contentEl } = this;
		contentEl.addClass("prm-log-modal");

		if (this.record) {
			contentEl.createEl("p", { cls: "prm-muted", text: lastContactLabel(this.record) });
		}

		dateEditor(contentEl, {
			label: "Date",
			value: this.date,
			onChange: (v) => {
				this.date = v;
				this.validate();
			},
		});

		this.error = contentEl.createDiv({ cls: "prm-form-error" });

		// Full width and multi-line rather than a Setting's narrow control column,
		// so there's room to actually write and re-read what you wrote.
		const noteField = noteEditor(contentEl, {
			label: "Notes",
			hint: "Optional. Written under the log entry, keeping your line breaks.",
			placeholder: "What did you talk about?",
			value: "",
			onChange: (v) => (this.note = v),
			onSubmit: () => void this.submit(),
		});
		window.setTimeout(() => noteField.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Log it")
					.setCta()
					.onClick(() => void this.submit());
				this.saveButton = b.buttonEl;
				return b;
			});

		this.validate();
	}

	private async submit(): Promise<void> {
		if (!isISODate(this.date)) return;
		if (this.bulk) {
			const { onSubmit } = this.bulk;
			this.close();
			onSubmit(this.date, this.note.trim() || undefined);
			return;
		}
		if (!this.record) return;
		const file = this.app.vault.getAbstractFileByPath(this.record.path);
		this.close();
		if (file instanceof TFile) {
			await this.plugin.logContact(file, this.date, this.note.trim() || undefined);
		}
	}

	/** Clearing a date input yields "", which would otherwise wipe the stored date. */
	private validate(): void {
		const valid = isISODate(this.date);
		if (this.saveButton) this.saveButton.disabled = !valid;
		if (this.error) {
			this.error.setText(
				valid ? "" : this.date.length === 0 ? "Pick a date." : "Not a valid date.",
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------ person actions

/**
 * Everything you can do to one person, in one place.
 *
 * A plain click on a dashboard row lands here. The row's icon buttons stay for
 * the fast path, but they can't show the note's own content, and having to
 * remember which small icon does what is the thing that makes a row feel opaque.
 */
export class PersonActionsModal extends Modal {
	private date = todayISO();
	private note = "";
	private preview: Component | null = null;
	private busy = false;
	private errorEl: HTMLElement | null = null;
	private logButton: HTMLButtonElement | null = null;
	/** Follow-ups ticked off while this panel has been open, kept so they stay
	 *  on screen and can be un-ticked. The index drops them immediately. */
	private completed: LoopRef[] = [];
	/** Focus the notes box on the first render only, not on every refresh. */
	private focused = false;
	/**
	 * The half-typed follow-up.
	 *
	 * Held here rather than only in the input, because the panel redraws on every
	 * index change — i.e. after any write anywhere in the vault, including its own —
	 * and `contentEl.empty()` took the typed text with it.
	 */
	private draft = "";
	private unsubscribe: (() => void) | null = null;

	constructor(
		private plugin: PrmPlugin,
		private record: PersonRecord,
	) {
		super(plugin.app);
		this.modalEl.addClass("prm-reachout-modal");
	}

	onOpen(): void {
		// Obsidian's metadata cache updates asynchronously after a write, so the
		// rebuild that follows one can briefly see a note without its frontmatter —
		// which rendered as "unclassified" here and stayed that way, because the
		// panel only drew once. Redraw when the index settles.
		this.unsubscribe = this.plugin.engine.onChange(() => this.render());
		this.render();
	}

	private render(): void {
		const { contentEl } = this;

		// A redraw replaces every element, so focus lands on <body> and the caret
		// jumps. Remembered by class rather than by node, since the node is about to
		// be discarded.
		// `activeDocument`, not `document`: Obsidian pops leaves out into their own
		// window, and the modal may be living in one.
		const active = activeDocument?.activeElement ?? null;
		const refocus =
			active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
				? {
						cls: active.className,
						start: active.selectionStart,
						end: active.selectionEnd,
					}
				: null;

		contentEl.empty();

		// Replaced per render so the previous rendered subtree is released. This panel
		// redraws on every index change, i.e. after every write anywhere in the vault,
		// so reusing one Component leaked a rendered preview per redraw. Its siblings
		// ReachOutModal and TriageModal already did this.
		this.preview?.unload();
		this.preview = new Component();
		this.preview.load();

		// The record can go stale while the modal is open — a log from here
		// rewrites it — so read the live one each render.
		const record = this.plugin.engine.get(this.record.path) ?? this.record;
		this.record = record;
		const tier = tierById(this.plugin.settings, record.tierId);

		this.titleEl.setText(record.name);

		const header = contentEl.createDiv({ cls: "prm-reachout-header prm-panel-header" });
		const info = header.createDiv({ cls: "prm-panel-info" });
		const nameRow = info.createDiv({ cls: "prm-reachout-namerow" });
		renderTierChip(nameRow, tier);
		if (record.status === "overdue") {
			nameRow.createSpan({
				cls: "prm-chip prm-chip-overdue",
				text:
					record.overdueDays === 0
						? "due today"
						: `overdue ${formatDuration(record.overdueDays)}`,
			});
		} else if (record.status === "due-soon") {
			nameRow.createSpan({
				cls: "prm-chip prm-chip-soon",
				text: `due in ${formatDuration(record.overdueDays)}`,
			});
		} else if (record.status === "snoozed" && record.snoozeUntil) {
			nameRow.createSpan({
				cls: "prm-chip prm-chip-muted",
				text: `snoozed to ${record.snoozeUntil}`,
			});
		}
		if (record.drifting) {
			nameRow.createSpan({ cls: "prm-chip prm-chip-drift", text: "drifting" });
		}
		for (const tag of record.tags) {
			nameRow.createSpan({ cls: "prm-chip prm-chip-muted", text: `#${tag}` });
		}

		const meta = info.createDiv({ cls: "prm-reachout-meta" });
		meta.createSpan({ text: lastContactLabel(record) });
		// Their actual rhythm, which is the thing the "drifting" chip is measured
		// against — and often disagrees with the cadence you assigned.
		if (record.typicalGapDays !== null) {
			meta.createSpan({ text: `usually every ${formatDuration(record.typicalGapDays)}` });
		}
		if (record.mentionCount > 0) {
			meta.createSpan({ text: `${record.mentionCount} mentions` });
		}
		if (record.relationship) meta.createSpan({ text: record.relationship });
		if (record.location) meta.createSpan({ cls: "prm-place", text: record.location });

		this.renderThumb(header, record);

		const previewEl = contentEl.createDiv({ cls: "prm-preview prm-preview-fit" });
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (file instanceof TFile && this.preview) {
			void renderNotePreview(this.app, previewEl, file, this.preview);
		}

		this.renderLoops(contentEl.createDiv({ cls: "prm-loops" }), record);

		dateEditor(contentEl, {
			label: "Date",
			value: this.date,
			onChange: (v) => {
				this.date = v;
				this.validate();
			},
		});

		this.errorEl = contentEl.createDiv({ cls: "prm-form-error" });

		const noteField = noteEditor(contentEl, {
			label: "Notes",
			hint: "Optional. Written under the log entry, keeping your line breaks.",
			placeholder: "What did you talk about?",
			value: this.note,
			onChange: (v) => (this.note = v),
			onSubmit: () => void this.logIt(),
		});
		// Only on the first draw. A redraw restores whatever had focus instead, via
		// restoreFocus below, so it neither steals focus nor loses the caret.
		if (!this.focused) {
			this.focused = true;
			window.setTimeout(() => noteField.focus(), 0);
		}

		// Logging is the reason the panel is open; the rest are one click away.
		const primary = contentEl.createDiv({ cls: "prm-reachout-actions" });
		const log = primary.createEl("button", { cls: "prm-action-btn mod-cta" });
		setIcon(log.createSpan({ cls: "prm-action-icon" }), "check");
		log.createSpan({ text: "Log contact" });
		log.onclick = () => void this.logIt();
		this.logButton = log;

		this.actionButton(primary, "gauge", "Set cadence", () => {
			new TierPickerModal(this.plugin, record).open();
			this.close();
		});
		this.actionButton(primary, "alarm-clock", "Snooze", () => {
			new SnoozeModal(this.plugin, record).open();
			this.close();
		});
		this.actionButton(primary, "tag", "Tags", () => {
			new TagPickerModal(this.plugin, "add", this.plugin.engine.allTags(), (tag) => {
				void this.plugin.bulkTag([record.path], tag, true);
			}).open();
			this.close();
		});
		this.actionButton(primary, "map-pin", "Place", () => {
			new PlacePickerModal(
				this.plugin,
				(place) => void this.plugin.bulkSetLocation([record.path], place),
				"set",
			).open();
			this.close();
		});
		this.actionButton(primary, "file-text", "Open note", () => {
			void this.plugin.openPerson(record);
			this.close();
		});

		this.validate();
		this.restoreFocus(refocus);
	}

	/** Put the caret back where the redraw found it. */
	private restoreFocus(
		refocus: { cls: string; start: number | null; end: number | null } | null,
	): void {
		if (!refocus) return;
		const selector = refocus.cls
			.split(/\s+/)
			.filter(Boolean)
			.map((c) => `.${CSS.escape(c)}`)
			.join("");
		if (selector.length === 0) return;
		const next = this.contentEl.querySelector(selector);
		if (!(next instanceof HTMLInputElement) && !(next instanceof HTMLTextAreaElement)) return;
		next.focus();
		if (refocus.start !== null && refocus.end !== null) {
			try {
				next.setSelectionRange(refocus.start, refocus.end);
			} catch {
				// A date input doesn't support selection ranges; focus alone is enough.
			}
		}
	}

	/**
	 * A year of contact as a thumbnail, in the corner of the header.
	 *
	 * The full grid was doing too much here: 53 columns don't fit a modal without
	 * either overflowing it or crushing the cells, and it pushed the note preview
	 * and the notes box out of view. Twelve monthly bars carry the one thing worth
	 * seeing at a glance — whether contact is steady, ramping or stopped — and the
	 * whole thing opens the real calendar for the detail.
	 */
	private renderThumb(host: HTMLElement, record: PersonRecord): void {
		if (record.contactDates.length === 0) return;

		const interactions = new Map(record.contactDates.map((d) => [d, [record.path]]));
		const months = trailingMonths(interactions, todayISO(), 12);
		const peak = months.reduce((most, m) => Math.max(most, m.count), 0);

		const link = host.createEl("a", { cls: "prm-thumb" });
		link.setAttribute("aria-label", "Open the contact calendar for this person");
		link.title = "Contact over the last 12 months — click for the full calendar";
		link.onclick = (evt) => {
			evt.preventDefault();
			void this.plugin.openCalendar(record.path);
			this.close();
		};

		const bars = link.createDiv({ cls: "prm-thumb-bars" });
		for (const month of months) {
			const bar = bars.createDiv({ cls: "prm-thumb-bar" });
			// A month with any contact keeps a visible floor, so "a little" never
			// renders as "none".
			const height = month.count === 0 ? 0 : Math.max(12, (month.count / peak) * 100);
			bar.style.setProperty("--prm-thumb-h", `${height}%`);
			bar.title = `${month.label} — ${month.count}`;
			if (month.count === 0) bar.addClass("prm-thumb-empty");
		}

		const caption = link.createSpan({ cls: "prm-thumb-caption" });
		const inYear = months.reduce((sum, m) => sum + m.count, 0);
		const older = record.contactDates.length - inYear;
		caption.setText(older > 0 ? `${inYear} this year · ${older} before` : `${inYear} this year`);
	}

	/**
	 * Open follow-ups, with an input to add one.
	 *
	 * The task text isn't in the index — only its location is — so it's read here,
	 * from the handful of files that actually hold this person's loops.
	 */
	private renderLoops(host: HTMLElement, record: PersonRecord): void {
		host.empty();
		const heading = host.createDiv({ cls: "prm-loops-head" });
		heading.createSpan({ cls: "prm-note-label", text: "Follow-ups" });

		const list = host.createDiv({ cls: "prm-loops-list" });
		if (record.openLoops.length === 0) {
			list.createDiv({ cls: "prm-muted", text: "Nothing outstanding." });
		} else {
			list.createDiv({ cls: "prm-muted", text: "Loading…" });
			void this.fillLoops(list, record);
		}

		const add = host.createDiv({ cls: "prm-loop-add" });
		const input = add.createEl("input", {
			cls: "prm-loop-input",
			attr: { type: "text", placeholder: "Add a follow-up…" },
		});
		input.value = this.draft;
		input.addEventListener("input", () => (this.draft = input.value));
		const submit = async () => {
			const text = input.value.trim();
			if (text.length === 0) return;
			input.value = "";
			this.draft = "";
			if (await this.plugin.addFollowUp(record, text)) this.render();
		};
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void submit();
			}
		});
		const btn = add.createEl("button", { cls: "prm-loop-add-btn", text: "Add" });
		btn.onclick = () => void submit();
	}

	private async fillLoops(list: HTMLElement, record: PersonRecord): Promise<void> {
		// Anything ticked off while this panel has been open, so it stays on screen
		// (struck through) instead of vanishing the moment it's completed.
		const loops = await readLoops(this.app, [...record.openLoops, ...this.completed]);
		// The panel may have been closed or re-rendered while reading.
		if (!list.isConnected) return;
		list.empty();

		if (loops.length === 0) {
			list.createDiv({ cls: "prm-muted", text: "Nothing outstanding." });
			return;
		}

		const today = todayISO();
		for (const loop of loops) {
			const row = list.createDiv({ cls: "prm-loop" });
			const box = row.createEl("input", {
				cls: "prm-loop-check",
				attr: {
					type: "checkbox",
					"aria-label": loop.done ? `Reopen: ${loop.text}` : `Complete: ${loop.text}`,
				},
			});
			box.checked = loop.done;
			row.toggleClass("prm-loop-done", loop.done);
			// Both directions. A completed task leaves the index, so this checkbox is
			// the only handle left on it — disabling it would strand a mis-click.
			box.onclick = () => {
				const wanted = box.checked;
				box.disabled = true;
				void this.plugin
					.completeLoop(loop.ref, wanted)
					.then((ok) => {
						if (!ok) {
							box.checked = !wanted;
							return;
						}
						row.toggleClass("prm-loop-done", wanted);
						if (wanted) this.completed.push(loop.ref);
					})
					// completeLoop guards the write itself, but not the read that
					// snapshots for undo. Without this the box stayed disabled forever
					// on a failure, with no way back and an unhandled rejection.
					.catch(() => {
						box.checked = !wanted;
					})
					.finally(() => {
						box.disabled = false;
					});
			};

			row.createSpan({ cls: "prm-loop-text", text: loop.text });

			if (loop.due) {
				row.createSpan({
					cls: loop.due < today ? "prm-chip prm-chip-overdue" : "prm-chip prm-chip-soon",
					text: loop.due < today ? `overdue ${loop.due}` : `due ${loop.due}`,
				});
			}

			// Where it was written down, unless that's the note already on screen.
			if (!loop.ref.own) {
				const src = row.createEl("a", {
					cls: "prm-loop-source",
					text: loop.ref.path.split("/").pop()?.replace(/\.md$/, "") ?? loop.ref.path,
				});
				src.onclick = (evt) => {
					evt.preventDefault();
					const file = loopFile(this.app, loop.ref);
					if (file) void this.app.workspace.getLeaf(false).openFile(file);
					this.close();
				};
			}
		}
	}

	private actionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const btn = parent.createEl("button", { cls: "prm-action-btn" });
		setIcon(btn.createSpan({ cls: "prm-action-icon" }), icon);
		btn.createSpan({ text: label });
		btn.onclick = onClick;
	}

	private async logIt(): Promise<void> {
		if (this.busy || !isISODate(this.date)) return;
		this.busy = true;
		try {
			const file = this.app.vault.getAbstractFileByPath(this.record.path);
			if (file instanceof TFile) {
				await this.plugin.logContact(file, this.date, this.note.trim() || undefined);
			}
			this.close();
		} finally {
			this.busy = false;
		}
	}

	/** Clearing a date input yields "", which would otherwise wipe the stored date. */
	private validate(): void {
		const valid = isISODate(this.date);
		if (this.logButton) this.logButton.disabled = !valid;
		if (this.errorEl) {
			this.errorEl.setText(
				valid ? "" : this.date.length === 0 ? "Pick a date." : "Not a valid date.",
			);
		}
	}

	onClose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.preview?.unload();
		this.preview = null;
		this.contentEl.empty();
	}
}

// ------------------------------------------------------------- reach-out session

/**
 * A one-person-at-a-time flow over the overdue queue. Shows the note's own
 * content — the facts and talking points already written down — so there's
 * something to actually say.
 */
export class ReachOutModal extends Modal {
	private cursor = 0;
	/** Replaced per preview so old rendered subtrees are released as we advance. */
	private preview: Component | null = null;
	private handled = new Set<string>();
	private busy = false;
	/** Note drafts by person path, so moving back and forth doesn't lose typing. */
	private drafts = new Map<string, string>();

	constructor(
		private plugin: PrmPlugin,
		private queue: PersonRecord[],
	) {
		super(plugin.app);
		this.modalEl.addClass("prm-reachout-modal");
	}

	onOpen(): void {
		if (!Platform.isMobile) {
			// Returning false leaves the event to the focused field, so the arrows
			// still move the caret inside the note box.
			this.scope.register([], "ArrowRight", (e) => {
				if (isTyping(e)) return false;
				e.preventDefault();
				this.step(1);
			});
			this.scope.register([], "ArrowLeft", (e) => {
				if (isTyping(e)) return false;
				e.preventDefault();
				this.step(-1);
			});
		}
		this.render();
	}

	onClose(): void {
		this.preview?.unload();
		this.preview = null;
		this.contentEl.empty();
	}

	private step(delta: number): void {
		const next = this.cursor + delta;
		if (next < 0 || next >= this.queue.length) return;
		this.cursor = next;
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		this.preview?.unload();
		this.preview = new Component();
		this.preview.load();

		if (this.queue.length === 0) {
			this.titleEl.setText("Nobody's overdue");
			contentEl.createEl("p", {
				text: "You're all caught up. Assign tiers to more people if you want a fuller queue.",
			});
			return;
		}

		const record = this.queue[this.cursor];
		const tier = tierById(this.plugin.settings, record.tierId);

		this.titleEl.setText(`Reach out (${this.cursor + 1}/${this.queue.length})`);

		const header = contentEl.createDiv({ cls: "prm-reachout-header" });
		const nameRow = header.createDiv({ cls: "prm-reachout-namerow" });
		nameRow.createEl("h2", { text: record.name, cls: "prm-reachout-name" });
		renderTierChip(nameRow, tier);
		if (this.handled.has(record.path)) {
			nameRow.createSpan({ cls: "prm-chip prm-chip-done", text: "handled" });
		}

		const meta = header.createDiv({ cls: "prm-reachout-meta" });
		meta.createSpan({ text: lastContactLabel(record) });
		if (record.overdueDays > 0) {
			meta.createSpan({
				cls: "prm-overdue",
				text: `overdue by ${formatDuration(record.overdueDays)}`,
			});
		}
		if (record.mentionCount > 0) {
			meta.createSpan({ text: `${record.mentionCount} mentions` });
		}
		if (record.relationship) meta.createSpan({ text: record.relationship });

		const previewEl = contentEl.createDiv({ cls: "prm-preview" });
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (file instanceof TFile && this.preview) {
			void renderNotePreview(this.app, previewEl, file, this.preview);
		}

		const logIt = async () => {
			if (this.busy) return;
			this.busy = true;
			try {
				const note = (this.drafts.get(record.path) ?? "").trim();
				if (file instanceof TFile) {
					await this.plugin.logContact(file, todayISO(), note || undefined);
				}
				this.drafts.delete(record.path);
				this.handled.add(record.path);
			} finally {
				this.busy = false;
			}
			this.advanceOrClose();
		};

		noteEditor(contentEl, {
			label: "Notes",
			hint: "Saved with the contact when you log it. ⌘/Ctrl+Enter to log.",
			placeholder: "What did you talk about?",
			value: this.drafts.get(record.path) ?? "",
			onChange: (v) => this.drafts.set(record.path, v),
			onSubmit: () => void logIt(),
		});

		const actions = contentEl.createDiv({ cls: "prm-reachout-actions" });

		this.actionButton(actions, "check", "Logged it", logIt);

		this.actionButton(actions, "alarm-clock", "Snooze", () => {
			// Only advance if they actually chose — Escape should leave them in place.
			new SnoozeModal(this.plugin, record, (chosen) => {
				if (!chosen) return;
				this.handled.add(record.path);
				this.advanceOrClose();
			}).open();
		});

		this.actionButton(actions, "file-text", "Open note", () => {
			this.close();
			void this.plugin.openPerson(record);
		});

		this.actionButton(actions, "skip-forward", "Skip", () => this.advanceOrClose());

		const nav = contentEl.createDiv({ cls: "prm-reachout-nav" });
		const prev = nav.createEl("button", { text: "← Previous" });
		prev.disabled = this.cursor === 0;
		prev.onclick = () => this.step(-1);

		if (!Platform.isMobile) {
			nav.createSpan({ cls: "prm-muted", text: "← → to move between people" });
		}

		const next = nav.createEl("button", { text: "Next →" });
		next.disabled = this.cursor >= this.queue.length - 1;
		next.onclick = () => this.step(1);
	}

	private actionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void | Promise<void>,
	): void {
		const btn = parent.createEl("button", { cls: "prm-action-btn" });
		setIcon(btn.createSpan({ cls: "prm-action-icon" }), icon);
		btn.createSpan({ text: label });
		btn.onclick = () => {
			void onClick();
		};
	}

	private advanceOrClose(): void {
		if (this.cursor >= this.queue.length - 1) {
			this.close();
			new Notice("Reach-out session finished.");
			return;
		}
		this.cursor++;
		this.render();
	}
}

// -------------------------------------------------------------------- triage

/**
 * Fast keyboard pass over unclassified people: press a number to assign a tier,
 * `p` to never track, space to skip.
 */
export class TriageModal extends Modal {
	private cursor = 0;
	private assigned = 0;
	private preview: Component | null = null;
	/** Key auto-repeat fires faster than a write completes; without this, held keys
	 *  land several writes on one person and skip the next few unseen. */
	private busy = false;

	constructor(
		private plugin: PrmPlugin,
		private queue: PersonRecord[],
	) {
		super(plugin.app);
		this.modalEl.addClass("prm-reachout-modal");
	}

	onOpen(): void {
		if (!Platform.isMobile) {
			this.plugin.settings.tiers.forEach((tier, i) => {
				if (i > 8) return;
				this.scope.register([], String(i + 1), (e) => {
					e.preventDefault();
					void this.assign(tier.id);
				});
			});
			this.scope.register([], "p", (e) => {
				e.preventDefault();
				void this.pause();
			});
			this.scope.register([], " ", (e) => {
				e.preventDefault();
				this.advance();
			});
			this.scope.register([], "ArrowRight", (e) => {
				e.preventDefault();
				this.advance();
			});
		}
		this.render();
	}

	onClose(): void {
		this.preview?.unload();
		this.preview = null;
		this.contentEl.empty();
		if (this.assigned > 0) {
			new Notice(`Triaged ${this.assigned} ${this.assigned === 1 ? "person" : "people"}.`);
		}
	}

	private current(): PersonRecord | null {
		return this.queue[this.cursor] ?? null;
	}

	private async assign(tierId: string): Promise<void> {
		if (this.busy) return;
		const record = this.current();
		if (!record) return;

		this.busy = true;
		// Move on before awaiting, so a repeat keypress can't hit this person again.
		const advanced = this.advance();
		try {
			const file = this.app.vault.getAbstractFileByPath(record.path);
			if (file instanceof TFile) {
				await this.plugin.setTier(file, tierId, { silent: true });
				this.assigned++;
			}
		} finally {
			this.busy = false;
			if (advanced) this.render();
		}
	}

	private async pause(): Promise<void> {
		if (this.busy) return;
		const record = this.current();
		if (!record) return;

		this.busy = true;
		const advanced = this.advance();
		try {
			const file = this.app.vault.getAbstractFileByPath(record.path);
			if (file instanceof TFile) {
				await this.plugin.setPaused(file, true, { silent: true });
				this.assigned++;
			}
		} finally {
			this.busy = false;
			if (advanced) this.render();
		}
	}

	/** Advance the cursor. Returns false when the queue is finished (modal closed). */
	private advance(): boolean {
		if (this.cursor >= this.queue.length - 1) {
			this.close();
			return false;
		}
		this.cursor++;
		this.render();
		return true;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		this.preview?.unload();
		this.preview = new Component();
		this.preview.load();

		const record = this.current();
		if (!record) {
			this.titleEl.setText("Nothing to triage");
			contentEl.createEl("p", { text: "Every person already has a tier or is paused." });
			return;
		}

		this.titleEl.setText(`Triage (${this.cursor + 1}/${this.queue.length})`);

		const header = contentEl.createDiv({ cls: "prm-reachout-header" });
		header.createEl("h2", { text: record.name, cls: "prm-reachout-name" });

		const meta = header.createDiv({ cls: "prm-reachout-meta" });
		meta.createSpan({ text: lastContactLabel(record) });
		meta.createSpan({
			text: `${record.mentionCount} ${record.mentionCount === 1 ? "mention" : "mentions"}`,
		});
		if (record.createdDate) {
			meta.createSpan({ text: `note created ${relativeToToday(record.createdDate)}` });
		}

		const previewEl = contentEl.createDiv({ cls: "prm-preview" });
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (file instanceof TFile && this.preview) {
			void renderNotePreview(this.app, previewEl, file, this.preview);
		}

		const actions = contentEl.createDiv({ cls: "prm-triage-actions" });
		this.plugin.settings.tiers.forEach((tier, i) => {
			const btn = actions.createEl("button", { cls: "prm-triage-btn" });
			btn.style.setProperty("--prm-chip-color", tier.color);
			if (i < 9 && !Platform.isMobile) {
				btn.createSpan({ cls: "prm-key", text: String(i + 1) });
			}
			btn.createSpan({ text: tier.label });
			btn.createSpan({ cls: "prm-muted", text: formatDuration(tier.cadenceDays) });
			btn.onclick = () => void this.assign(tier.id);
		});

		const secondary = contentEl.createDiv({ cls: "prm-triage-actions" });
		const pauseBtn = secondary.createEl("button", { cls: "prm-triage-btn" });
		if (!Platform.isMobile) pauseBtn.createSpan({ cls: "prm-key", text: "p" });
		pauseBtn.createSpan({ text: "Never track" });
		pauseBtn.onclick = () => void this.pause();

		const skipBtn = secondary.createEl("button", { cls: "prm-triage-btn" });
		if (!Platform.isMobile) skipBtn.createSpan({ cls: "prm-key", text: "space" });
		skipBtn.createSpan({ text: "Skip for now" });
		skipBtn.onclick = () => this.advance();
	}
}
