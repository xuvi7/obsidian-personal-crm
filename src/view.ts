import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PrmPlugin from "./main";
import { tierById } from "./settings";
import type { PersonRecord, PersonStatus } from "./types";
import { formatDuration, relativeToToday, todayISO } from "./dates";
import { LogContactModal, SnoozeModal, TierPickerModal } from "./modals";
import { normalizeName } from "./contacts";

export const PRM_VIEW_TYPE = "prm-dashboard";

type FilterKey = "due" | "all" | "unclassified" | "birthdays" | "paused";
type SortKey = "urgency" | "name" | "last-contact" | "cadence";

const FILTERS: { key: FilterKey; label: string }[] = [
	{ key: "due", label: "Due" },
	{ key: "all", label: "Tracked" },
	{ key: "unclassified", label: "Unclassified" },
	{ key: "birthdays", label: "Birthdays" },
	{ key: "paused", label: "Paused" },
];

const SORTS: { key: SortKey; label: string }[] = [
	{ key: "urgency", label: "Most overdue" },
	{ key: "last-contact", label: "Longest since contact" },
	{ key: "name", label: "Name" },
	{ key: "cadence", label: "Cadence" },
];

const STATUS_LABEL: Record<PersonStatus, string> = {
	overdue: "overdue",
	"due-soon": "due soon",
	ok: "on track",
	snoozed: "snoozed",
	paused: "paused",
	untracked: "unclassified",
};

export class PrmDashboardView extends ItemView {
	private filter: FilterKey = "due";
	private sort: SortKey = "urgency";
	private query = "";

	private headerEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private listEl!: HTMLElement;
	private searchEl: HTMLInputElement | null = null;

	private frame: number | null = null;
	private dirty = true;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PrmPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PRM_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Personal CRM";
	}

	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("prm-view");

		// The header and toolbar sit in a fixed pane and the list scrolls on its
		// own, rather than the whole view scrolling under a sticky header. Sticky
		// positioning let rows show through above the header, and only covered the
		// header — leaving the filter tabs to scroll away.
		const chrome = root.createDiv({ cls: "prm-chrome" });
		this.headerEl = chrome.createDiv({ cls: "prm-header" });
		this.toolbarEl = chrome.createDiv({ cls: "prm-toolbar" });
		this.listEl = root.createDiv({ cls: "prm-list" });

		// One coalesced handler: the engine and the undo stack both fire on a single
		// write, and rebuilding the whole list twice per click was the dominant cost.
		const invalidate = () => this.scheduleRender();
		this.register(this.plugin.engine.onChange(invalidate));
		this.register(this.plugin.undo.onChange(invalidate));

		this.renderAll();
	}

	onClose(): Promise<void> {
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		return Promise.resolve();
	}

	onResize(): void {
		// Becoming visible is the moment to pay for a render we skipped.
		if (this.dirty) this.scheduleRender();
	}

	/**
	 * Defer to the next frame and collapse duplicates. Skips the work entirely
	 * while the leaf is hidden — a background tab was still paying full DOM
	 * construction cost on every metadata change anywhere in the vault.
	 */
	private scheduleRender(): void {
		this.dirty = true;
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			if (!this.isVisible()) return;
			this.renderAll();
		});
	}

	private isVisible(): boolean {
		return this.contentEl.isShown();
	}

	private renderAll(): void {
		this.dirty = false;
		this.renderHeader();
		this.renderToolbar();
		this.renderList();
	}

	// ------------------------------------------------------------------ rendering

	private renderHeader(): void {
		const header = this.headerEl;
		header.empty();
		const stats = this.plugin.engine.stats();

		const titleRow = header.createDiv({ cls: "prm-title-row" });
		titleRow.createEl("h2", { text: "Personal CRM", cls: "prm-title" });

		const buttons = titleRow.createDiv({ cls: "prm-header-buttons" });

		const reachOut = buttons.createEl("button", { cls: "prm-primary-btn" });
		setIcon(reachOut.createSpan({ cls: "prm-action-icon" }), "send");
		reachOut.createSpan({ text: "Reach out" });
		reachOut.onclick = () => this.plugin.startReachOutSession();

		const add = buttons.createEl("button", { cls: "prm-header-btn" });
		setIcon(add.createSpan({ cls: "prm-action-icon" }), "user-plus");
		add.createSpan({ text: "Add person" });
		add.setAttribute("aria-label", "Add a person");
		add.onclick = () => this.plugin.openCreatePerson();

		const triage = buttons.createEl("button", { text: "Triage" });
		triage.onclick = () => this.plugin.startTriage();

		buttons.createDiv({ cls: "prm-header-divider" });

		const undoEntry = this.plugin.undo.peekUndo();
		const undoBtn = buttons.createEl("button", { cls: "clickable-icon" });
		setIcon(undoBtn, "undo-2");
		undoBtn.disabled = undoEntry === null;
		undoBtn.setAttribute("aria-label", undoEntry ? `Undo: ${undoEntry.label}` : "Nothing to undo");
		undoBtn.onclick = () => void this.plugin.performUndo();

		const redoEntry = this.plugin.undo.peekRedo();
		const redoBtn = buttons.createEl("button", { cls: "clickable-icon" });
		setIcon(redoBtn, "redo-2");
		redoBtn.disabled = redoEntry === null;
		redoBtn.setAttribute("aria-label", redoEntry ? `Redo: ${redoEntry.label}` : "Nothing to redo");
		redoBtn.onclick = () => void this.plugin.performRedo();

		const refresh = buttons.createEl("button", { cls: "clickable-icon" });
		setIcon(refresh, "refresh-cw");
		refresh.setAttribute("aria-label", "Rebuild index");
		refresh.onclick = () => {
			this.plugin.engine.rebuild();
			this.plugin.refreshStatusBar();
		};

		const chips = header.createDiv({ cls: "prm-stats" });
		this.statChip(chips, stats.overdue, "overdue", "prm-stat-overdue");
		this.statChip(chips, stats.dueSoon, "due soon", "prm-stat-soon");
		this.statChip(chips, stats.tracked, "tracked");
		this.statChip(chips, stats.untracked, "unclassified");

		if (stats.unknownTier > 0) {
			header.createDiv({
				cls: "prm-warning",
				text: `${stats.unknownTier} ${
					stats.unknownTier === 1 ? "person has" : "people have"
				} a tier that no longer exists — reassign them to start tracking again.`,
			});
		}
	}

	private statChip(parent: HTMLElement, value: number, label: string, cls?: string): void {
		const chip = parent.createDiv({ cls: cls ? `prm-stat ${cls}` : "prm-stat" });
		chip.createSpan({ cls: "prm-stat-value", text: String(value) });
		chip.createSpan({ cls: "prm-stat-label", text: label });
	}

	private renderToolbar(): void {
		const toolbar = this.toolbarEl;
		toolbar.empty();

		const tabs = toolbar.createDiv({ cls: "prm-tabs" });
		for (const f of FILTERS) {
			const btn = tabs.createEl("button", {
				cls: this.filter === f.key ? "prm-tab prm-tab-active" : "prm-tab",
				text: f.label,
			});
			btn.onclick = () => {
				this.filter = f.key;
				this.renderToolbar();
				this.renderList();
			};
		}

		const controls = toolbar.createDiv({ cls: "prm-controls" });

		const search = controls.createEl("input", {
			cls: "prm-search",
			attr: { type: "search", placeholder: "Filter by name…" },
		});
		search.value = this.query;
		// Filtering hides already-built rows rather than rebuilding them, so typing
		// stays instant instead of costing a full render per keystroke.
		search.oninput = () => {
			this.query = search.value;
			this.applyQuery();
		};
		this.searchEl = search;

		const select = controls.createEl("select", { cls: "dropdown prm-sort" });
		for (const s of SORTS) {
			const opt = select.createEl("option", { text: s.label, value: s.key });
			if (s.key === this.sort) opt.selected = true;
		}
		select.onchange = () => {
			this.sort = select.value as SortKey;
			this.renderList();
		};
	}

	private renderList(): void {
		const list = this.listEl;
		list.empty();

		const records = this.selectedRecords();
		if (records.length === 0) {
			this.renderEmptyState(list);
			return;
		}

		const today = todayISO();
		for (const record of records) this.renderRow(list, record, today);
		this.applyQuery();
	}

	/** Show/hide built rows to match the search box. */
	private applyQuery(): void {
		const q = normalizeName(this.query);
		let visible = 0;
		for (const child of Array.from(this.listEl.children)) {
			const el = child as HTMLElement;
			const haystack = el.dataset.prmSearch;
			if (haystack === undefined) continue;
			const show = q.length === 0 || haystack.includes(q);
			el.toggleClass("prm-hidden", !show);
			if (show) visible++;
		}

		const existing = this.listEl.querySelector(".prm-no-matches");
		if (existing) existing.remove();
		if (visible === 0 && q.length > 0) {
			this.listEl.createDiv({
				cls: "prm-empty prm-no-matches",
				text: `Nobody matches "${this.query}".`,
			});
		}
	}

	private renderEmptyState(list: HTMLElement): void {
		const d = this.plugin.engine.diagnostics();
		const empty = list.createDiv({ cls: "prm-empty" });

		// A misconfigured folder looks identical to "nobody is due" unless we say so.
		if (d.personFilesFound === 0) {
			empty.createEl("p", { text: "No people found yet." });
			empty.createEl("p", {
				cls: "prm-muted",
				text:
					d.missingFolders.length > 0
						? `These folders don't exist: ${d.missingFolders.join(", ")}. Set the right ones in settings.`
						: "Point the plugin at the folder holding your person notes, or add someone to start.",
			});
			const row = empty.createDiv({ cls: "prm-empty-actions" });
			this.addPersonButton(row);
			this.settingsLink(row);
			return;
		}

		if (d.journalFilesScanned > 0 && d.journalFilesDated === 0) {
			empty.createEl("p", { text: "None of your dated notes could be dated." });
			empty.createEl("p", {
				cls: "prm-muted",
				text: `${d.journalFilesScanned} notes were scanned but none matched your date format. Copy the format from your Daily Notes or Periodic Notes settings.`,
			});
			this.settingsLink(empty);
			return;
		}

		switch (this.filter) {
			case "due":
				empty.createEl("p", { text: "Nobody is due right now." });
				empty.createEl("p", {
					cls: "prm-muted",
					text: `Only people with a tier get tracked — ${d.personFilesFound} found, ${
						this.plugin.engine.stats().untracked
					} still unclassified. Run Triage to work through them.`,
				});
				break;
			case "unclassified":
				empty.createEl("p", { text: "Everyone has been classified." });
				this.addPersonButton(empty.createDiv({ cls: "prm-empty-actions" }));
				break;
			case "birthdays":
				empty.createEl("p", { text: "No birthdays recorded yet." });
				empty.createEl("p", {
					cls: "prm-muted",
					text: "Add prm-birthday: 04-17 (or 1999-04-17) to a person's note.",
				});
				break;
			case "paused":
				empty.createEl("p", { text: "Nobody is paused." });
				break;
			default:
				empty.createEl("p", { text: "Nothing to show." });
		}
	}

	private addPersonButton(parent: HTMLElement): void {
		const btn = parent.createEl("button", { cls: "prm-primary-btn" });
		setIcon(btn.createSpan({ cls: "prm-action-icon" }), "user-plus");
		btn.createSpan({ text: "Add a person" });
		btn.onclick = () => this.plugin.openCreatePerson();
	}

	private settingsLink(parent: HTMLElement): void {
		const btn = parent.createEl("button", { text: "Open settings" });
		btn.onclick = () => {
			// Obsidian exposes the settings modal on the app object.
			const app = this.app as unknown as {
				setting?: { open?: () => void; openTabById?: (id: string) => void };
			};
			app.setting?.open?.();
			app.setting?.openTabById?.(this.plugin.manifest.id);
		};
	}

	private renderRow(list: HTMLElement, record: PersonRecord, today: string): void {
		const tier = tierById(this.plugin.settings, record.tierId);
		const row = list.createDiv({ cls: `prm-row prm-row-${record.status}` });
		row.dataset.prmSearch = normalizeName(
			[record.name, ...record.aliases, record.relationship ?? ""].join(" "),
		);

		const bar = row.createDiv({ cls: "prm-bar" });
		const fill = bar.createDiv({ cls: "prm-bar-fill" });
		fill.style.setProperty("--prm-progress", `${Math.round(record.cadenceProgress * 100)}%`);
		if (tier) fill.style.setProperty("--prm-chip-color", tier.color);

		const main = row.createDiv({ cls: "prm-row-main" });

		const nameRow = main.createDiv({ cls: "prm-name-row" });
		const link = nameRow.createEl("a", { cls: "prm-name", text: record.name });
		link.onclick = (evt) => {
			evt.preventDefault();
			void this.plugin.openPerson(record, evt.metaKey || evt.ctrlKey);
		};

		// A button, not a <select>: one dropdown per row with an option per tier was
		// nearly half of all render cost.
		const tierBtn = nameRow.createEl("button", {
			cls: tier ? "prm-chip prm-chip-button" : "prm-chip prm-chip-button prm-chip-muted",
			text: record.tierMissing
				? `unknown tier: ${record.tierId}`
				: tier
					? tier.label
					: "unclassified",
		});
		if (tier) tierBtn.style.setProperty("--prm-chip-color", tier.color);
		if (record.tierMissing) tierBtn.addClass("prm-chip-overdue");
		tierBtn.setAttribute("aria-label", `Change cadence for ${record.name}`);
		tierBtn.onclick = () => new TierPickerModal(this.plugin, record).open();

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

		const meta = main.createDiv({ cls: "prm-row-meta" });
		if (record.lastContact) {
			const last = meta.createEl("a", {
				cls: "prm-meta-link",
				text: `last ${relativeToToday(record.lastContact, today)}`,
			});
			last.onclick = (evt) => {
				evt.preventDefault();
				void this.plugin.openInteraction(record, record.lastContact as string);
			};
		} else if (record.baselineSource === "filesystem") {
			// Urgency derived from a file timestamp shouldn't look like real data:
			// sync and git clone both reset it.
			meta.createSpan({ cls: "prm-muted", text: "no contact history (estimated)" });
		} else {
			meta.createSpan({ text: "never in contact" });
		}

		if (record.cadenceDays !== null) {
			meta.createSpan({ text: `every ${formatDuration(record.cadenceDays)}` });
		}
		if (record.mentionCount > 0) {
			meta.createSpan({ text: `${record.mentionCount}× mentioned` });
		}
		if (this.filter === "birthdays" && record.daysUntilBirthday !== null) {
			meta.createSpan({
				cls: "prm-birthday",
				text:
					record.daysUntilBirthday === 0
						? "birthday today"
						: `birthday in ${formatDuration(record.daysUntilBirthday)}`,
			});
		}
		if (record.relationship) meta.createSpan({ text: record.relationship });

		const actions = row.createDiv({ cls: "prm-row-actions" });

		this.iconButton(actions, "check", "Log contact today", async () => {
			const file = this.app.vault.getAbstractFileByPath(record.path);
			if (file instanceof TFile) await this.plugin.logContact(file, todayISO());
		});

		this.iconButton(actions, "pencil", "Log contact with details…", () => {
			new LogContactModal(this.plugin, record).open();
		});

		this.iconButton(actions, "alarm-clock", "Snooze", () => {
			new SnoozeModal(this.plugin, record).open();
		});

		row.setAttribute("aria-label", `${record.name} — ${STATUS_LABEL[record.status]}`);
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		tooltip: string,
		onClick: () => void | Promise<void>,
	): void {
		const btn = parent.createEl("button", { cls: "clickable-icon prm-icon-btn" });
		setIcon(btn, icon);
		btn.setAttribute("aria-label", tooltip);
		btn.onclick = () => void onClick();
	}

	// ------------------------------------------------------------------ selection

	private selectedRecords(): PersonRecord[] {
		const records = this.plugin.engine.all().filter((r) => {
			switch (this.filter) {
				case "due":
					return r.status === "overdue" || r.status === "due-soon";
				case "all":
					return r.status !== "untracked" && r.status !== "paused";
				case "unclassified":
					return r.status === "untracked";
				case "birthdays":
					return r.daysUntilBirthday !== null;
				case "paused":
					return r.status === "paused";
			}
		});

		const byName = (a: PersonRecord, b: PersonRecord) => a.name.localeCompare(b.name);

		if (this.filter === "birthdays") {
			return records.sort(
				(a, b) => (a.daysUntilBirthday ?? 0) - (b.daysUntilBirthday ?? 0) || byName(a, b),
			);
		}

		switch (this.sort) {
			case "name":
				return records.sort(byName);
			case "last-contact":
				return records.sort((a, b) => {
					// Never-contacted sorts first: nothing is more overdue than that.
					if (a.lastContact === null && b.lastContact === null) return byName(a, b);
					if (a.lastContact === null) return -1;
					if (b.lastContact === null) return 1;
					return a.lastContact.localeCompare(b.lastContact) || byName(a, b);
				});
			case "cadence":
				return records.sort(
					(a, b) =>
						(a.cadenceDays ?? Infinity) - (b.cadenceDays ?? Infinity) || byName(a, b),
				);
			case "urgency":
			default:
				return records.sort((a, b) => b.overdueDays - a.overdueDays || byName(a, b));
		}
	}
}
