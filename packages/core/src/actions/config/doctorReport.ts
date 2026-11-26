// The ahos_doctor result shape and its rendering (#1024).
//
// Every check, whatever family it belongs to, answers in the same four fields the grill
// on #1024 fixed: a name, a status, what was found, and the exact fix — an env var
// name, a config key, or a console step. A check that cannot say how to fix what it
// found is a complaint, not a check, so `fix` is required on anything not ok.

// `outcomes` (#2268) is different in kind from the other three. They ask "is it set up?";
// it asks "did the routine produce what it should have?". A routine can be perfectly
// wired and still write nothing, which is how the dos sweep stayed dark for two weeks.
export const DOCTOR_FAMILIES = ["credentials", "wiring", "travels", "outcomes"] as const;
export type DoctorFamily = (typeof DOCTOR_FAMILIES)[number];

export type DoctorStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
	family: DoctorFamily;
	name: string;
	status: DoctorStatus;
	/** What was found. Never a secret value: names, counts, identities, ids at most. */
	detail: string;
	/** The exact next step. Printed only when status is not ok. */
	fix: string;
};

const STATUS_RANK: Record<DoctorStatus, number> = { fail: 0, warn: 1, ok: 2 };

/**
 * The run's verdict. An empty run is `warn`, never `ok`: a doctor that checked nothing
 * (every family filtered out, or every loader threw before producing a row) must not
 * read as a clean bill of health.
 */
export function verdictFor(checks: DoctorCheck[]): DoctorStatus {
	if (checks.length === 0) return "warn";
	if (checks.some((c) => c.status === "fail")) return "fail";
	if (checks.some((c) => c.status === "warn")) return "warn";
	return "ok";
}

function renderCheck(c: DoctorCheck): string[] {
	const lines = [`- [${c.status.toUpperCase()}] ${c.name}: ${c.detail}`];
	if (c.status !== "ok" && c.fix) lines.push(`  fix: ${c.fix}`);
	return lines;
}

/** Grouped by family (fixed order), failures first within each, one verdict line last. */
export function renderDoctorReport(checks: DoctorCheck[]): string {
	const lines: string[] = ["ahos_doctor — read-only system health (#1024). Nothing was changed."];

	const extraFamilies = [...new Set(checks.map((c) => c.family))].filter(
		(f) => !(DOCTOR_FAMILIES as readonly string[]).includes(f),
	);
	for (const family of [...DOCTOR_FAMILIES, ...extraFamilies]) {
		const rows = checks
			.filter((c) => c.family === family)
			.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
		if (rows.length === 0) continue;
		lines.push("", `## ${family}`, ...rows.flatMap(renderCheck));
	}

	const count = (s: DoctorStatus) => checks.filter((c) => c.status === s).length;
	lines.push(
		"",
		`verdict: ${verdictFor(checks).toUpperCase()} — ${count("fail")} fail, ${count("warn")} warn, ${count("ok")} ok.`,
	);
	return lines.join("\n");
}
