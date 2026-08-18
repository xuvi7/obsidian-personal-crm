import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PrmPlugin from "./main";
import type { PersonRecord } from "./types";
import { todayISO } from "./dates";
import {
	buildCalendar,
	shade,
	type CalendarCell,
	type CalendarGrid,
	type Granularity,
	type Interactions,
} from "./calendar";

export const PRM_CALENDAR_VIEW_TYPE = "prm-calendar";

const SCALES: { key: Granularity; label: string }[] = [
	{ key: "day", label: "Daily" },
	{ key: "week", label: "Weekly" },
	{ key: "month", label: "Monthly" },
	{ key: "year", label: "Yearly" },
];

/**
 * When did I talk to people?
 *
 * The dashboard answers "who is due"; this answers the question a list can't —
 * what the history actually looks like. Four scales because the useful window
 * differs by question: which days last year, which weeks, which months over
 * several years, or the whole vault a year at a time.
 */
export class PrmCalendarView extends ItemView {
	private scale: Granularity = "day";
	/** Person path to show alone, or null for everyone. */
	private focus: string | null = null;
	private selected: string | null = null;

	private chromeEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private detailEl!: HTMLElement;

	/** The grid on screen, so selecting a period doesn't rebuild it. */
	private grid: CalendarGrid | null = null;
	/** Interactions for the current scope; invalidated when the index changes. */
	private cache: Interactions | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PrmPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PRM_CALENDAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Contact calendar";
	}

	getIcon(): string {
		return "calendar-days";
	}

	onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("prm-calview");
		this.chromeEl = root.createDiv({ cls: "prm-cal-chrome" });
		this.gridEl = root.createDiv({ cls: "prm-cal-body" });
		this.detailEl = root.createDiv({ cls: "prm-cal-detail" });

		// Rebuilt on index changes, so logging contact shows up without a reload.
		this.register(
			this.plugin.engine.onChange(() => {
				this.cache = null;
				this.render();
			}),
		);
		this.render();
		return Promise.resolve();
	}

	/** Focus one person, from the dashboard or their panel. */
	showPerson(path: string | null): void {
		this.focus = path;
		this.selected = null;
		this.cache = null;
		this.render();
	}

	private records(): PersonRecord[] {
		const all = this.plugin.engine.all();
		if (this.focus === null) return all;
		const one = all.find((r) => r.path === this.focus);
		return one ? [one] : [];
	}

	/**
	 * Every interaction as `date → person paths`.
	 *
	 * Built here rather than cached on the index: it's one pass over data already
	 * in memory, and the view is usually closed.
	 */
	private interactions(): Interactions {
		if (this.cache !== null) return this.cache;
		const out: Interactions = new Map();
		for (const record of this.records()) {
			for (const date of record.contactDates) {
				const bucket = out.get(date);
				if (bucket) bucket.push(record.path);
				else out.set(date, [record.path]);
			}
		}
		this.cache = out;
		return out;
	}

	private render(): void {
		const grid = buildCalendar(this.interactions(), this.scale, todayISO(), {
			weeks: 53,
			years: 6,
			weekStart: Number(this.plugin.settings.calendarWeekStart) || 0,
		});
		this.grid = grid;

		this.renderChrome(grid);
		this.renderGrid(grid);
		this.renderDetail(grid);
	}

	/**
	 * Select a period without rebuilding the grid.
	 *
	 * Only an outline and the detail panel change, and rebuilding 371 cells — or
	 * re-bucketing 200,000 interactions — to move an outline is the kind of waste
	 * that makes a view feel slow for no reason.
	 */
	private select(key: string | null): void {
		this.selected = key;
		for (const el of Array.from(this.gridEl.querySelectorAll<HTMLElement>(".prm-cal-cell"))) {
			el.toggleClass("prm-cal-selected", el.dataset.prmKey === key && key !== null);
		}
		if (this.grid) this.renderDetail(this.grid);
	}

	private renderChrome(grid: CalendarGrid): void {
		const chrome = this.chromeEl;
		chrome.empty();

		const top = chrome.createDiv({ cls: "prm-cal-toolbar" });
		const tabs = top.createDiv({ cls: "prm-tabs" });
		for (const scale of SCALES) {
			const btn = tabs.createEl("button", {
				cls: this.scale === scale.key ? "prm-tab prm-tab-active" : "prm-tab",
				text: scale.label,
			});
			btn.onclick = () => {
				this.scale = scale.key;
				// A selection names a period at the old scale, so it can't survive.
				this.selected = null;
				this.render();
			};
			if (this.scale === scale.key) btn.setAttribute("aria-current", "true");
		}

		const right = top.createDiv({ cls: "prm-cal-controls" });
		if (this.focus !== null) {
			const record = this.plugin.engine.get(this.focus);
			const chip = right.createEl("button", {
				cls: "prm-chip prm-chip-button",
				text: record ? record.name : this.focus,
			});
			chip.setAttribute("aria-label", "Show everyone");
			setIcon(chip.createSpan({ cls: "prm-chip-x" }), "x");
			chip.onclick = () => this.showPerson(null);
		} else {
			const pick = right.createEl("button", { cls: "prm-tab", text: "One person…" });
			pick.onclick = () => this.plugin.pickPersonForCalendar();
		}

		const counts = chrome.createDiv({ cls: "prm-cal-summary" });
		counts.createSpan({ cls: "prm-stat-num", text: String(grid.inRange) });
		counts.createSpan({ text: grid.inRange === 1 ? "interaction" : "interactions" });
		if (grid.older > 0) {
			counts.createSpan({ cls: "prm-muted", text: `${grid.older} outside this range` });
		}
		if (grid.inRange === 0 && grid.older === 0) {
			counts.createSpan({
				cls: "prm-muted",
				text: "Nothing recorded yet — mention someone in a dated note, or log contact.",
			});
			return;
		}

		// A key for the shading. Without it the four steps are just four colours.
		const legend = counts.createDiv({ cls: "prm-cal-legend" });
		legend.createSpan({ cls: "prm-muted", text: "less" });
		for (let level = 0; level <= 4; level++) {
			legend.createSpan({ cls: `prm-cal-cell prm-cal-l${level}` });
		}
		legend.createSpan({ cls: "prm-muted", text: "more" });
		legend.setAttribute(
			"aria-label",
			grid.max <= 1 ? "Shaded where there was contact" : `Up to ${grid.max} in one period`,
		);
	}

	private renderGrid(grid: CalendarGrid): void {
		const host = this.gridEl;
		host.empty();
		host.dataset.prmScale = grid.granularity;

		const table = host.createDiv({ cls: "prm-cal-table" });

		// Column labels sit in their own row above the grid, offset by the row-label
		// gutter so they line up with the columns they name.
		const head = table.createDiv({ cls: "prm-cal-colrow" });
		head.createSpan({ cls: "prm-cal-rowlabel" });
		for (const label of grid.columnLabels) {
			head.createSpan({ cls: "prm-cal-collabel", text: label });
		}

		for (const row of grid.rows) {
			const rowEl = table.createDiv({ cls: "prm-cal-row" });
			rowEl.createSpan({ cls: "prm-cal-rowlabel", text: row.label });
			for (const c of row.cells) {
				if (!c) {
					rowEl.createSpan({ cls: "prm-cal-cell prm-cal-hole" });
					continue;
				}
				this.renderCell(rowEl, c, grid);
			}
		}
	}

	private renderCell(parent: HTMLElement, c: CalendarCell, grid: CalendarGrid): void {
		const level = c.future ? 0 : shade(c.count, grid.max);
		// The level class carries the shade; see styles.css for why that works here
		// when a plain class doesn't win the cascade for the fill itself.
		const el = parent.createEl("button", { cls: `prm-cal-cell prm-cal-l${level}` });
		if (c.future) {
			el.addClass("prm-cal-future");
			el.disabled = true;
			return;
		}
		el.dataset.prmKey = c.key;
		if (this.selected === c.key) el.addClass("prm-cal-selected");

		const summary =
			c.count === 0
				? `${c.label} — nothing`
				: `${c.label} — ${c.count} ${c.count === 1 ? "interaction" : "interactions"}`;
		el.setAttribute("aria-label", summary);
		el.title = summary;

		el.onclick = () => {
			// Clicking the selected period again clears it, so the detail panel can
			// be dismissed without hunting for a close button.
			this.select(this.selected === c.key ? null : c.key);
		};
	}

	private renderDetail(grid: CalendarGrid): void {
		const host = this.detailEl;
		host.empty();
		if (this.selected === null) {
			host.createDiv({ cls: "prm-muted", text: "Pick a period to see who." });
			return;
		}

		let found: CalendarCell | null = null;
		for (const row of grid.rows) {
			for (const c of row.cells) {
				if (c && c.key === this.selected) found = c;
			}
		}
		if (!found) {
			host.createDiv({ cls: "prm-muted", text: "That period isn't in view any more." });
			return;
		}

		const head = host.createDiv({ cls: "prm-cal-detail-head" });
		head.createSpan({ cls: "prm-note-label", text: found.label });
		head.createSpan({
			cls: "prm-muted",
			text: `${found.count} ${found.count === 1 ? "interaction" : "interactions"}`,
		});

		if (found.people.length === 0) {
			host.createDiv({ cls: "prm-muted", text: "Nobody." });
			return;
		}

		const list = host.createDiv({ cls: "prm-cal-people" });
		for (const path of found.people) {
			const record = this.plugin.engine.get(path);
			const item = list.createEl("a", {
				cls: "prm-cal-person",
				text: record ? record.name : path,
			});
			item.onclick = (evt) => {
				evt.preventDefault();
				if (record) void this.plugin.openPerson(record, evt.metaKey || evt.ctrlKey);
			};
		}
	}

	onClose(): Promise<void> {
		this.contentEl.empty();
		return Promise.resolve();
	}
}

/** Open the note an interaction came from, if the view ever needs it. */
export function sourceFile(plugin: PrmPlugin, path: string): TFile | null {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}
