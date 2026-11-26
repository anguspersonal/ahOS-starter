import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DOS_SKILL_PATH = path.resolve(REPO_ROOT, ".claude/skills/dos/SKILL.md");

function sliceSection(content: string, startHeading: string, nextHeading?: string): string {
	const startIdx = content.indexOf(startHeading);
	if (startIdx === -1) {
		throw new Error(`Section not found: ${startHeading}`);
	}
	if (!nextHeading) {
		return content.slice(startIdx);
	}
	const endIdx = content.indexOf(nextHeading, startIdx + startHeading.length);
	if (endIdx === -1) {
		throw new Error(`Next section not found: ${nextHeading}`);
	}
	return content.slice(startIdx, endIdx);
}

describe("dos skill evidence-tier contract (#2230 / ADR-108 / ADR-109 / ADR-110)", () => {
	const skill = fs.readFileSync(DOS_SKILL_PATH, "utf8");

	it("Setup reads 4, 5, and 9 explicitly pass roles: ['narrative'] on knowledge_search", () => {
		const setup = sliceSection(skill, "## Setup", "## Mode detection");
		const read4 = sliceSection(setup, "4. **Fetch today's unconsumed atoms.**", "5. **Fetch the backlog slice**");
		const read5 = sliceSection(setup, "5. **Fetch the backlog slice**", "5a.");
		const read9 = sliceSection(setup, "9. **Read synthesis coverage for both domains.**", "10. **Read yesterday's summaries**");

		expect(read4).toMatch(/roles['"]?:\s*\[\s*['"]narrative['"]\s*\]/);
		expect(read5).toMatch(/roles['"]?:\s*\[\s*['"]narrative['"]\s*\]/);
		expect(read9).toMatch(/roles['"]?:\s*\[\s*['"]narrative['"]\s*\]/);
		expect(read9).toContain("dos_evidence_aggregate");
	});

	it("Setup read 5a is inserted between read 5 and read 6 without renumbering 6..12 and calls dos_evidence_aggregate for work and angus", () => {
		const setup = sliceSection(skill, "## Setup", "## Mode detection");
		const idx5 = setup.indexOf("5. **Fetch the backlog slice**");
		const idx5a = setup.indexOf("5a.");
		const idx6 = setup.indexOf("6. **Read the review queue.**");
		const idx12 = setup.indexOf("12. **System health.**");

		expect(idx5).toBeGreaterThan(-1);
		expect(idx5a).toBeGreaterThan(idx5);
		expect(idx6).toBeGreaterThan(idx5a);
		expect(idx12).toBeGreaterThan(idx6);

		const read5a = setup.slice(idx5a, idx6);
		expect(read5a).toContain("dos_evidence_aggregate");
		expect(read5a).toContain("work");
		expect(read5a).toContain("angus");
		expect(read5a).toContain("late_arrivals");
	});

	it("#561 unattended sweep defines candidate(D, domain) with all 4 closing kinds and stampable(D, domain) with material_total > 0", () => {
		const sweep = sliceSection(skill, "## Unattended fallback sweep (#561)", "## Empty-day handling");
		expect(sweep).toContain("synthesized");
		expect(sweep).toContain("synthesized_unattended");
		expect(sweep).toContain("evidence_aggregated");
		expect(sweep).toContain("evidence_aggregated_unattended");
		expect(sweep).toMatch(/material_total\s*>\s*0/);
		expect(sweep).toContain("Daily Log twin");
	});

	it("Step 4 folds the domain's evidence aggregate (F2-1, F3-1, F4-1) into the single Daily Log entry per domain", () => {
		const step4 = sliceSection(
			skill,
			"## Step 4: Draft the day summaries",
			"## Step 5: State Doc updates, per domain, from today and from the queue",
		);
		expect(step4).toContain("dos_evidence_aggregate");
		expect(step4).toContain("effective_at");
		expect(step4).toContain("arrived on");
		expect(step4).toContain("dated earlier");
		expect(step4).toContain("late_arrivals");
		expect(step4).toMatch(/own date|entry's date/i);
	});

	it("Step 5 / Step 6 State Doc review surfaces markers: 'unattended' (UNCONFIRMED) Daily Log entries before state_doc_update and consumed_by_state", () => {
		const step5 = sliceSection(
			skill,
			"## Step 5: State Doc updates, per domain, from today and from the queue",
			"## Step 6: Report draft, artefacts, reflection questions",
		);
		const step6 = sliceSection(
			skill,
			"## Step 6: Report draft, artefacts, reflection questions",
			"## Step 7: The one review gate",
		);
		const reviewSurface = step5 + "\n" + step6;

		expect(reviewSurface).toContain("unattended");
		expect(reviewSurface).toContain("UNCONFIRMED");
		expect(reviewSurface).toContain("evidence_aggregated_unattended");
		expect(reviewSurface).toContain("consumed_by_state");
	});

	it("Step 8c stamps evidence_aggregated (with run_id) once per day per domain on the Daily Log twin via external_link_create, never per evidence atom", () => {
		const step8c = sliceSection(
			skill,
			"### 8c. Hop 1: mark every atom considered",
			"### 8d. State Doc operations and Tasks DB writes",
		);
		expect(step8c).toContain("evidence_aggregated");
		expect(step8c).toContain("run_id");
		expect(step8c).toContain("external_link_create");
		expect(step8c).toContain("Daily Log twin");
		expect(step8c).toMatch(/never per\s+evidence atom/i);
	});
});

describe("dos skill Step 8b removal contract (#2317)", () => {
	const skill = fs.readFileSync(DOS_SKILL_PATH, "utf8");

	it("contains no heading starting with ### 8b. The entry's ahKMS twin", () => {
		expect(skill).not.toMatch(/^### 8b\. The entry's ahKMS twin/m);
	});

	it("between ### 8a and ### 8c. Hop 1, contains no capture({ with content_subtype daily_log and no external_link_create({ with kind daily_log", () => {
		const step8aTo8c = sliceSection(skill, "### 8a.", "### 8c. Hop 1");
		expect(step8aTo8c).not.toMatch(/capture\(\{[\s\S]*?["']content_subtype["']\s*:\s*["']daily_log["']/);
		expect(step8aTo8c).not.toMatch(/external_link_create\(\{[\s\S]*?["']kind["']\s*:\s*["']daily_log["']/);
	});

	it("between ### 8a and ### 8c. Hop 1, states that daily_log_create returns the twin artifact id and mentions twin: MISSING", () => {
		const step8aTo8c = sliceSection(skill, "### 8a.", "### 8c. Hop 1");
		expect(step8aTo8c).toContain("daily_log_create");
		expect(step8aTo8c).toMatch(/twin_artifact_id|twin artifact id/i);
		expect(step8aTo8c).toContain("twin: MISSING");
	});

	it("does not contain 'can never be added'", () => {
		expect(skill).not.toContain("can never be added");
	});

	it("Step 0 review-queue text names external_link_create with kind daily_log as the repair for a twin with no page pointer", () => {
		const step0 = sliceSection(skill, "## Step 0:", "## Step 1:");
		const reviewQueueIdx = step0.indexOf("**Review queue, per domain:**");
		expect(reviewQueueIdx).toBeGreaterThan(-1);
		const reviewQueueLine = step0.slice(reviewQueueIdx, step0.indexOf("\n- **State Docs:**", reviewQueueIdx));
		expect(reviewQueueLine).toContain("external_link_create");
		expect(reviewQueueLine).toContain("daily_log");
		expect(reviewQueueLine).toContain("no page pointer");
	});

	it("every daily_log_create({ call block in Step 8a passes write_twin: true", () => {
		const step8a = sliceSection(skill, "### 8a.", "### 8c. Hop 1");
		const matches = [...step8a.matchAll(/daily_log_create\(\{[\s\S]*?\}\)/g)];
		expect(matches.length).toBeGreaterThan(0);
		for (const m of matches) {
			expect(m[0]).toMatch(/["']?write_twin["']?\s*:\s*true/);
		}
	});
});

