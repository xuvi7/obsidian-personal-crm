/**
 * Serializes writes per file path.
 *
 * The plugin's actions are multi-step (append a log bullet, then update
 * frontmatter) and each step is individually atomic but the sequence is not.
 * Without a queue, two overlapping actions on one note interleave: one clobbers
 * the other's body edit, and the undo snapshots taken either side of the
 * sequence capture a mixture of both, so a single undo reverses a change the
 * user never asked to reverse.
 *
 * Queueing by path keeps unrelated notes fully parallel.
 */
export class WriteQueue {
	private tails = new Map<string, Promise<unknown>>();

	/** Run `task` once every previously queued task for `key` has settled. */
	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		// Chain off both outcomes: one failed write must not stall the path.
		const result = previous.then(task, task);
		// The stored tail must never reject, or it would swallow the next task.
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);

		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});

		return result;
	}
}
