import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLegacyWorkerApp } from "./legacyWorkerApp.js";

describe("loadLegacyWorkerApp", () => {
	it("loads <cwd>/app.js when cwd is the worker directory and only <cwd>/app.js exists", () => {
		const cwd = "/usr/src/app/packages/worker";
		const workerAppPath = path.resolve(cwd, "app.js");
		const load = vi.fn();

		const result = loadLegacyWorkerApp({
			cwd,
			exists: (p) => p === workerAppPath,
			load,
		});

		expect(result).toEqual({ loaded: true, path: workerAppPath });
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(workerAppPath);
	});

	it("loads only <cwd>/packages/worker/app.js when cwd is the repo root and both candidates exist", () => {
		const cwd = "/usr/src/app";
		const repoWorkerAppPath = path.resolve(cwd, "packages/worker/app.js");
		const load = vi.fn();

		const result = loadLegacyWorkerApp({
			cwd,
			exists: () => true,
			load,
		});

		expect(result).toEqual({ loaded: true, path: repoWorkerAppPath });
		expect(load).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledWith(repoWorkerAppPath);
	});

	it("throws with path and detail when app.js exists and load throws", () => {
		const cwd = "/usr/src/app/packages/worker";
		const workerAppPath = path.resolve(cwd, "app.js");
		const cause = new Error("supabaseUrl is required.");

		let caught: unknown;
		try {
			loadLegacyWorkerApp({
				cwd,
				exists: (p) => p === workerAppPath,
				load: () => {
					throw cause;
				},
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			`legacy worker app at ${workerAppPath} failed to load: supabaseUrl is required.`,
		);
		expect((caught as Error).cause).toBe(cause);
	});

	it("returns { loaded: false, path: null } and never calls load when neither candidate exists", () => {
		const load = vi.fn();

		const result = loadLegacyWorkerApp({
			cwd: "/usr/src/app/packages/core",
			exists: () => false,
			load,
		});

		expect(result).toEqual({ loaded: false, path: null });
		expect(load).not.toHaveBeenCalled();
	});
});
