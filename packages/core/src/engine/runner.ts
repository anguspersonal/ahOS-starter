/**
 * @ahkms/core/engine - runner.ts
 *
 * The Engine Runner orchestrating unattended background work, periodic cadences,
 * and batch jobs with single-flight locking and execution logging (ADR-101 #1321).
 */

import type { Cadence } from "./lock.js";
import { EngineLock } from "./lock.js";
import { EngineRunLog } from "./runLog.js";

export interface CadenceDefinition {
	name: Cadence;
	intervalMs: number;
	run: () => Promise<Record<string, unknown>>;
	connector?: string;
	enabled?: () => boolean;
	/**
	 * Optional filter for high-frequency cadences: when it returns false for a
	 * successful run's counts, no scheduler_runs row is written. Failed runs are
	 * always recorded.
	 */
	shouldRecord?: (counts: Record<string, unknown>) => boolean;
}

export class EngineRunner {
	private lock: EngineLock;
	private runLog: EngineRunLog;
	private cadences: Map<string, CadenceDefinition> = new Map();
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private running = false;

	constructor(lock: EngineLock, runLog: EngineRunLog) {
		this.lock = lock;
		this.runLog = runLog;
	}

	registerCadence(def: CadenceDefinition): void {
		if (this.cadences.has(def.name)) {
			console.warn(`[EngineRunner] Overwriting registration for cadence "${def.name}"`);
		}
		this.cadences.set(def.name, def);
	}

	getCadences(): CadenceDefinition[] {
		return Array.from(this.cadences.values());
	}

	start(): void {
		if (this.running) return;
		this.running = true;

		for (const def of this.cadences.values()) {
			this.scheduleCadence(def);
		}
	}

	private scheduleCadence(def: CadenceDefinition): void {
		const tick = async () => {
			if (!this.running) return;
			try {
				if (def.enabled && !def.enabled()) return;

				const startedAt = new Date();
				await this.lock.withLock(def.name, async () => {
					let counts: Record<string, unknown> = {};
					let errorMsg: string | null = null;
					try {
						counts = await def.run();
					} catch (err: any) {
						errorMsg = err?.message || String(err);
						console.error(`[EngineRunner] Cadence "${def.name}" failed:`, err);
					} finally {
						if (errorMsg !== null || !def.shouldRecord || def.shouldRecord(counts)) {
							await this.runLog.recordRun({
								cadence: def.name,
								connector: def.connector,
								startedAt,
								counts,
								error: errorMsg,
							});
						}
					}
				});
			} catch (err) {
				console.error(`[EngineRunner] Cadence "${def.name}" tick failed:`, err);
			}
		};

		// Jitter the initial execution slightly to prevent thundering herds on startup
		const initialDelay = Math.floor(Math.random() * 5000);
		const initialTimeout = setTimeout(() => {
			if (!this.running) return;
			void tick();
			const intervalTimer = setInterval(() => void tick(), def.intervalMs);
			this.timers.set(def.name, intervalTimer);
		}, initialDelay);

		this.timers.set(`__init__${def.name}`, initialTimeout);
	}

	async stop(): Promise<void> {
		this.running = false;
		for (const timer of this.timers.values()) {
			clearTimeout(timer);
			clearInterval(timer);
		}
		this.timers.clear();
	}

	isRunning(): boolean {
		return this.running;
	}
}
