import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { needsReviewBandApproval } from "@ahkms/core";
import { describe, expect, it } from "vitest";
import { LEGACY_GATES } from "../actions/legacyGates.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const skillsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../.claude/skills",
);

const EXEMPT_SKILLS: Readonly<Record<string, string>> = {
	process_artifact: "archives only; never passes archive_only: false",
	"source-walkthrough":
		"names only drive_import_file with default cleanup; #1426 gates cleanup: 'delete' only",
};

function collectGatedToolNames(): Set<string> {
	const names = new Set<string>(Object.keys(LEGACY_GATES));
	for (const action of serverRegistry().list()) {
		// Exclude needsReviewBandApproval (ADR-079 optional confidence-band helper on
		// entity_create/entity_upsert/task_create, which returns false when confidence is omitted).
		if (action.needsApproval && action.needsApproval !== needsReviewBandApproval) {
			names.add(action.id);
		}
	}
	return names;
}

function readSkill(name: string): string {
	return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
}

function listSkills(): Array<{ name: string; body: string }> {
	return readdirSync(skillsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => ({
			name: entry.name,
			path: join(skillsDir, entry.name, "SKILL.md"),
		}))
		.filter((entry) => existsSync(entry.path))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => ({
			name: entry.name,
			body: readFileSync(entry.path, "utf8"),
		}));
}

function extractSection(markdown: string, heading: string): string {
	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start === -1) {
		throw new Error(`Heading not found: ${heading}`);
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,3}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

function namedGatedTools(body: string, gatedNames: ReadonlySet<string>): string[] {
	return [...gatedNames]
		.filter((name) => body.includes(`\`${name}\``) || body.includes(`\`${name}(`))
		.sort();
}

describe("repo skills calling gated tools (#1431)", () => {
	const gatedNames = collectGatedToolNames();

	it("1. collects the expected gated tools across LEGACY_GATES, serverRegistry, and entity actions", () => {
		for (const expected of [
			"drive_delete",
			"gmail_send_draft",
			"person_delete",
			"entity_bulk_delete",
			"entity_crud",
			"entity_delete",
		]) {
			expect(gatedNames.has(expected), `missing gated tool: ${expected}`).toBe(true);
		}
	});

	it("2. requires pending_approval and decision_id in every non-exempt skill naming a gated tool", () => {
		const skills = listSkills();
		const offenders: string[] = [];
		for (const skill of skills) {
			if (skill.name in EXEMPT_SKILLS) continue;
			const matched = namedGatedTools(skill.body, gatedNames);
			if (matched.length === 0) continue;
			if (!skill.body.includes("pending_approval") || !skill.body.includes("decision_id")) {
				offenders.push(`${skill.name} (names ${matched.join(", ")})`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("3. keeps the process_artifact and source-walkthrough exemptions true", () => {
		const processArtifact = readSkill("process_artifact");
		expect(processArtifact).not.toContain("archive_only");

		const sourceWalkthrough = readSkill("source-walkthrough");
		expect(sourceWalkthrough).not.toContain("cleanup");
		expect(namedGatedTools(sourceWalkthrough, gatedNames)).toEqual(["drive_import_file"]);
	});

	it("4. runs the Drive call before recording drive_action in route's After deciding section", () => {
		const section = extractSection(readSkill("route"), "## After deciding");
		const driveDeleteIdx = section.indexOf("`drive_delete`");
		const driveActionIdx = section.indexOf("`drive_action`");
		expect(driveDeleteIdx).toBeGreaterThanOrEqual(0);
		expect(driveActionIdx).toBeGreaterThanOrEqual(0);
		expect(driveDeleteIdx).toBeLessThan(driveActionIdx);
		expect(section).toContain("pending_approval");
	});

	it("5. documents pending_approval in golden-doc and cv send sections", () => {
		const goldenDocEmail = extractSection(
			readSkill("golden-doc"),
			"## Email rules (unattended sweep)",
		);
		expect(goldenDocEmail).toContain("pending_approval");

		const cvSend = extractSection(
			readSkill("cv"),
			"### 7. Tell the owner, and only the owner",
		);
		expect(cvSend).toContain("pending_approval");
	});

	it("6. documents pending_approval and the 50-row threshold in entity's Archive, Delete, Restore section", () => {
		const entityDeleteSection = extractSection(
			readSkill("entity"),
			"## Archive, Delete, Restore",
		);
		expect(entityDeleteSection).toContain("pending_approval");
		expect(entityDeleteSection).toContain("50");
	});
});
