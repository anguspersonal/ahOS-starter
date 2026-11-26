import type { ActionApprovalStore, ApprovalRequest } from "./gate.js";

export type ApprovalNotifierFn = (request: ApprovalRequest, decisionId: string) => Promise<unknown>;
export type ApprovalNotifier = ApprovalNotifierFn | { notify: ApprovalNotifierFn };

export interface WithApprovalNotifierOptions {
	timeoutMs?: number;
	writeStderr?: (line: string) => void;
}

function defaultWriteStderr(line: string): void {
	const stderr = (globalThis as { process?: { stderr?: { write?: (s: string) => unknown } } }).process?.stderr;
	if (stderr?.write) stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

export function withApprovalNotifier<TStore extends ActionApprovalStore>(
	store: TStore,
	notifier: ApprovalNotifier,
	options?: WithApprovalNotifierOptions | number,
): TStore {
	const opts = typeof options === "number" ? { timeoutMs: options } : (options ?? {});
	const timeoutMs = opts.timeoutMs ?? 3000;
	const writeStderr = opts.writeStderr ?? defaultWriteStderr;
	const call = typeof notifier === "function" ? notifier : (r: ApprovalRequest, id: string) => notifier.notify(r, id);

	return {
		...store,
		async park(request: ApprovalRequest): Promise<{ decisionId: string }> {
			const result = await store.park(request);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.resolve().then(() => call(request, result.decisionId)),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`approval notifier timed out after ${timeoutMs}ms`)), timeoutMs);
					}),
				]);
			} catch (err) {
				writeStderr(`[approval:notify] decisionId=${result.decisionId} failed: ${err instanceof Error ? err.message : String(err)}\n`);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
			return result;
		},
	};
}
