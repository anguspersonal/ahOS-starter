/**
 * @ahkms/core/engine - start.ts
 *
 * Programmatic startup API for the engine runner (ADR-101 §2; #1321, #1327).
 * Encapsulates EngineLock, EngineRunLog, and EngineRunner initialization.
 */

import { EngineLock, type SchedulerLockPort } from "./lock.js";
import { EngineRunLog, type SchedulerRunLogPort } from "./runLog.js";
import { EngineRunner, type CadenceDefinition } from "./runner.js";

export interface StartEngineOptions {
	lockPort: SchedulerLockPort;
	runLogPort: SchedulerRunLogPort;
	cadences?: CadenceDefinition[];
}

export interface EngineHandle {
	runner: EngineRunner;
	stop: () => Promise<void>;
}

/**
 * Starts the engine runner in-process with the given persistence ports.
 *
 * @param options Persistence ports and optional initial cadence definitions.
 * @returns An EngineHandle providing access to the runner instance and a clean stop() function.
 */
export function startEngine(options: StartEngineOptions): EngineHandle {
	const lock = new EngineLock(options.lockPort);
	const runLog = new EngineRunLog(options.runLogPort);
	const runner = new EngineRunner(lock, runLog);

	if (options.cadences) {
		for (const cadence of options.cadences) {
			runner.registerCadence(cadence);
		}
	}

	runner.start();

	return {
		runner,
		stop: async () => {
			await runner.stop();
		},
	};
}
