import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	loadHandshakeReads,
	HANDSHAKE_READ_TIMEOUT_MS,
} from "../handshakeReads.js";
import type { HotTierRow } from "../hotTier.js";

describe("loadHandshakeReads", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const sampleToneRules = ["Tone rule 1", "Tone rule 2"];
	const sampleHotRows: HotTierRow[] = [
		{
			id: "entity-1",
			entity_type: "concept",
			title: "Active Project",
			description: "Hot entity description",
			properties: {},
			aliases: ["AP"],
		},
	];

	it("exports HANDSHAKE_READ_TIMEOUT_MS as 3000 ms", () => {
		expect(HANDSHAKE_READ_TIMEOUT_MS).toBe(3000);
	});

	// Case 1: Both loaders resolve quickly: their values pass through unchanged.
	it("passes through values unchanged when both loaders resolve quickly", async () => {
		const loadToneRules = vi.fn().mockResolvedValue(sampleToneRules);
		const loadHotTier = vi.fn().mockResolvedValue(sampleHotRows);

		const resultPromise = loadHandshakeReads({
			loaders: { loadToneRules, loadHotTier },
		});

		// Let microtasks run
		await vi.runAllTimersAsync();
		const [toneRules, hotRows] = await resultPromise;

		expect(toneRules).toEqual(sampleToneRules);
		expect(hotRows).toEqual(sampleHotRows);
		expect(loadToneRules).toHaveBeenCalledTimes(1);
		expect(loadHotTier).toHaveBeenCalledTimes(1);
	});

	// Case 2: loadToneRules never resolves: the handshake reads resolve within the budget with tone [] and the hot rows intact.
	it("resolves within budget with tone [] and hot rows intact when loadToneRules never resolves", async () => {
		const loadToneRules = vi.fn().mockImplementation(() => new Promise(() => {}));
		const loadHotTier = vi.fn().mockResolvedValue(sampleHotRows);

		const resultPromise = loadHandshakeReads({
			loaders: { loadToneRules, loadHotTier },
		});

		// Advance time by the budget
		await vi.advanceTimersByTimeAsync(HANDSHAKE_READ_TIMEOUT_MS);
		const [toneRules, hotRows] = await resultPromise;

		expect(toneRules).toEqual([]);
		expect(hotRows).toEqual(sampleHotRows);
	});

	// Case 3: loadHotTier never resolves: the same, the other way round.
	it("resolves within budget with tone intact and hot rows [] when loadHotTier never resolves", async () => {
		const loadToneRules = vi.fn().mockResolvedValue(sampleToneRules);
		const loadHotTier = vi.fn().mockImplementation(() => new Promise(() => {}));

		const resultPromise = loadHandshakeReads({
			loaders: { loadToneRules, loadHotTier },
		});

		// Advance time by the budget
		await vi.advanceTimersByTimeAsync(HANDSHAKE_READ_TIMEOUT_MS);
		const [toneRules, hotRows] = await resultPromise;

		expect(toneRules).toEqual(sampleToneRules);
		expect(hotRows).toEqual([]);
	});

	// Case 4: A timed-out read logs one [mcp-http] line to stderr naming which read ran long and the budget.
	it("logs one [mcp-http] line to stderr naming which read ran long and the budget when a read times out", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const loadToneRules = vi.fn().mockImplementation(() => new Promise(() => {}));
		const loadHotTier = vi.fn().mockResolvedValue(sampleHotRows);

		const resultPromise = loadHandshakeReads({
			loaders: { loadToneRules, loadHotTier },
			timeoutMs: HANDSHAKE_READ_TIMEOUT_MS,
		});

		await vi.advanceTimersByTimeAsync(HANDSHAKE_READ_TIMEOUT_MS);
		await resultPromise;

		const matchingLogs = consoleSpy.mock.calls
			.map((call) => call.join(" "))
			.filter(
				(msg) =>
					msg.includes("[mcp-http]") &&
					msg.includes("loadToneRules") &&
					msg.includes("3000ms"),
			);

		expect(matchingLogs).toHaveLength(1);
	});
});
