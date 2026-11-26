import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import { createAhosDoctorAction } from "./ahosDoctor.js";
import type { DoctorPort } from "../../ports/doctor.js";
import type { DoctorCheck, DoctorFamily } from "./doctorReport.js";

function makeMockPort(overrides?: Partial<Record<DoctorFamily, () => Promise<DoctorCheck[]>>>): DoctorPort {
	const runners: Record<string, () => Promise<DoctorCheck[]>> = {
		credentials: async () => [
			{ family: "credentials", name: "notion_work", status: "ok", detail: "fine", fix: "" },
		],
		wiring: async () => [
			{ family: "wiring", name: "surface_role_map github", status: "warn", detail: "unmapped", fix: "add it" },
			{ family: "wiring", name: "action ledger chain", status: "ok", detail: "verified", fix: "" },
		],
		travels: async () => [
			{ family: "travels", name: "skill dos", status: "fail", detail: "stale", fix: "push" },
		],
		outcomes: async () => [
			{ family: "outcomes", name: "dos sweep closed work", status: "ok", detail: "closed", fix: "" },
		],
		...overrides,
	};
	return {
		run: vi.fn((family: DoctorFamily) => runners[family]()),
	};
}

describe("createAhosDoctorAction (#1602)", () => {
	it("runs every family by default and renders the verdict line", async () => {
		const port = makeMockPort();
		const action = createAhosDoctorAction(port);
		const output = await executeAction(action, {});

		expect(output.verdict).toBe("fail");
		expect(output.report).toContain("## credentials");
		expect(output.report).toContain("## wiring");
		expect(output.report).toContain("## travels");
		expect(output.report).toContain("## outcomes");
		expect(output.report.trim().split("\n").at(-1)).toBe("verdict: FAIL — 1 fail, 1 warn, 3 ok.");
	});

	it("runs only the requested families and deduplicates repeated entries", async () => {
		const port = makeMockPort();
		const action = createAhosDoctorAction(port);
		const output = await executeAction(action, { families: ["credentials", "credentials"] });

		expect(port.run).toHaveBeenCalledTimes(1);
		expect(port.run).toHaveBeenCalledWith("credentials");
		expect(output.verdict).toBe("ok");
		expect(output.report).toContain("verdict: OK — 0 fail, 0 warn, 1 ok.");
	});

	it("turns a family that throws into a failed check instead of losing the whole report", async () => {
		const port = makeMockPort({
			wiring: async () => {
				throw new Error("supabase down");
			},
		});
		const action = createAhosDoctorAction(port);
		const output = await executeAction(action, {});

		expect(output.report).toContain("[FAIL] wiring: could not run: supabase down");
		expect(output.report).toContain("## credentials");
		expect(output.report).toContain("## travels");
	});

	it("omitting families runs every family the port reports, including an extra ledger family", async () => {
		const run = vi.fn(async (family: DoctorFamily): Promise<DoctorCheck[]> => [
			{ family, name: `${family} check`, status: "ok", detail: "ok", fix: "" },
		]);
		const port: DoctorPort = {
			families: ["credentials", "wiring", "travels", "ledger" as DoctorFamily],
			run,
		};
		const action = createAhosDoctorAction(port);
		const output = await executeAction(action, {});

		expect(run).toHaveBeenCalledTimes(4);
		expect(run).toHaveBeenCalledWith("ledger");
		expect(output.report).toContain("## ledger");
		expect(output.report).toContain("verdict: OK — 0 fail, 0 warn, 4 ok.");
	});
});
