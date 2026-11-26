import { type AhkmsCapability, fetchCapabilityRows } from "./ahkmsSource.js";

// The body audit (#689): which registered capabilities currently have no body?
//
// The failure #689 documents is silent — a surface asked for `dos-hl`, got a
// one-line description back, and improvised the ritual rather than erroring. So
// the useful question is not "list rows with body: null" (many are fine) but
// "which rows PROMISE to be servable and are not". The split below is the whole
// point of the report:
//
//   BROKEN  storage_location kms-db / kms-repo — the registry claims to host this
//           capability, and capability_get({name}) returns "(no body stored)".
//           A surface without the local file has nothing to follow. This is the
//           #689 class of bug and every row here needs a body pushed.
//
//   POINTER storage_location claude / openai — an external owner holds the bytes
//           and the row is an index entry. body: null is the designed state; the
//           fallback rule says to fetch from storage_url. Listed for completeness,
//           not as a defect.
//
// Read-only. Never writes.

export type BodyGap = "broken" | "pointer";

export interface AuditRow {
	name: string;
	kind: string;
	storageLocation: string;
	storageUrl: string | null;
	surface: string[];
	gap: BodyGap;
}

export interface AuditReport {
	totalCapabilities: number;
	withBody: number;
	rows: AuditRow[];
}

/** A hosted row (kms-*) promises the registry serves the bytes; an indexed one doesn't. */
export function classifyBodyGap(storageLocation: string): BodyGap {
	return storageLocation.startsWith("kms-") ? "broken" : "pointer";
}

/** PURE core — takes rows, returns the report. Exercised directly by the tests. */
export function buildAudit(capabilities: AhkmsCapability[]): AuditReport {
	const bodyless = capabilities.filter((cap) => cap.body === null || cap.body.trim() === "");
	const rows: AuditRow[] = bodyless
		.map((cap) => ({
			name: cap.name,
			kind: cap.kind,
			storageLocation: cap.storageLocation,
			storageUrl: cap.storageUrl,
			surface: cap.surface,
			gap: classifyBodyGap(cap.storageLocation),
		}))
		.sort((a, b) => (a.gap === b.gap ? a.name.localeCompare(b.name) : a.gap === "broken" ? -1 : 1));

	return {
		totalCapabilities: capabilities.length,
		withBody: capabilities.length - bodyless.length,
		rows,
	};
}

export async function auditBodies(): Promise<AuditReport> {
	return buildAudit(await fetchCapabilityRows());
}

export function formatAudit(report: AuditReport): string {
	const broken = report.rows.filter((row) => row.gap === "broken");
	const pointers = report.rows.filter((row) => row.gap === "pointer");

	const lines: string[] = [
		"capability body audit (#689)",
		`${report.totalCapabilities} registered · ${report.withBody} with a body · ${report.rows.length} without`,
		"",
	];

	lines.push(`HOSTED BUT EMPTY — capability_get returns no body (${broken.length}):`);
	if (broken.length === 0) {
		lines.push("  (none — every kms-hosted capability serves a body)");
	} else {
		for (const row of broken) {
			lines.push(`  • ${row.name} [${row.kind}] ${row.storageLocation} surface=${row.surface.join("+") || "?"}${row.storageUrl ? ` -> ${row.storageUrl}` : ""}`);
		}
		lines.push("  A surface without the local file improvises from the description alone (#689).");
	}
	lines.push("");

	lines.push(`INDEXED POINTERS — body lives with an external owner, by design (${pointers.length}):`);
	if (pointers.length === 0) {
		lines.push("  (none)");
	} else {
		for (const row of pointers) {
			lines.push(`  • ${row.name} [${row.kind}] ${row.storageLocation} surface=${row.surface.join("+") || "?"}${row.storageUrl ? ` -> ${row.storageUrl}` : ""}`);
		}
	}

	return lines.join("\n");
}
