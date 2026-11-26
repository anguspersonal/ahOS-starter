import { describe, expect, it } from "vitest";
import {
	EXPECTED_ROUTINES,
	type ExpectedRoutine,
	firingDate,
	missedFirings,
	ROUTINE_GRACE_HOURS,
	settledFirings,
} from "./expectedRoutines.js";

const routine = (key: string): ExpectedRoutine => {
	const found = EXPECTED_ROUTINES.find((r) => r.key === key);
	if (!found) throw new Error(`no expected Routine "${key}"`);
	return found;
};

const settled = (key: string, now: string) =>
	settledFirings(routine(key), new Date(now)).map((f) => f.toISOString());

describe("EXPECTED_ROUTINES (#2349)", () => {
	it("lists exactly the three Routines that run today, in order", () => {
		expect(EXPECTED_ROUTINES.map((r) => r.key)).toEqual(["sync day", "cv sweep", "golden-doc sweep"]);
	});

	it("carries each Routine's live trigger id and cron", () => {
		expect(EXPECTED_ROUTINES.map((r) => [r.key, r.triggerId, r.cron])).toEqual([
			["sync day", "trig_01D1ryfphosxkUdUNg8Fsaob", "0 16 * * *"],
			["cv sweep", "trig_01M6FeGRvWgKfwtBtYrWiTCM", "0 7 1 * *"],
			["golden-doc sweep", "trig_01V9K9SmzJWyGEMPTy2vhtxk", "0 7 2 * *"],
		]);
	});

	it("carries a structured schedule that says the same thing as the cron", () => {
		expect(EXPECTED_ROUTINES.map((r) => r.schedule)).toEqual([
			{ kind: "daily", hourUtc: 16, minuteUtc: 0 },
			{ kind: "monthly", dayOfMonth: 1, hourUtc: 7, minuteUtc: 0 },
			{ kind: "monthly", dayOfMonth: 2, hourUtc: 7, minuteUtc: 0 },
		]);
	});

	it("names the output each Routine produces", () => {
		expect(EXPECTED_ROUTINES.map((r) => r.output)).toEqual([
			{ kind: "proposal", tags: ["sync-proposal", "scope:day"] },
			{ kind: "sweep_email" },
			{ kind: "sweep_email" },
		]);
	});

	it("gives a run three hours before its firing is checked", () => {
		expect(ROUTINE_GRACE_HOURS).toBe(3);
	});
});

describe("settledFirings (#2349)", () => {
	it("daily: returns the 3 most recent, newest first, before today's firing", () => {
		expect(settled("sync day", "2026-11-21T10:00:00Z")).toEqual([
			"2026-11-20T16:00:00.000Z",
			"2026-11-19T16:00:00.000Z",
			"2026-11-18T16:00:00.000Z",
		]);
	});

	it("daily: a firing inside the grace period is not settled yet", () => {
		expect(settled("sync day", "2026-11-21T17:00:00Z")).toEqual([
			"2026-11-20T16:00:00.000Z",
			"2026-11-19T16:00:00.000Z",
			"2026-11-18T16:00:00.000Z",
		]);
	});

	it("daily: a firing is settled once the grace period has passed", () => {
		expect(settled("sync day", "2026-11-21T19:00:00Z")).toEqual([
			"2026-11-21T16:00:00.000Z",
			"2026-11-20T16:00:00.000Z",
			"2026-11-19T16:00:00.000Z",
		]);
	});

	it("daily: crosses a month boundary", () => {
		expect(settled("sync day", "2026-12-02T10:00:00Z")).toEqual([
			"2026-12-01T16:00:00.000Z",
			"2026-11-30T16:00:00.000Z",
			"2026-11-29T16:00:00.000Z",
		]);
	});

	it("monthly: returns the 1 most recent firing", () => {
		expect(settled("cv sweep", "2026-11-21T10:00:00Z")).toEqual(["2026-11-01T07:00:00.000Z"]);
	});

	it("monthly: this month's firing inside the grace period is not settled yet", () => {
		expect(settled("cv sweep", "2026-12-01T08:00:00Z")).toEqual(["2026-11-01T07:00:00.000Z"]);
	});

	it("monthly: this month's firing is settled once the grace period has passed", () => {
		expect(settled("cv sweep", "2026-12-01T10:00:00Z")).toEqual(["2026-12-01T07:00:00.000Z"]);
	});

	it("monthly: before this month's firing, the last one is last month's", () => {
		expect(settled("golden-doc sweep", "2026-11-02T06:00:00Z")).toEqual(["2026-10-02T07:00:00.000Z"]);
	});

	it("monthly: crosses a year boundary", () => {
		expect(settled("cv sweep", "2027-01-01T03:00:00Z")).toEqual(["2026-12-01T07:00:00.000Z"]);
	});
});

describe("firingDate (#2349)", () => {
	it("is the firing's UTC date", () => {
		expect(firingDate(new Date("2026-11-20T16:00:00Z"))).toBe("2026-11-20");
	});
});

describe("missedFirings (#2349)", () => {
	const firings = [
		new Date("2026-11-20T16:00:00Z"),
		new Date("2026-11-19T16:00:00Z"),
		new Date("2026-11-18T16:00:00Z"),
	];

	it("returns only the firings that produced nothing, in the same order", () => {
		const produced = new Set(["2026-11-19"]);
		expect(missedFirings(firings, (f) => produced.has(firingDate(f)))).toEqual([firings[0], firings[2]]);
	});

	it("is empty when every firing produced its output", () => {
		expect(missedFirings(firings, () => true)).toEqual([]);
	});
});
