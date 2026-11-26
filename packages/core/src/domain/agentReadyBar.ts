/**
 * Agent-ready bar validator and criteria definitions for ahOS (Bar v7).
 *
 * Implements the deterministic evaluation of issue bodies against ADR-102
 * work packet standards, ADR-115 Recommended Capability Anatomy (RCA), and
 * the 6 agent-ready criteria (aligned with Bar v7 across ahOS and Work,
 * adapted to ahOS's ADR-101/ADR-102/ADR-115 conventions).
 *
 * Isomorphic: pure domain logic taking issue markdown and a repository file list,
 * with zero dependencies on Node runtime or file systems.
 */

export interface CriterionDefinition {
	readonly id: string;
	readonly title: string;
	readonly intent: string;
}

export const AGENT_READY_CRITERIA: readonly CriterionDefinition[] = [
	{
		id: "architecture",
		title: "Not an anti-pattern",
		intent:
			"Follows ahOS architecture principles (ADR-100/101/102/115), single responsibility, central systems, and 5-layer RCA when introducing a new system capability.",
	},
	{
		id: "one_person",
		title: "One person can do it",
		intent:
			"Contains zero blocking human console, credential, or external vendor steps (post-merge UAT belongs in Human verifies).",
	},
	{
		id: "one_run",
		title: "Achievable in one run",
		intent: "Bounded scope (size XS, S, or M; diff <= ~300 lines) achievable in one PR.",
	},
	{
		id: "verification",
		title: "Clear verification and test plan",
		intent:
			"Names explicit verification commands, an acceptance test red on dev, and lists any intentional test behaviour changes.",
	},
	{
		id: "clarity",
		title: "Clear what to build",
		intent:
			"Contains required work packet sections, zero open questions or opaque shorthand codes, and no open blockers.",
	},
	{
		id: "grounded",
		title: "Grounded in the repository",
		intent:
			"Target files resolve against repository state, new files have a resolving parent directory, and body contains no placeholders.",
	},
] as const;

export interface TargetFileSpec {
	readonly path: string;
	readonly isNew: boolean;
	readonly annotation?: string;
}

export interface ParsedWorkPacket {
	readonly goal?: string;
	readonly context?: string;
	readonly filesMayTouch: TargetFileSpec[];
	readonly filesMustNotTouch: string[];
	readonly acceptanceTest?: string;
	readonly doneWhen: string[];
	readonly outOfScope?: string[];
	readonly stopIf?: string[];
	readonly size?: string;
	readonly intendedBehaviourChanges?: string[];
	readonly humanVerifies?: string[];
	readonly recommendedCapabilityAnatomy?: string;
}

export interface CriterionResult {
	readonly id: string;
	readonly title: string;
	readonly passed: boolean;
	readonly reason?: string;
	readonly evidence?: string;
}

export interface ReadinessEvaluation {
	readonly ready: boolean;
	readonly version: number;
	readonly criteria: Record<string, CriterionResult>;
	readonly missing: string[];
	readonly evidenceComment: string;
	readonly packet?: ParsedWorkPacket;
}

export const BAR_VERSION = 7;

/**
 * Extract sections from a markdown document by heading 2 (`## Section`).
 */
function parseMarkdownSections(markdown: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = markdown.split(/\r?\n/);
	let currentHeading: string | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^##\s+([^#\n]+)$/);
		if (headingMatch) {
			if (currentHeading) {
				sections.set(currentHeading.trim().toLowerCase(), currentContent.join("\n").trim());
			}
			currentHeading = headingMatch[1].trim();
			currentContent = [];
		} else if (currentHeading) {
			currentContent.push(line);
		}
	}

	if (currentHeading) {
		sections.set(currentHeading.trim().toLowerCase(), currentContent.join("\n").trim());
	}

	return sections;
}

/**
 * Parse bulleted file paths from section text.
 */
function parseFileSpecs(sectionText?: string): TargetFileSpec[] {
	if (!sectionText) return [];
	const files: TargetFileSpec[] = [];
	const lines = sectionText.split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("•") && !trimmed.startsWith("-") && !trimmed.startsWith("*")) {
			continue;
		}

		// Extract backticked path or bare token
		const backtickMatch = trimmed.match(/[`'"]([^`'"]+)[`'"]/);
		const rawToken = backtickMatch ? backtickMatch[1] : trimmed.replace(/^[•\-*]\s*/, "").split(/\s+/)[0];
		if (!rawToken || rawToken.includes("**")) continue;

		const cleanPath = rawToken.trim();
		const isNew = /\(\s*(?:new|create)(?:\b|[\s:,-])/i.test(trimmed);
		const annotationMatch = trimmed.match(/\(([^)]+)\)/);
		const annotation = annotationMatch ? annotationMatch[1].trim() : undefined;

		files.push({
			path: cleanPath,
			isNew,
			annotation,
		});
	}

	return files;
}

/**
 * Parse non-glob file or pattern strings.
 */
function parseListItems(sectionText?: string): string[] {
	if (!sectionText) return [];
	return sectionText
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.startsWith("•") || l.startsWith("-") || l.startsWith("*") || l.startsWith("[ ]") || l.startsWith("- [ ]"))
		.map((l) => l.replace(/^[•\-*]\s*/, "").trim());
}

/**
 * Parse issue body into structured ADR-102 work packet (Bar v7).
 */
export function parseWorkPacket(issueBody: string): ParsedWorkPacket {
	const sections = parseMarkdownSections(issueBody);

	// Find section by partial name (e.g. "acceptance test (tdd: red on dev)")
	const findSection = (prefix: string): string | undefined => {
		for (const [key, val] of sections.entries()) {
			if (key.startsWith(prefix)) return val;
		}
		return undefined;
	};

	const goal = findSection("goal");
	const context = findSection("context");
	const filesMayTouch = parseFileSpecs(findSection("files it may touch"));
	const filesMustNotTouch = parseListItems(findSection("files it must not touch"));
	const acceptanceTest = findSection("acceptance test");
	const doneWhen = parseListItems(findSection("done when") || findSection("acceptance"));
	const outOfScope = parseListItems(findSection("out of scope"));
	const stopIf = parseListItems(findSection("stop if"));
	const size = findSection("size");
	const intendedBehaviourChangesSection =
		findSection("intended behaviour changes") || findSection("intended behavior changes");
	const intendedBehaviourChanges = intendedBehaviourChangesSection
		? parseListItems(intendedBehaviourChangesSection)
		: undefined;
	const humanVerifiesSection = findSection("human verifies");
	const humanVerifies = humanVerifiesSection ? parseListItems(humanVerifiesSection) : undefined;
	const recommendedCapabilityAnatomy =
		findSection("recommended capability anatomy") || findSection("rca");

	return {
		goal,
		context,
		filesMayTouch,
		filesMustNotTouch,
		acceptanceTest,
		doneWhen,
		outOfScope,
		stopIf,
		size,
		intendedBehaviourChanges,
		humanVerifies,
		recommendedCapabilityAnatomy,
	};
}

/**
 * Checks whether a `(new)` file path has a resolving parent directory (or parent-of-parent
 * when creating a single new subfolder inside an existing module tree) in `repoFileList` (Bar v2/v7).
 */
function hasResolvingParentDirectory(filePath: string, repoFileList: readonly string[]): boolean {
	if (repoFileList.length === 0) return true;
	const lastSlash = filePath.lastIndexOf("/");
	if (lastSlash <= 0) return true; // Root-level file

	const parentDir = filePath.slice(0, lastSlash);
	const parentPrefix = `${parentDir}/`;
	if (repoFileList.some((p) => p.startsWith(parentPrefix))) {
		return true;
	}

	const grandParentSlash = parentDir.lastIndexOf("/");
	if (grandParentSlash > 0) {
		const grandParentPrefix = `${parentDir.slice(0, grandParentSlash)}/`;
		if (repoFileList.some((p) => p.startsWith(grandParentPrefix))) {
			return true;
		}
	}

	return false;
}

const RCA_LAYER_PATTERNS: readonly { label: string; regex: RegExp }[] = [
	{ label: "Layer 1 (Policy & Decision Boundary)", regex: /\b(?:policy|decision\s+boundary|layer\s*1)\b/i },
	{ label: "Layer 2 (Canonical State, Schema & Ledger)", regex: /\b(?:canonical\s+state|schema|ledger|layer\s*2)\b/i },
	{ label: "Layer 3 (Agent / MCP Actions & Discovery)", regex: /\b(?:actions|discovery|layer\s*3)\b/i },
	{ label: "Layer 4 (Sync & Projection Mechanism)", regex: /\b(?:sync|projection|layer\s*4)\b/i },
	{ label: "Layer 5 (Enforcement Guards)", regex: /\b(?:enforcement|guards|layer\s*5)\b/i },
];

/**
 * Pure deterministic evaluator for issue readiness (ahOS Bar v7).
 *
 * @param issueBody The raw markdown body of the issue.
 * @param repoFileList List of known repo relative paths from the base branch (e.g. `git ls-files`).
 */
export function evaluateIssueReadiness(
	issueBody: string,
	repoFileList: readonly string[] = [],
): ReadinessEvaluation {
	const packet = parseWorkPacket(issueBody);
	const missing: string[] = [];
	const repoSet = new Set(repoFileList);

	// 1. Architecture check (ADR-100/101/102 central-system boundaries + ADR-115 RCA v7)
	let archPassed = true;
	const archNotes: string[] = [];

	for (const file of packet.filesMayTouch) {
		if (
			file.isNew &&
			(file.path.startsWith("packages/mcp-server/src/schedule/") ||
				file.path.startsWith("packages/worker/src/schedule/"))
		) {
			archPassed = false;
			const reason = `New cadence file '${file.path}' violates ADR-101/ADR-102 (new cadences must live in packages/core/src/engine/cadences/)`;
			archNotes.push(reason);
			missing.push(reason);
		}
		if (file.isNew && file.path.startsWith("packages/mcp-server/src/tools/")) {
			archPassed = false;
			const reason = `New legacy tool file '${file.path}' violates ADR-100/ADR-101 (new actions must live in packages/core/src/actions/)`;
			archNotes.push(reason);
			missing.push(reason);
		}
	}

	if (packet.recommendedCapabilityAnatomy !== undefined) {
		const rcaText = packet.recommendedCapabilityAnatomy;
		const missingLayers = RCA_LAYER_PATTERNS.filter((layer) => !layer.regex.test(rcaText)).map(
			(layer) => layer.label,
		);
		if (missingLayers.length > 0) {
			archPassed = false;
			const reason = `Recommended Capability Anatomy (ADR-115) is missing ${missingLayers.join(", ")} (account for all 5 layers or state 'N/A — <reason>')`;
			archNotes.push(reason);
			missing.push(reason);
		}
	}

	// 2. One person check (Zero blocking human console/credential steps in Goal or Done when)
	const humanStepPatterns = [
		/\bconsole\b/i,
		/\bmanually\b/i,
		/\bmanual\s+step\b/i,
		/\baws\s+secret/i,
		/\bgcp\s+secret/i,
		/\bask\s+angus\b/i,
	];
	const hasHumanSteps = humanStepPatterns.some(
		(re) =>
			(packet.goal && re.test(packet.goal)) ||
			(packet.doneWhen.length > 0 && packet.doneWhen.some((item) => re.test(item))),
	);
	const onePersonPassed = !hasHumanSteps;
	let onePersonReason: string | undefined;
	if (hasHumanSteps) {
		onePersonReason = "Issue contains manual or human console/credential steps (must be status:needs-human)";
		missing.push(onePersonReason);
	}

	// 3. One run check (Size <= M, <= ~300 lines)
	let oneRunPassed = true;
	let oneRunReason: string | undefined;
	if (!packet.size) {
		oneRunPassed = false;
		oneRunReason = "Missing required section: Size";
		missing.push(oneRunReason);
	} else {
		const sizeMatch = packet.size.match(/\b(XS|S|M|L|XL)\b/i);
		const sizeCode = sizeMatch ? sizeMatch[1].toUpperCase() : null;
		if (sizeCode === "L" || sizeCode === "XL") {
			oneRunPassed = false;
			oneRunReason = `Size '${sizeCode}' exceeds maximum allowed size 'M' for a single run (~300 lines)`;
			missing.push(oneRunReason);
		}
	}

	// 4. Verification check
	let verificationPassed = true;
	let verificationReason: string | undefined;
	if (!packet.acceptanceTest || packet.acceptanceTest.trim().length === 0) {
		verificationPassed = false;
		verificationReason = "Missing required section: Acceptance test";
		missing.push(verificationReason);
	}

	// 5. Clarity check (Required sections, no open decisions, no shorthand codes, no open blockers)
	let clarityPassed = true;
	const clarityNotes: string[] = [];

	if (!packet.goal || packet.goal.trim().length === 0) {
		clarityPassed = false;
		missing.push("Missing required section: Goal");
	}
	if (!packet.doneWhen || packet.doneWhen.length === 0) {
		clarityPassed = false;
		missing.push("Missing required section: Done when");
	}

	const openQuestionMatch = issueBody.match(/\b(should we|tbd|to be decided|to be confirmed)\b/i);
	if (openQuestionMatch) {
		clarityPassed = false;
		const reason = `Issue body contains unresolved open question or token: '${openQuestionMatch[1]}'`;
		clarityNotes.push(reason);
		missing.push(reason);
	}

	const shorthandMatch = issueBody.match(/(?:\b[RGL]\d{1,2}\b|\bQ\d+\([a-z]\))/);
	if (shorthandMatch) {
		clarityPassed = false;
		const reason = `Issue body contains opaque shorthand rule/decision code '${shorthandMatch[0]}' — spell out rules in plain English`;
		clarityNotes.push(reason);
		missing.push(reason);
	}

	const openBlockerMatch = issueBody.match(/(?:^|\n)\s*(?:[-*•]\s*)?(?:reopens\s+when|blocked[- ]by)\s*:?\s*#(\d+)/i);
	if (openBlockerMatch) {
		clarityPassed = false;
		const reason = `Issue declares an open blocker (#${openBlockerMatch[1]}) — keep status:blocked until prerequisite lands on dev`;
		clarityNotes.push(reason);
		missing.push(reason);
	}

	// 6. Grounded check (Paths exist on dev, new files have resolving parent dir, no placeholders)
	let groundedPassed = true;
	const verifiedPaths: string[] = [];
	const ungroundedPaths: string[] = [];

	if (packet.filesMayTouch.length === 0) {
		groundedPassed = false;
		missing.push("Missing required section: Files it may touch");
	} else {
		for (const file of packet.filesMayTouch) {
			if (file.isNew) {
				if (hasResolvingParentDirectory(file.path, repoFileList)) {
					verifiedPaths.push(`${file.path} (new)`);
				} else {
					groundedPassed = false;
					ungroundedPaths.push(`${file.path} (new — parent directory not found)`);
					missing.push(`Parent directory for new file '${file.path}' does not exist in repository`);
				}
			} else if (repoSet.has(file.path)) {
				verifiedPaths.push(file.path);
			} else {
				groundedPassed = false;
				ungroundedPaths.push(file.path);
				missing.push(`Target file '${file.path}' does not exist in repository`);
			}
		}
	}

	const placeholderMatch = issueBody.match(/\b(placeholder|TBD)\b/);
	if (placeholderMatch) {
		groundedPassed = false;
		const reason = `Contains placeholder token: '${placeholderMatch[1]}'`;
		missing.push(reason);
	}

	const overallReady =
		archPassed &&
		onePersonPassed &&
		oneRunPassed &&
		verificationPassed &&
		clarityPassed &&
		groundedPassed;

	const criteria: Record<string, CriterionResult> = {
		architecture: {
			id: "architecture",
			title: "Not an anti-pattern",
			passed: archPassed,
			reason: archNotes.length > 0 ? archNotes.join("; ") : undefined,
		},
		one_person: {
			id: "one_person",
			title: "One person can do it",
			passed: onePersonPassed,
			reason: onePersonReason,
		},
		one_run: {
			id: "one_run",
			title: "Achievable in one run",
			passed: oneRunPassed,
			reason: oneRunReason,
		},
		verification: {
			id: "verification",
			title: "Clear verification and test plan",
			passed: verificationPassed,
			reason: verificationReason,
		},
		clarity: {
			id: "clarity",
			title: "Clear what to build",
			passed: clarityPassed,
			reason: clarityNotes.length > 0 ? clarityNotes.join("; ") : undefined,
		},
		grounded: {
			id: "grounded",
			title: "Grounded in the repository",
			passed: groundedPassed,
			evidence: verifiedPaths.length > 0 ? verifiedPaths.join(", ") : undefined,
			reason: ungroundedPaths.length > 0 ? `Unresolved paths: ${ungroundedPaths.join(", ")}` : undefined,
		},
	};

	const groundedEvidence = groundedPassed
		? `pass (paths verified: ${verifiedPaths.join(", ")})`
		: `fail (${ungroundedPaths.length > 0 ? `path not found: ${ungroundedPaths.join(", ")}` : "missing files list or placeholders found"})`;

	const evidenceComment = `### Agent-ready (bar v${BAR_VERSION})
Architecture: ${archPassed ? "pass" : "fail"}
One person: ${onePersonPassed ? "pass" : "fail"}
One run: ${oneRunPassed ? "pass" : "fail"}
Verification: ${verificationPassed ? "pass" : "fail"}
Clarity: ${clarityPassed ? "pass" : "fail"}
Grounded: ${groundedEvidence}`;

	return {
		ready: overallReady,
		version: BAR_VERSION,
		criteria,
		missing,
		evidenceComment,
		packet,
	};
}
