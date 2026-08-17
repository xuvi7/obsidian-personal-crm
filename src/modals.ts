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
import type { PersonRecord, Tier } from "./types";
import { addDays, formatDuration, isISODate, relativeToToday, todayISO } from "./dates";

/**
 * Frontmatter and leading inline fields (`up::`, `parent::`, Breadcrumbs, …) are
 * navigation chrome, not content, so they're stripped from previews.
 */
function stripChrome(markdown: string): string {
	let body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	// Only leading field lines: a `::` deeper in the note is probably real prose.
	body = body.replace(/^(?:\s*[A-Za-z][\w -]*::.*(?:\r?\n|$))+/, "");
	return body.trim();
}

async function renderNotePreview(
	app: App,
	file: TFile,
	el: HTMLElement,
	component: Component,
): Promise<void> {
	el.empty();
	const raw = await app.vault.cachedRead(file);
	const body = stripChrome(raw);
	if (body.length === 0) {
		el.createEl("p", { cls: "prm-preview-empty", text: "This note is empty." });
		return;
	}
	await MarkdownRenderer.render(app, body, el, file.path, component);
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
		/** Called with whether a choice was actually made, so callers don't advance on Escape. */
		private onDone?: (chosen: boolean) => void,
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
		const file = this.app.vault.getAbstractFileByPath(this.record.path);
		if (file instanceof TFile) {
			await this.plugin.snooze(file, addDays(todayISO(), choice.days));
		}
		this.onDone?.(true);
	}

	onClose(): void {
		if (!this.chose) this.onDone?.(false);
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

	constructor(
		private plugin: PrmPlugin,
		private record: PersonRecord,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText(`Log contact with ${this.record.name}`);
		const { contentEl } = this;
		contentEl.addClass("prm-log-modal");

		contentEl.createEl("p", { cls: "prm-muted", text: lastContactLabel(this.record) });

		new Setting(contentEl).setName("Date").addText((t) => {
			t.setValue(this.date).onChange((v) => {
				this.date = v.trim();
				this.validate();
			});
			t.inputEl.type = "date";
			return t;
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

		const previewEl = contentEl.createDiv({ cls: "prm-preview markdown-rendered" });
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (file instanceof TFile && this.preview) {
			void renderNotePreview(this.app, file, previewEl, this.preview);
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

		const previewEl = contentEl.createDiv({ cls: "prm-preview markdown-rendered" });
		const file = this.app.vault.getAbstractFileByPath(record.path);
		if (file instanceof TFile && this.preview) {
			void renderNotePreview(this.app, file, previewEl, this.preview);
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
