/**
 * @ahkms/core/engine - lock.ts
 *
 * Single-flight guard for scheduled background cadences (ADR-016 Slice 3, ADR-101 #1321).
 * Operates against an abstract SchedulerLockPort so that database persistence is
 * a driven port decoupled from the core kernel engine.
 */

export type Cadence =
	| "dedup"
	| "alerts"
	| "learning"
	| "discover"
	| "enrich"
	| "notion_automations"
	| "gmail_automations"
	| "derive"
	| "jobs"
	| "synthesise"
	| (string & {});

export interface SchedulerLockPort {
	tryAcquire(cadence: Cadence, staleCutoff: string, lockedAt: string): Promise<boolean>;
	release(cadence: Cadence): Promise<void>;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 minutes

export class EngineLock {
	private port: SchedulerLockPort;
	private staleMs: number;

	constructor(port: SchedulerLockPort, staleMs: number = DEFAULT_STALE_MS) {
		this.port = port;
		this.staleMs = staleMs;
	}

	async tryAcquire(cadence: Cadence): Promise<boolean> {
		const staleCutoff = new Date(Date.now() - this.staleMs).toISOString();
		const lockedAt = new Date().toISOString();
		return this.port.tryAcquire(cadence, staleCutoff, lockedAt);
	}

	async release(cadence: Cadence): Promise<void> {
		return this.port.release(cadence);
	}

	async withLock<T>(
		cadence: Cadence,
		fn: () => Promise<T>,
	): Promise<T | { skipped: true }> {
		const acquired = await this.tryAcquire(cadence);
		if (!acquired) {
			return { skipped: true };
		}
		try {
			return await fn();
		} finally {
			try {
				await this.release(cadence);
			} catch (releaseErr) {
				console.error(`[EngineLock] Failed to release lock for "${cadence}":`, releaseErr);
			}
		}
	}
}
