import type { PlanningIndex } from "../../ports/planning.js";

/** Compact JSON formatting for planning reads. */
export function render(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function renderPlanningIndex(doc: PlanningIndex): string {
	const header = [
		`snapshot:  ${doc.snapshotId}`,
		`label:     ${doc.label ?? "(none)"}`,
		`saved:     ${doc.createdAt}`,
		`writable:  ${doc.writable.join(", ")}`,
	].join("\n");

	// The snapshot id leads every read because it is what a subsequent edit passes as
	// `baseSnapshotId` to turn a stale write into a refusal instead of an overwrite.
	if (doc.data) {
		return `${header}\n\n${render(doc.data)}`;
	}

	const sections = [`collections:\n${render(doc.collections ?? {})}`];
	if (doc.domains) {
		sections.push(`domains:\n${doc.domains.join(", ")}`);
	}
	if (doc.goals) {
		sections.push(`goals:\n${doc.goals.join(", ")}`);
	}
	if (doc.projectParents) {
		sections.push(`projectParents:\n${doc.projectParents.join(", ")}`);
	}

	return `${header}\n\n${sections.join("\n\n")}`;
}
