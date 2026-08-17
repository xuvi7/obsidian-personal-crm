import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type PrmPlugin from "./main";
import {
	ExternalContact,
	ImportOptions,
	MatchReport,
	matchContacts,
	parseContactsFile,
} from "./contacts";

const MAX_ROWS = 200;

/**
 * Import contact details from a Google Contacts export.
 *
 * Nothing is written until the plan has been reviewed — a bulk edit across
 * hundreds of notes should never be a surprise. The whole apply is a single
 * undoable step.
 */
export class ContactImportModal extends Modal {
	private contacts: ExternalContact[] = [];
	private sourceName = "";
	private report: MatchReport | null = null;
	private options: ImportOptions;
	private applying = false;

	constructor(private plugin: PrmPlugin) {
		super(plugin.app);
		this.modalEl.addClass("prm-import-modal");
		this.options = {
			overwriteExisting: plugin.settings.importOverwriteExisting,
			includeGivenNameMatches: plugin.settings.importIncludeGivenNameMatches,
			nicknamesAsAliases: plugin.settings.importNicknamesAsAliases,
		};
	}

	onOpen(): void {
		this.titleEl.setText("Import contact details");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------ planning

	private replan(): void {
		if (this.contacts.length === 0) {
			this.report = null;
			return;
		}
		this.report = matchContacts(
			this.contacts,
			this.plugin.engine.all(),
			(path) => this.plugin.frontmatterFor(path),
			this.options,
		);
	}

	// ----------------------------------------------------------------- rendering

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		this.renderSource(contentEl);

		if (this.contacts.length === 0) {
			this.renderHelp(contentEl);
			return;
		}

		this.renderOptions(contentEl);
		this.renderSummary(contentEl);
		this.renderChanges(contentEl);
		this.renderFooter(contentEl);
	}

	private renderSource(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: "prm-import-source" });

		const input = row.createEl("input", {
			attr: { type: "file", accept: ".csv,.vcf,.vcard,text/csv,text/vcard" },
			cls: "prm-hidden-file",
		});

		const button = row.createEl("button", {
			cls: "prm-primary-btn",
			text: this.contacts.length > 0 ? "Choose a different file" : "Choose export file…",
		});
		button.onclick = () => input.click();

		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const parsed = parseContactsFile(file.name, text);
				if (parsed.length === 0) {
					new Notice(
						"No contacts found in that file. Export as Google CSV or vCard from contacts.google.com.",
					);
					return;
				}
				this.contacts = parsed;
				this.sourceName = file.name;
				this.replan();
				this.render();
			} catch (err) {
				const message = err instanceof Error ? err.message : "unrecognised format";
				new Notice(`Could not read that file: ${message}`);
			}
		};

		if (this.contacts.length > 0) {
			row.createSpan({
				cls: "prm-muted",
				text: `${this.contacts.length} contacts from ${this.sourceName}`,
			});
		}
	}

	private renderHelp(parent: HTMLElement): void {
		const help = parent.createDiv({ cls: "prm-import-help" });
		help.createEl("p", {
			text: "In Google Contacts, select the contacts you want, then Export and choose Google CSV or vCard. Pick that file here.",
		});
		help.createEl("p", {
			cls: "prm-muted",
			text: "Contacts are matched to notes by name. Existing values in your notes are kept unless you allow overwriting, and nothing is written until you review the changes.",
		});
	}

	private renderOptions(parent: HTMLElement): void {
		const box = parent.createDiv({ cls: "prm-import-options" });

		new Setting(box)
			.setName("Overwrite values already in the note")
			.setDesc("Off means only empty fields get filled.")
			.addToggle((t) =>
				t.setValue(this.options.overwriteExisting).onChange((v) => {
					this.options.overwriteExisting = v;
					this.replan();
					this.render();
				}),
			);

		new Setting(box)
			.setName("Match notes titled with only a first name")
			.setDesc('Lets "Sam Rivera" match a note called "Sam". Riskier — review carefully.')
			.addToggle((t) =>
				t.setValue(this.options.includeGivenNameMatches).onChange((v) => {
					this.options.includeGivenNameMatches = v;
					this.replan();
					this.render();
				}),
			);

		new Setting(box)
			.setName("Add nicknames to aliases")
			.setDesc("Improves how journal links resolve. Aliases are merged, never replaced.")
			.addToggle((t) =>
				t.setValue(this.options.nicknamesAsAliases).onChange((v) => {
					this.options.nicknamesAsAliases = v;
					this.replan();
					this.render();
				}),
			);
	}

	private renderSummary(parent: HTMLElement): void {
		const report = this.report;
		if (!report) return;

		const summary = parent.createDiv({ cls: "prm-import-summary" });
		const stat = (value: number, label: string, cls?: string) => {
			const chip = summary.createDiv({ cls: cls ? `prm-stat ${cls}` : "prm-stat" });
			chip.createSpan({ cls: "prm-stat-value", text: String(value) });
			chip.createSpan({ cls: "prm-stat-label", text: label });
		};

		stat(report.plans.length, "to update", "prm-stat-soon");
		stat(report.unchanged, "already current");
		stat(report.unmatched.length, "no matching note");
		if (report.ambiguous.length > 0) stat(report.ambiguous.length, "ambiguous");
	}

	private renderChanges(parent: HTMLElement): void {
		const report = this.report;
		if (!report) return;

		const list = parent.createDiv({ cls: "prm-import-list" });

		if (report.plans.length === 0) {
			list.createEl("p", {
				cls: "prm-muted",
				text: "Nothing to change. Your notes already hold everything these contacts have, or no names lined up.",
			});
		}

		for (const plan of report.plans.slice(0, MAX_ROWS)) {
			const row = list.createDiv({ cls: "prm-import-row" });

			const head = row.createDiv({ cls: "prm-name-row" });
			head.createSpan({ cls: "prm-name", text: plan.personName });
			if (plan.confidence !== "exact") {
				head.createSpan({ cls: "prm-chip prm-chip-muted", text: plan.confidence });
			}
			if (plan.contact.displayName !== plan.personName) {
				head.createSpan({ cls: "prm-muted", text: `← ${plan.contact.displayName}` });
			}

			const fields = row.createDiv({ cls: "prm-import-fields" });
			for (const change of plan.changes) {
				const line = fields.createDiv({ cls: "prm-import-field" });
				line.createSpan({ cls: "prm-import-key", text: change.key });
				if (change.from !== null) {
					line.createSpan({ cls: "prm-import-old", text: change.from });
					line.createSpan({ cls: "prm-muted", text: "→" });
				}
				line.createSpan({
					cls: "prm-import-new",
					text: Array.isArray(change.to) ? change.to.join(", ") : change.to,
				});
			}
		}

		if (report.plans.length > MAX_ROWS) {
			list.createEl("p", {
				cls: "prm-muted",
				text: `…and ${report.plans.length - MAX_ROWS} more, all included in the update.`,
			});
		}

		if (report.ambiguous.length > 0) {
			const details = list.createEl("details", { cls: "prm-import-details" });
			details.createEl("summary", {
				text: `${report.ambiguous.length} skipped as ambiguous`,
			});
			for (const item of report.ambiguous.slice(0, 50)) {
				details.createDiv({
					cls: "prm-muted",
					text: `${item.contact.displayName} → ${item.candidates.join(" / ")}`,
				});
			}
		}

		if (report.unmatched.length > 0) {
			const details = list.createEl("details", { cls: "prm-import-details" });
			details.createEl("summary", {
				text: `${report.unmatched.length} contacts with no person note`,
			});
			for (const contact of report.unmatched.slice(0, 100)) {
				details.createDiv({ cls: "prm-muted", text: contact.displayName });
			}
			if (report.unmatched.length > 100) {
				details.createDiv({
					cls: "prm-muted",
					text: `…and ${report.unmatched.length - 100} more.`,
				});
			}
		}
	}

	private renderFooter(parent: HTMLElement): void {
		const count = this.report?.plans.length ?? 0;

		new Setting(parent)
			.setClass("prm-import-footer")
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(
					count === 0 ? "Nothing to update" : `Update ${count} ${count === 1 ? "note" : "notes"}`,
				);
				if (count > 0) b.setCta();
				b.setDisabled(count === 0 || this.applying);
				// The click handler stays void-returning; the work is detached.
				b.onClick(() => {
					void this.applyPlan(b);
				});
				return b;
			});
	}

	private async applyPlan(button: ButtonComponent): Promise<void> {
		const report = this.report;
		if (!report || report.plans.length === 0 || this.applying) return;

		this.applying = true;
		button.setDisabled(true);
		await this.plugin.saveImportOptions(this.options);

		const result = await this.plugin.applyContactImport(
			report.plans,
			this.options.overwriteExisting,
			(done, total) => {
				button.setButtonText(`Updating ${done}/${total}…`);
			},
		);
		this.close();

		const parts: string[] = [
			result.written === 0
				? "No notes needed changing"
				: `Updated ${result.written} ${result.written === 1 ? "note" : "notes"}`,
		];
		// Values that changed after the preview are left alone, so say so rather
		// than quietly doing less than the preview promised.
		if (result.skipped > 0) {
			parts.push(`${result.skipped} skipped (changed since the preview)`);
		}
		if (result.failed.length > 0) {
			parts.push(`${result.failed.length} failed: ${result.failed.slice(0, 3).join(", ")}`);
		}
		if (result.written > 0) parts.push("undo is available");

		new Notice(`${parts.join(" · ")}.`, result.failed.length > 0 ? 12000 : 7000);
	}
}
