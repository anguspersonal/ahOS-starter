import { describe, expect, it } from "vitest";
import { renderDoctorReport, verdictFor, type DoctorCheck } from "./report.js";

const check = (over: Partial<DoctorCheck>): DoctorCheck => ({
	family: "credentials",
	name: "x",
	status: "ok",
	detail: "fine",
	fix: "",
	...over,
});

describe("verdictFor", () => {
	it("is fail when any check fails, whatever else passed", () => {
		expect(verdictFor([check({}), check({ status: "warn" }), check({ status: "fail" })])).toBe("fail");
	});

	it("is warn when nothing fails and something warns", () => {
		expect(verdictFor([check({}), check({ status: "warn" })])).toBe("warn");
	});

	it("is ok only when every check is ok", () => {
		expect(verdictFor([check({}), check({})])).toBe("ok");
	});

	it("is never ok for an empty run — nothing checked is not an all-clear", () => {
		expect(verdictFor([])).toBe("warn");
	});
});

describe("renderDoctorReport", () => {
	it("groups by family in a fixed order and lists failures first within a family", () => {
		const text = renderDoctorReport([
			check({ family: "travels", name: "skill a", status: "ok" }),
			check({ family: "credentials", name: "notion ok", status: "ok" }),
			check({ family: "credentials", name: "slack warn", status: "warn", fix: "set SLACK_X" }),
			check({ family: "wiring", name: "dos pointers", status: "fail", fix: "integration_set ..." }),
			check({ family: "credentials", name: "google fail", status: "fail", fix: "re-mint" }),
		]);

		const idx = (s: string) => text.indexOf(s);
		// families: credentials, wiring, travels
		expect(idx("## credentials")).toBeLessThan(idx("## wiring"));
		expect(idx("## wiring")).toBeLessThan(idx("## travels"));
		// within credentials: fail, then warn, then ok
		expect(idx("google fail")).toBeLessThan(idx("slack warn"));
		expect(idx("slack warn")).toBeLessThan(idx("notion ok"));
	});

	it("prints the fix on every non-ok check and never on an ok one", () => {
		const text = renderDoctorReport([
			check({ name: "bad", status: "fail", fix: "set GITHUB_TOKEN_INGEST" }),
			check({ name: "good", status: "ok", fix: "should not print" }),
		]);
		expect(text).toContain("fix: set GITHUB_TOKEN_INGEST");
		expect(text).not.toContain("should not print");
	});

	it("ends with exactly one verdict line carrying the counts", () => {
		const text = renderDoctorReport([
			check({ status: "fail" }),
			check({ status: "warn" }),
			check({ status: "ok" }),
			check({ status: "ok" }),
		]);
		const lines = text.trim().split("\n");
		expect(lines.at(-1)).toBe("verdict: FAIL — 1 fail, 1 warn, 2 ok.");
		expect(text.match(/^verdict:/gm)).toHaveLength(1);
	});
});
