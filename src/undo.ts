import { App, TFile } from "obsidian";
import { WriteQueue } from "./writes";

export interface FileSnapshot {
	path: string;
	/** Full file content before the change. */
	before: string;
	/** Full file content immediately after the change. */
	after: string;
}

/** A note this action brought into existence. Undo removes it again. */
export interface CreatedFile {
	path: string;
	content: string;
}

export interface UndoEntry {
	label: string;
	files: FileSnapshot[];
	/** Notes created by this action, deleted on undo and remade on redo. */
	created: CreatedFile[];
	timestamp: number;
	bytes: number;
}

export type UndoResult =
	/** `note` carries a caveat about an otherwise successful reversal. */
	| { ok: true; label: string; note?: string }
	| { ok: false; reason: string; retryable: boolean };

const DEFAULT_MAX_ENTRIES = 50;
/** Whole-file snapshots are cheap per action but a bulk import is not. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Whole-file snapshot undo.
 *
 * Every write the plugin makes is small and touches few files, so storing the
 * complete before/after text is cheaper than modelling reversible operations —
 * and it can't drift out of sync with what was actually written.
 *
 * Before restoring, the current content is compared against what we expect it to
 * be. If someone edited the note in between, the entry is stale and is left in
 * place rather than silently clobbering their edit.
 */
export class UndoManager {
	private undoStack: UndoEntry[] = [];
	private redoStack: UndoEntry[] = [];
	private listeners = new Set<() => void>();

	constructor(
		private app: App,
		private queue: WriteQueue,
		private maxEntries = DEFAULT_MAX_ENTRIES,
		private maxBytes = DEFAULT_MAX_BYTES,
	) {}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(): void {
		for (const cb of this.listeners) cb();
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	peekUndo(): UndoEntry | null {
		return this.undoStack[this.undoStack.length - 1] ?? null;
	}

	peekRedo(): UndoEntry | null {
		return this.redoStack[this.redoStack.length - 1] ?? null;
	}

	/** Bytes currently retained by both stacks — surfaced in settings. */
	retainedBytes(): number {
		let total = 0;
		for (const e of this.undoStack) total += e.bytes;
		for (const e of this.redoStack) total += e.bytes;
		return total;
	}

	/** Record a completed change. Any pending redo history is invalidated. */
	record(label: string, files: FileSnapshot[], created: CreatedFile[] = []): UndoEntry | null {
		const changed = files.filter((f) => f.before !== f.after);
		if (changed.length === 0 && created.length === 0) return null;

		let bytes = 0;
		for (const f of changed) bytes += f.before.length + f.after.length;
		for (const c of created) bytes += c.content.length;

		const entry: UndoEntry = {
			label,
			files: changed,
			created,
			timestamp: Date.now(),
			bytes,
		};
		this.undoStack.push(entry);
		this.redoStack = [];
		this.trim();
		this.emit();
		return entry;
	}

	private trim(): void {
		while (this.undoStack.length > this.maxEntries) this.undoStack.shift();
		// Always keep at least one entry, however large, so the most recent action
		// stays reversible.
		while (this.undoStack.length > 1 && this.retainedBytes() > this.maxBytes) {
			this.undoStack.shift();
		}
	}

	/**
	 * Undo a specific entry — used by the toast's Undo link, which must reverse
	 * the action it describes rather than whatever happens to be newest.
	 */
	async undoSpecific(entry: UndoEntry): Promise<UndoResult> {
		if (this.peekUndo() !== entry) {
			return {
				ok: false,
				retryable: false,
				reason: `"${entry.label}" is no longer the most recent change — use the dashboard's undo button to step back.`,
			};
		}
		return this.undo();
	}

	async undo(): Promise<UndoResult> {
		const entry = this.peekUndo();
		if (!entry) return { ok: false, retryable: false, reason: "Nothing to undo." };

		const result = await this.restore(entry, "before");
		if (!result.ok) {
			// Leave the entry where it is: dropping it would lose history silently,
			// and a conflict is often temporary (a sync settling, a Linter pass).
			this.emit();
			return result;
		}

		this.undoStack.pop();
		this.redoStack.push(entry);
		this.emit();
		return result;
	}

	async redo(): Promise<UndoResult> {
		const entry = this.peekRedo();
		if (!entry) return { ok: false, retryable: false, reason: "Nothing to redo." };

		const result = await this.restore(entry, "after");
		if (!result.ok) {
			this.emit();
			return result;
		}

		this.redoStack.pop();
		this.undoStack.push(entry);
		this.emit();
		return result;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
		this.emit();
	}

	/**
	 * Keep snapshots pointing at the right note when it moves.
	 * `metadataCache.on("changed")` does not fire on rename, so without this an
	 * entry becomes permanently unreversible the moment a note is renamed.
	 */
	remapPath(oldPath: string, newPath: string): void {
		let touched = false;
		for (const stack of [this.undoStack, this.redoStack]) {
			for (const entry of stack) {
				for (const snapshot of entry.files) {
					if (snapshot.path === oldPath) {
						snapshot.path = newPath;
						touched = true;
					}
				}
				// Created files too. Without this, undoing a rename-then-import left the
				// note behind (nothing at the old path to remove) and redo re-created it
				// at the old path — two notes for one person.
				for (const created of entry.created) {
					if (created.path === oldPath) {
						created.path = newPath;
						touched = true;
					}
				}
			}
		}
		if (touched) this.emit();
	}

	/**
	 * Remove a note this action created — but only if it still holds exactly what
	 * was written. Once it has been edited it is the user's work, not ours to
	 * discard, so it is left in place.
	 *
	 * Trashed rather than deleted outright, so it is recoverable either way.
	 */
	private async removeCreated(created: CreatedFile): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(created.path);
		if (!(file instanceof TFile)) return;
		const current = await this.app.vault.read(file);
		if (current !== created.content) return;
		await this.app.fileManager.trashFile(file);
	}

	/**
	 * Put a created note back, for redo.
	 *
	 * Refuses to overwrite a note that isn't empty and isn't what we wrote — the
	 * mirror of `removeCreated`'s rule, and it has to be, because that method
	 * deliberately *leaves* an edited note in place while still reporting the undo as
	 * successful. The entry then sits on the redo stack pointing at the user's own
	 * work, and overwriting it here destroyed it silently.
	 */
	private async restoreCreated(created: CreatedFile): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(created.path);
		if (existing instanceof TFile) {
			return this.queue.run(created.path, async () => {
				const current = await this.app.vault.read(existing);
				// Ours, or an empty shell we can safely fill.
				if (current !== created.content && current.trim().length > 0) return false;
				await this.app.vault.process(existing, () => created.content);
				return true;
			});
		}
		return this.queue.run(created.path, async () => {
			await this.app.vault.create(created.path, created.content);
			return true;
		});
	}

	/**
	 * Restore every file in the entry to `target`.
	 *
	 * Validates all files before writing any, then rolls back what it wrote if a
	 * later write fails — a half-reverted multi-note import is worse than none.
	 */
	private async restore(
		entry: UndoEntry,
		target: "before" | "after",
	): Promise<UndoResult> {
		const expected = target === "before" ? "after" : "before";
		const pending: { file: TFile; content: string; rollback: string }[] = [];

		for (const snapshot of entry.files) {
			const file = this.app.vault.getAbstractFileByPath(snapshot.path);
			if (!(file instanceof TFile)) {
				return {
					ok: false,
					retryable: false,
					reason: `"${snapshot.path}" no longer exists, so "${entry.label}" can't be reversed.`,
				};
			}

			const current = await this.app.vault.read(file);
			if (current !== snapshot[expected]) {
				return {
					ok: false,
					retryable: true,
					reason: `"${file.basename}" changed since then, so "${entry.label}" was left alone.`,
				};
			}

			pending.push({ file, content: snapshot[target], rollback: current });
		}

		const written: { file: TFile; rollback: string }[] = [];
		// Created notes a redo declined to overwrite because the user had edited them.
		const skippedCreated: string[] = [];
		try {
			for (const { file, content, rollback } of pending) {
				await this.queue.run(file.path, async () => {
					await this.app.vault.process(file, () => content);
				});
				written.push({ file, rollback });
			}
			// Undo removes what the action created; redo puts it back.
			for (const c of entry.created) {
				if (target === "before") await this.removeCreated(c);
				else if (!(await this.restoreCreated(c))) skippedCreated.push(c.path);
			}
		} catch (err) {
			for (const { file, rollback } of written.reverse()) {
				try {
					await this.queue.run(file.path, async () => {
						await this.app.vault.process(file, () => rollback);
					});
				} catch {
					// Nothing further we can do; the message below tells the user.
				}
			}
			return {
				ok: false,
				retryable: true,
				reason: `Could not reverse "${entry.label}": ${
					err instanceof Error ? err.message : String(err)
				}. No changes were kept.`,
			};
		}

		if (skippedCreated.length > 0) {
			// Reported rather than swallowed: the redo did happen, but a note it would
			// have rewritten is the user's now, and silently keeping either version
			// would be a lie.
			return {
				ok: true,
				label: entry.label,
				note: `${listPaths(skippedCreated)} had been edited, so ${
					skippedCreated.length === 1 ? "it was" : "they were"
				} left as ${skippedCreated.length === 1 ? "it is" : "they are"}.`,
			};
		}

		return { ok: true, label: entry.label };
	}
}

/** Basenames, for a message: "Zoe.md and Ana.md". */
function listPaths(paths: string[]): string {
	const names = paths.map((p) => p.split("/").pop() ?? p);
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
