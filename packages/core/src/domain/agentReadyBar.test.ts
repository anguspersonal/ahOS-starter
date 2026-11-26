import { describe, expect, it } from "vitest";
import {
	evaluateIssueReadiness,
	AGENT_READY_CRITERIA,
	BAR_VERSION,
	type ReadinessEvaluation,
} from "./agentReadyBar.js";

describe("agentReadyBar (v7)", () => {
	const validRepoFiles = [
		"packages/core/src/index.ts",
		"packages/core/package.json",
		"packages/mcp-server/src/server.ts",
		"docs/ADRs/ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md",
		"docs/ADRs/ADR102_Operating_Model_Architect_Owner_Executor.md",
	];

	const sampleValidIssueBody = `
## Goal

Add agent-ready bar validator to core per ADR-102.

## Context

We need a deterministic evaluation of issue readiness to prevent ungrounded work.

## Files it may touch

• \`packages/core/src/domain/agentReadyBar.ts\` (new)
• \`packages/core/src/domain/agentReadyBar.test.ts\` (new)
• \`packages/core/src/index.ts\` (exports)

## Files it must not touch

• \`packages/mcp-server/**\`
• \`packages/worker/**\`

## Acceptance test (TDD: Red on dev)

\`\`\`bash
npx vitest run --root packages/core src/domain/agentReadyBar.test.ts
\`\`\`

## Done when

[ ] \`evaluateIssueReadiness\` is exported from \`@ahkms/core\`.
[ ] Acceptance test passes.

## Out of scope

• GitHub Action workflow.

## Stop if

• Diff exceeds 300 lines.

## Size

XS (~150 lines implementation).
`;

	it("exports BAR_VERSION = 7 and the 6 criteria with expected ids", () => {
		expect(BAR_VERSION).toBe(7);
		expect(AGENT_READY_CRITERIA).toHaveLength(6);
		const ids = AGENT_READY_CRITERIA.map((c) => c.id);
		expect(ids).toEqual([
			"architecture",
			"one_person",
			"one_run",
			"verification",
			"clarity",
			"grounded",
		]);
	});

	it("evaluates a valid ADR-102 work packet as ready under Bar v7", () => {
		const result: ReadinessEvaluation = evaluateIssueReadiness(
			sampleValidIssueBody,
			validRepoFiles,
		);

		expect(result.ready).toBe(true);
		expect(result.version).toBe(7);
		expect(result.missing).toHaveLength(0);
		expect(result.criteria.architecture.passed).toBe(true);
		expect(result.criteria.one_person.passed).toBe(true);
		expect(result.criteria.one_run.passed).toBe(true);
		expect(result.criteria.verification.passed).toBe(true);
		expect(result.criteria.clarity.passed).toBe(true);
		expect(result.criteria.grounded.passed).toBe(true);

		expect(result.evidenceComment).toContain("### Agent-ready (bar v7)");
		expect(result.evidenceComment).toContain("Architecture: pass");
		expect(result.evidenceComment).toContain("One person: pass");
		expect(result.evidenceComment).toContain("One run: pass");
		expect(result.evidenceComment).toContain("Verification: pass");
		expect(result.evidenceComment).toContain("Clarity: pass");
		expect(result.evidenceComment).toContain("Grounded: pass");
	});

	it("fails clarity and verification when required sections are missing", () => {
		const missingSectionsBody = `
## Goal
Do something.

## Files it may touch
• \`packages/core/src/index.ts\`
`;
		const result = evaluateIssueReadiness(missingSectionsBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.clarity.passed).toBe(false);
		expect(result.criteria.verification.passed).toBe(false);
		expect(result.missing).toContain("Missing required section: Acceptance test");
		expect(result.missing).toContain("Missing required section: Done when");
		expect(result.missing).toContain("Missing required section: Size");
		expect(result.evidenceComment).toContain("Verification: fail");
		expect(result.evidenceComment).toContain("Clarity: fail");
	});

	it("fails grounded check when target file does not exist in repo and is not marked as new", () => {
		const ungroundedBody = sampleValidIssueBody.replace(
			"• `packages/core/src/index.ts` (exports)",
			"• `packages/core/src/nonExistentFile.ts`",
		);

		const result = evaluateIssueReadiness(ungroundedBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.grounded.passed).toBe(false);
		expect(result.missing).toContain(
			"Target file 'packages/core/src/nonExistentFile.ts' does not exist in repository",
		);
		expect(result.evidenceComment).toContain("Grounded: fail");
	});

	it("passes grounded check when non-existing target file is explicitly declared as (new) with a resolving parent directory", () => {
		const newFilesBody = sampleValidIssueBody;
		const result = evaluateIssueReadiness(newFilesBody, validRepoFiles);

		expect(result.criteria.grounded.passed).toBe(true);
		expect(result.packet?.filesMayTouch.some((f) => f.isNew)).toBe(true);
	});

	it("fails grounded check (Bar v2/v7) when a (new) file is under a non-existent package/parent directory", () => {
		const phantomNewBody = sampleValidIssueBody.replace(
			"• `packages/core/src/domain/agentReadyBar.ts` (new)",
			"• `packages/phantom-pkg/src/domain/agentReadyBar.ts` (new)",
		);

		const result = evaluateIssueReadiness(phantomNewBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.grounded.passed).toBe(false);
		expect(result.missing).toContain(
			"Parent directory for new file 'packages/phantom-pkg/src/domain/agentReadyBar.ts' does not exist in repository",
		);
	});

	it("recognizes annotated new file markers like (new: ...) and (create: ...)", () => {
		const annotatedNewBody = sampleValidIssueBody
			.replace(
				"• `packages/core/src/domain/agentReadyBar.ts` (new)",
				"• `packages/core/src/domain/agentReadyBar.ts` (new: core validator)",
			)
			.replace(
				"• `packages/core/src/domain/agentReadyBar.test.ts` (new)",
				"• `packages/core/src/domain/agentReadyBar.test.ts` (create: unit tests)",
			);

		const result = evaluateIssueReadiness(annotatedNewBody, validRepoFiles);

		expect(result.ready).toBe(true);
		expect(result.criteria.grounded.passed).toBe(true);
		expect(result.packet?.filesMayTouch.filter((f) => f.isNew)).toHaveLength(2);
	});

	it("fails grounded and clarity when placeholder tokens are present", () => {
		const placeholderBody = sampleValidIssueBody.replace(
			"Add agent-ready bar validator to core per ADR-102.",
			"Add agent-ready bar validator to core. Details TBD later with placeholder data.",
		);

		const result = evaluateIssueReadiness(placeholderBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.grounded.passed).toBe(false);
		expect(result.missing.some((m) => m.toLowerCase().includes("placeholder") || m.includes("TBD"))).toBe(true);
	});

	it("fails one_run check when size exceeds M (e.g. Size L or XL)", () => {
		const largeSizeBody = sampleValidIssueBody.replace("Size\n\nXS", "Size\n\nL (> 500 lines across 10 files)");

		const result = evaluateIssueReadiness(largeSizeBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.one_run.passed).toBe(false);
		expect(result.missing).toContain("Size 'L' exceeds maximum allowed size 'M' for a single run (~300 lines)");
	});

	it("fails clarity check when body poses open questions ('should we')", () => {
		const openQuestionBody = sampleValidIssueBody.replace(
			"## Out of scope\n\n• GitHub Action workflow.",
			"## Out of scope\n\nShould we also do GitHub Action workflow or wait for user input?",
		);

		const result = evaluateIssueReadiness(openQuestionBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.clarity.passed).toBe(false);
		expect(result.missing.some((m) => m.includes("open question"))).toBe(true);
	});

	it("fails clarity check (Bar v5/v7) when body declares an open blocker ('Reopens when: #N' or 'blocked-by #N')", () => {
		const blockedBody = `${sampleValidIssueBody}\nReopens when: #1618\n`;
		const result = evaluateIssueReadiness(blockedBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.clarity.passed).toBe(false);
		expect(result.criteria.clarity.reason).toContain("#1618");
		expect(result.criteria.clarity.reason).toContain("status:blocked");
	});

	it("fails one_person when human console or credential steps are present in Goal or Done when", () => {
		const humanStepBody = sampleValidIssueBody.replace(
			"## Done when\n\n[ ] `evaluateIssueReadiness` is exported from `@ahkms/core`.\n[ ] Acceptance test passes.",
			"## Done when\n\n[ ] Configure AWS secrets in the cloud console manually.\n[ ] Acceptance test passes.",
		);

		const result = evaluateIssueReadiness(humanStepBody, validRepoFiles);

		expect(result.ready).toBe(false);
		expect(result.criteria.one_person.passed).toBe(false);
		expect(result.missing.some((m) => m.toLowerCase().includes("human"))).toBe(true);
	});

	it("supports optional Intended behaviour changes and Human verifies sections (Bar v3/v7) without failing one_person", () => {
		const v3SectionsBody = `${sampleValidIssueBody}
## Intended behaviour changes
- Existing unit tests asserting \`bar v1\` are updated to assert \`bar v7\`.

## Human verifies
- Verify the GitHub comment renders cleanly on the next issue edit.
`;

		const result = evaluateIssueReadiness(v3SectionsBody, validRepoFiles);

		expect(result.ready).toBe(true);
		expect(result.criteria.one_person.passed).toBe(true);
		expect(result.packet?.intendedBehaviourChanges).toEqual([
			"Existing unit tests asserting `bar v1` are updated to assert `bar v7`.",
		]);
		expect(result.packet?.humanVerifies).toEqual([
			"Verify the GitHub comment renders cleanly on the next issue edit.",
		]);
	});

	it("fails architecture check (Bar v7) when adding a (new) cadence outside core or a (new) legacy tool in mcp-server", () => {
		const badCadenceBody = sampleValidIssueBody.replace(
			"• `packages/core/src/domain/agentReadyBar.ts` (new)",
			"• `packages/mcp-server/src/schedule/newCadence.ts` (new)",
		);
		const cadenceResult = evaluateIssueReadiness(badCadenceBody, validRepoFiles);
		expect(cadenceResult.ready).toBe(false);
		expect(cadenceResult.criteria.architecture.passed).toBe(false);
		expect(cadenceResult.criteria.architecture.reason).toContain("packages/core/src/engine/cadences/");

		const badToolBody = sampleValidIssueBody.replace(
			"• `packages/core/src/domain/agentReadyBar.ts` (new)",
			"• `packages/mcp-server/src/tools/newLegacyTool.ts` (new)",
		);
		const toolResult = evaluateIssueReadiness(badToolBody, validRepoFiles);
		expect(toolResult.ready).toBe(false);
		expect(toolResult.criteria.architecture.passed).toBe(false);
		expect(toolResult.criteria.architecture.reason).toContain("packages/core/src/actions/");
	});

	it("enforces 5-layer Recommended Capability Anatomy (ADR-115, Bar v7) when ## Recommended Capability Anatomy is present", () => {
		const incompleteRcaBody = `${sampleValidIssueBody}
## Recommended Capability Anatomy
- **1. Policy & Decision Boundary**: ADR-115.
- **2. Canonical State, Schema & Ledger**: Supabase entities table.
`;
		const failResult = evaluateIssueReadiness(incompleteRcaBody, validRepoFiles);
		expect(failResult.ready).toBe(false);
		expect(failResult.criteria.architecture.passed).toBe(false);
		expect(failResult.criteria.architecture.reason).toContain("Layer 3");
		expect(failResult.criteria.architecture.reason).toContain("Layer 4");
		expect(failResult.criteria.architecture.reason).toContain("Layer 5");

		const completeRcaBody = `${sampleValidIssueBody}
## Recommended Capability Anatomy
- **1. Policy & Decision Boundary**: Governed by ADR-102 and ADR-115.
- **2. Canonical State, Schema & Ledger**: Pure domain evaluator in \`@ahkms/core\`; N/A — no new DB table.
- **3. Agent / MCP Actions & Discovery**: Used by \`groom-issues\` skill and \`check-agent-ready-issue.js\`.
- **4. Sync & Projection Mechanism**: N/A — single-plane evaluator in repo.
- **5. Enforcement Guards**: Verified by \`agentReadyBar.test.ts\` and \`agent-ready-gate.yml\`.
`;
		const passResult = evaluateIssueReadiness(completeRcaBody, validRepoFiles);
		expect(passResult.ready).toBe(true);
		expect(passResult.criteria.architecture.passed).toBe(true);
	});

	it("fails clarity check when body contains opaque shorthand rule or decision codes", () => {
		for (const code of ["R11", "R5", "G1", "L4", "Q1(b)"]) {
			const shorthandBody = sampleValidIssueBody.replace(
				"Add agent-ready bar validator to core per ADR-102.",
				`Add agent-ready bar validator to core so it satisfies ${code}.`,
			);

			const result = evaluateIssueReadiness(shorthandBody, validRepoFiles);

			expect(result.ready).toBe(false);
			expect(result.criteria.clarity.passed).toBe(false);
			expect(result.criteria.clarity.reason).toContain(code);
			expect(result.criteria.clarity.reason).toContain("plain English");
			expect(result.missing.some((m) => m.includes(code) && m.includes("plain English"))).toBe(true);
		}
	});

	it("allows legitimate repository tokens (ADR-102, L2SummaryPort, v7, S, XS) under shorthand clarity check", () => {
		const normalTokensBody = sampleValidIssueBody.replace(
			"Add agent-ready bar validator to core per ADR-102.",
			"Add agent-ready bar validator (v7) to core per ADR-102 alongside L2SummaryPort (sizes S and XS).",
		);

		const result = evaluateIssueReadiness(normalTokensBody, validRepoFiles);

		expect(result.ready).toBe(true);
		expect(result.criteria.clarity.passed).toBe(true);
	});
});
