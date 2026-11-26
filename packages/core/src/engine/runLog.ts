/**
 * @ahkms/core/engine - runLog.ts
 *
 * Persists run metrics and outcomes to scheduler_runs (ADR-016 Slice 3, ADR-101 #1321).
 * Operates against an abstract SchedulerRunLogPort so the engine remains decoupled from
 * concrete database drivers.
 */

import type { Cadence } from "./lock.js";

export interface SchedulerRunEntry {
	cadence: Cadence;
	connector?: string | null;
	startedAt: Date;
	counts: Record<string, unknown>;
	error?: string | null;
}

export interface SchedulerRunLogPort {
	record(entry: SchedulerRunEntry): Promise<void>;
}

export class EngineRunLog {
	private port: SchedulerRunLogPort;

	constructor(port: SchedulerRunLogPort) {
		this.port = port;
	}

	async recordRun(entry: SchedulerRunEntry): Promise<void> {
		try {
			await this.port.record(entry);
		} catch (err) {
			// A logging failure must never take down the cadence itself — log and continue.
			console.error(`[EngineRunLog] scheduler_runs insert failed (${entry.cadence}):`, err);
		}
	}
}
