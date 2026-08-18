import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PrmPlugin from "./main";
import { tierById } from "./settings";
import type { PersonRecord, PersonStatus } from "./types";
import { formatDuration, relativeToToday, todayISO } from "./dates";
import {
	LogContactModal,
	PersonActionsModal,
	SnoozeModal,
	TagPickerModal,
	TierChooserModal,
	TierPickerModal,
} from "./modals";
import { normalizeName } from "./contacts";

export const PRM_VIEW_TYPE = "prm-dashboard";

type FilterKey = "due" | "all" | "unclassified" | "birthdays" | "paused";
type SortKey = "urgency" | "name" | "last-contact" | "cadence" | "tags";

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
	{ key: "tags", label: "Tag" },
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

	private bulkEl!: HTMLElement;
	private frame: number | null = null;
	private dirty = true;
	/** Paths of selected people. Kept by path so it survives a re-render. */
	private selection = new Set<string>();
	/** Anchor for shift-click range selection. */
	private lastClicked: string | null = null;
	/** The order rows are currently in, for resolving a shift-click range. */
	private rowOrder: string[] = [];

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
		this.bulkEl = chrome.createDiv({ cls: "prm-bulkbar" });
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
		this.pruneSelection();
		this.renderHeader();
		this.renderToolbar();
		this.renderList();
		this.renderBulkBar();
	}

	/** Drop selected paths that no longer exist, so counts can't go stale. */
	private pruneSelection(): void {
		if (this.selection.size === 0) return;
		for (const path of [...this.selection]) {
			if (!this.plugin.engine.get(path)) this.selection.delete(path);
		}
	}

	private selected(): string[] {
		// In the order shown, so a bulk action reads the way the list reads.
		const chosen = this.rowOrder.filter((p) => this.selection.has(p));
		// Anything selected but no longer listed goes on the end. Membership is
		// checked against a Set: `chosen.includes` here was quadratic in the
		// selection, which a select-all over a large vault feels.
		const listed = new Set(chosen);
		for (const p of this.selection) if (!listed.has(p)) chosen.push(p);
		return chosen;
	}

	private clearSelection(): void {
		this.selection.clear();
		this.lastClicked = null;
		this.renderBulkBar();
		this.syncRowSelectedClass();
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

	/**
	 * The bulk action bar, shown only when something is selected.
	 *
	 * Lives in the fixed chrome rather than the scrolling list so the actions stay
	 * reachable no matter how far down the selection is.
	 */
	private renderBulkBar(): void {
		const bar = this.bulkEl;
		bar.empty();
		const paths = this.selected();
		bar.toggleClass("prm-bulkbar-active", paths.length > 0);
		if (paths.length === 0) return;

		bar.createSpan({
			cls: "prm-bulk-count",
			text: `${paths.length} selected`,
		});

		const act = (label: string, icon: string, onClick: () => void) => {
			const btn = bar.createEl("button", { cls: "prm-bulk-btn" });
			setIcon(btn.createSpan({ cls: "prm-action-icon" }), icon);
			btn.createSpan({ text: label });
			btn.onclick = onClick;
		};

		act("Log contact", "check", () => {
			new LogContactModal(this.plugin, null, {
				count: paths.length,
				onSubmit: (date, note) => void this.plugin.bulkLogContact(paths, date, note),
			}).open();
		});
		act("Set cadence", "gauge", () => {
			new TierChooserModal(this.plugin, paths.length, (tierId) => {
				void this.plugin.bulkSetTier(paths, tierId);
			}).open();
		});
		act("Add tag", "tag", () => {
			new TagPickerModal(this.plugin, "add", this.plugin.engine.allTags(), (tag) => {
				void this.plugin.bulkTag(paths, tag, true);
			}).open();
		});
		act("Remove tag", "tags", () => {
			// Offer only tags the selection actually has, so the list is meaningful.
			const present = new Set<string>();
			for (const path of paths) {
				for (const tag of this.plugin.engine.get(path)?.tags ?? []) present.add(tag);
			}
			if (present.size === 0) {
				new Notice("None of the selected people have a tag.");
				return;
			}
			new TagPickerModal(this.plugin, "remove", [...present].sort(), (tag) => {
				void this.plugin.bulkTag(paths, tag, false);
			}).open();
		});
		act("Snooze", "alarm-clock", () => {
			new SnoozeModal(
				this.plugin,
				// The picker names one person; for a selection, say how many.
				{ ...(this.plugin.engine.get(paths[0]) as PersonRecord), name: `${paths.length} people` },
				(chosen, until) => {
					if (chosen && until) void this.plugin.bulkSnooze(paths, until);
				},
				true,
			).open();
		});

		const clear = bar.createEl("button", { cls: "prm-bulk-clear", text: "Clear" });
		clear.onclick = () => this.clearSelection();
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

		// Select-all acts on what's visible, which after a filter is the useful set.
		const all = controls.createEl("button", { cls: "prm-tab", text: "Select all" });
		all.setAttribute("aria-label", "Select every person currently listed");
		// Additive, not a toggle: the button's label can't announce a toggle's
		// direction, and the bulk bar's Clear already undoes it.
		all.onclick = () => {
			for (const path of this.visiblePaths()) this.selection.add(path);
			this.lastClicked = null;
			this.renderBulkBar();
			this.syncRowSelectedClass();
		};

		const search = controls.createEl("input", {
			cls: "prm-search",
			attr: { type: "search", placeholder: "Filter by name or #tag…" },
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
		this.rowOrder = records.map((r) => r.path);
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
		// A leading '#' means "this tag", not "this text anywhere": clicking the
		// #gym chip shouldn't also match someone whose relationship reads
		// "climbing gym". Plain text still searches tags along with everything else.
		const byTag = this.query.trimStart().startsWith("#");
		const q = normalizeName(this.query);
		let visible = 0;
		for (const child of Array.from(this.listEl.children)) {
			const el = child as HTMLElement;
			const haystack = byTag ? el.dataset.prmTags : el.dataset.prmSearch;
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
		row.dataset.prmPath = record.path;
		row.toggleClass("prm-row-selected", this.selection.has(record.path));
		row.dataset.prmSearch = normalizeName(
			[record.name, ...record.aliases, record.relationship ?? "", ...record.tags].join(" "),
		);
		// Tags on their own, for '#'-prefixed queries. normalizeName turns '#'
		// into a space, so the query and these values meet in the same spelling.
		row.dataset.prmTags = normalizeName(record.tags.join(" "));

		const bar = row.createDiv({ cls: "prm-bar" });
		const fill = bar.createDiv({ cls: "prm-bar-fill" });
		fill.style.setProperty("--prm-progress", `${Math.round(record.cadenceProgress * 100)}%`);
		if (tier) fill.style.setProperty("--prm-chip-color", tier.color);

		const main = row.createDiv({ cls: "prm-row-main" });

		const nameRow = main.createDiv({ cls: "prm-name-row" });

		// Inside the name row rather than a leading column of the row: under
		// ~700px the row stacks into a column, and a direct child there would
		// stretch to full width. Sidebar leaves are routinely that narrow.
		const check = nameRow.createEl("input", {
			cls: "prm-select",
			attr: { type: "checkbox", "aria-label": `Select ${record.name}` },
		});
		check.checked = this.selection.has(record.path);
		// Bind on click, not change: only a click carries the shift modifier.
		check.onclick = (evt) => this.onSelectClick(record.path, evt, check);

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

		for (const tag of record.tags) {
			const chip = meta.createEl("a", { cls: "prm-tag", text: `#${tag}` });
			chip.setAttribute("aria-label", `Filter by ${tag}`);
			chip.onclick = (evt) => {
				evt.preventDefault();
				// Clicking a tag filters to it; clicking the same one again clears.
				const next = this.query === `#${tag}` ? "" : `#${tag}`;
				this.query = next;
				if (this.searchEl) this.searchEl.value = next;
				this.applyQuery();
			};
		}

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

		row.onclick = (evt) => {
			// Links, buttons and the checkbox own their own clicks; the row only
			// handles what's left, so nothing here shadows an existing control.
			if ((evt.target as HTMLElement).closest("a, button, input, textarea, select")) return;

			// Cmd/Ctrl is the conventional multi-select modifier, and shift extends
			// a range — matching the checkboxes and every file list users know.
			if (evt.metaKey || evt.ctrlKey) {
				this.applySelect(record.path, false, !this.selection.has(record.path));
				return;
			}
			if (evt.shiftKey) {
				this.applySelect(record.path, true, !this.selection.has(record.path));
				return;
			}
			new PersonActionsModal(this.plugin, record).open();
		};
	}

	/**
	 * Toggle one row, or extend from the last click when shift is held.
	 *
	 * Ranges resolve against the order currently on screen, so a shift-click after
	 * re-sorting selects what the user can actually see between the two rows.
	 */
	private onSelectClick(path: string, evt: MouseEvent, box: HTMLInputElement): void {
		this.applySelect(path, evt.shiftKey, box.checked);
	}

	/**
	 * @param select The state `path` should end up in; a shift-click applies the
	 *   same state across the range, so dragging back over a selection clears it.
	 */
	private applySelect(path: string, shift: boolean, select: boolean): void {
		if (shift && this.lastClicked && this.lastClicked !== path) {
			const from = this.rowOrder.indexOf(this.lastClicked);
			const to = this.rowOrder.indexOf(path);
			if (from !== -1 && to !== -1) {
				const [lo, hi] = from < to ? [from, to] : [to, from];
				for (let i = lo; i <= hi; i++) {
					if (select) this.selection.add(this.rowOrder[i]);
					else this.selection.delete(this.rowOrder[i]);
				}
				this.lastClicked = path;
				// Only selection changed, so sync in place: rebuilding the list
				// costs a full render of every row for a checkbox's worth of state.
				this.renderBulkBar();
				this.syncRowSelectedClass();
				return;
			}
		}

		if (select) this.selection.add(path);
		else this.selection.delete(path);
		this.lastClicked = path;
		this.renderBulkBar();
		this.syncRowSelectedClass();
	}

	/** Reflect selection without rebuilding rows, which would lose focus. */
	private syncRowSelectedClass(): void {
		const rows = Array.from(this.listEl.children) as HTMLElement[];
		for (let i = 0; i < rows.length; i++) {
			const path = rows[i].dataset.prmPath;
			if (path === undefined) continue;
			const on = this.selection.has(path);
			rows[i].toggleClass("prm-row-selected", on);
			// A modifier-click on the row changes selection without touching the
			// box, so the box has to be brought back in line.
			const box = rows[i].querySelector<HTMLInputElement>(".prm-select");
			if (box && box.checked !== on) box.checked = on;
		}
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

	/** Paths of rows the search box hasn't hidden. */
	private visiblePaths(): string[] {
		const out: string[] = [];
		for (const child of Array.from(this.listEl.children)) {
			const el = child as HTMLElement;
			const path = el.dataset.prmPath;
			if (path !== undefined && !el.hasClass("prm-hidden")) out.push(path);
		}
		return out;
	}

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
			case "tags":
				// Grouped by first tag; the untagged collect at the end rather than
				// sorting under an empty string at the top.
				return records.sort((a, b) => {
					const at = a.tags[0];
					const bt = b.tags[0];
					if (at === undefined && bt === undefined) return byName(a, b);
					if (at === undefined) return 1;
					if (bt === undefined) return -1;
					return at.localeCompare(bt) || byName(a, b);
				});
			case "urgency":
			default:
				return records.sort((a, b) => b.overdueDays - a.overdueDays || byName(a, b));
		}
	}
}
