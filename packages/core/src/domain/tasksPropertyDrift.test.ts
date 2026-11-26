import { describe, expect, it } from "vitest";

import {
	hasTasksPropertyDrift,
	reconcileTasksPropertyMap,
	type TaskPropertyFinding,
} from "./tasksPropertyDrift.js";
import type { NotionDatabaseSchema } from "../index.js";

// The reconciliation core for #1001, pure and unit-tested independently of the tool that
// calls it (mirrors dosConfigDrift.test.ts's split: I/O and severity in
// tools/checkDosConfigDrift.ts, the comparison itself here).

/** The personal Tasks DB schema as observed in #1001 — 'Assignee', not 'Owner'. */
const LIVE_PERSONAL_TASKS_SCHEMA: NotionDatabaseSchema = {
	properties: [
		{ name: "Task name", type: "title" },
		{ name: "Status", type: "status", options: ["Not started", "In progress", "Done"] },
		{ name: "Priority", type: "select", options: ["P0", "P1", "P2"] },
		{ name: "Due date", type: "date" },
		{ name: "Assignee", type: "people" },
		{ name: "Tags", type: "multi_select", options: ["launch-v1.0.0", "Mobile"] },
	],
};

describe("reconcileTasksPropertyMap", () => {
	it("reports every mapped abstract key that does not exist on the live database (#1001)", () => {
		// The exact #1001 shape: 'owner' mapped to 'Owner', which this database calls
		// 'Assignee'.
		const findings = reconcileTasksPropertyMap({ owner: "Owner" }, LIVE_PERSONAL_TASKS_SCHEMA);

		expect(findings).toContainEqual<TaskPropertyFinding>({
			abstractKey: "owner",
			mappedName: "Owner",
			status: "mapped_missing",
		});
		expect(hasTasksPropertyDrift(findings)).toBe(true);
	});

	it("finds no drift when every mapped key resolves to a real property", () => {
		const findings = reconcileTasksPropertyMap(
			{ owner: "Assignee", status: "Status", priority: "Priority" },
			LIVE_PERSONAL_TASKS_SCHEMA,
		);

		expect(findings).toContainEqual<TaskPropertyFinding>({
			abstractKey: "status",
			mappedName: "Status",
			status: "mapped_ok",
		});
		expect(findings).toContainEqual<TaskPropertyFinding>({
			abstractKey: "priority",
			mappedName: "Priority",
			status: "mapped_ok",
		});
		expect(findings).toContainEqual<TaskPropertyFinding>({
			abstractKey: "owner",
			mappedName: "Assignee",
			status: "mapped_ok",
		});
		expect(findings.filter((f) => f.status === "mapped_missing")).toEqual([]);
		expect(hasTasksPropertyDrift(findings)).toBe(false);
	});

	it("reports an unmapped key only when the database has a property under its fallback name", () => {
		// 'due' is unmapped; create_task's own fallback for it is 'Due date' (see
		// createTaskProperties.ts's DEFAULT_PROPERTY_NAMES), which this database has.
		// 'domain' is also unmapped, but nothing on this database is named 'Domain', so
		// it is not reported at all — there is nothing to say about it.
		const findings = reconcileTasksPropertyMap({ owner: "Assignee" }, LIVE_PERSONAL_TASKS_SCHEMA);

		expect(findings).toContainEqual({ abstractKey: "due", mappedName: null, status: "unmapped_available" });
		expect(findings.find((f) => f.abstractKey === "domain")).toBeUndefined();
	});

	it("reports an empty map as no findings at all — the tool's own severity ladder treats this case separately", () => {
		// An empty property_map still leaves every abstract key "unmapped"; whether that is
		// reported as informational depends only on whether the fallback name happens to
		// exist on the live database, same as any other unmapped key.
		const findings = reconcileTasksPropertyMap({}, LIVE_PERSONAL_TASKS_SCHEMA);

		expect(findings.every((f) => f.status === "unmapped_available")).toBe(true);
		expect(hasTasksPropertyDrift(findings)).toBe(false);
	});
});
