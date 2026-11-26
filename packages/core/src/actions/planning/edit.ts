import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { PlanningOp, PlanningPort, PlanningWriteResult } from "../../ports/planning.js";
import { extractPlanningSlugRegistry } from "./read.js";

// The Work planning-document surface (example-org/web-app#114). Two tools, mapping one
// for one onto the API: read it, and apply ops to it.
//
// TWO TOOLS RATHER THAN A CONVENIENCE PER RECORD TYPE. There is no `planning_add_issue`
// and no `planning_set_status`. The API already speaks patch/upsert/remove over named
// collections, and a wrapper per record type would be a second vocabulary to keep in
// step with the first — the same trap as two trackers that disagree. The agent composes
// ops, and the API refuses anything it should not accept, by name.
//
// STRUCTURE IS NOT WRITABLE FROM HERE, and that is the design rather than a gap. The
// goal tree, the domain registries and the period calendar change in code by PR; the
// instances hanging off them (items, issues, decisions, questions, risks) change here.
// `planning_read` reports the live writable list so this file never has to hold a copy
// that could drift from the API's.

const opSchema = z.union([
	z.object({
		collection: z.string().min(1),
		op: z.literal("patch"),
		id: z.string().min(1),
		value: z.record(z.string(), z.unknown()),
	}),
	z.object({
		collection: z.string().min(1),
		op: z.literal("upsert"),
		value: z.record(z.string(), z.unknown()),
	}),
	z.object({
		collection: z.string().min(1),
		op: z.literal("remove"),
		id: z.string().min(1),
	}),
]);

export const planningEditInput = {
	ops: z
		.array(opSchema)
		.min(1)
		.max(100)
		.describe(
			"Changes to apply, all or none. Three shapes: " +
				"{collection, op:'patch', id, value} merges value into the record with that id and " +
				"FAILS if there is none, so a typo'd id cannot create a half-formed record; " +
				"{collection, op:'upsert', value} replaces the whole record or appends it when the " +
				"id is new, and value must carry a string `id`; " +
				"{collection, op:'remove', id} deletes it. " +
				"Writable collections are roadmapItems, modelIssues, modelDecisions, modelQuestions " +
				"and risks — run planning_read first to confirm, since the API is the authority. " +
				"The goal tree, domain registries, periods, people and budget are NOT writable and " +
				"are refused by name: they are structure and change in code.",
		),
	label: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Label for the snapshot this write creates, shown in the page's Load panel. " +
				"Say what changed and that an agent did it, e.g. 'mcp: close landing-page issue'.",
		),
	baseSnapshotId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"The snapshot id you read before composing these ops. Supply it whenever you read " +
				"and then think before writing: if someone saved in between, the write is refused " +
				"with a 409 naming the current snapshot instead of silently overwriting their edit. " +
				"Omit only when reading and writing in one uninterrupted step.",
		),
};

export const planningEditInputSchema = z.object(planningEditInput);

export type PlanningEditInput = z.infer<typeof planningEditInputSchema>;

export interface PlanningEditOutput extends PlanningWriteResult {
	text: string;
}

export const PLANNING_EDIT_DESCRIPTION =
	"Edit the Work planning document by applying patch, upsert and remove ops to named " +
	"collections. All ops land or none do, and they apply server-side against whatever is current, so " +
	"a concurrent human edit is not overwritten wholesale. Full notes: " +
	"docs/guides/tools/planning_edit.md";

export function renderPlanningWriteResult(result: PlanningWriteResult): string {
	const lines = [
		`saved snapshot ${result.snapshotId}${result.label ? ` (${result.label})` : ""} at ${result.createdAt}`,
		"",
		"applied:",
		...result.applied.map((a) => `  • ${a}`),
	];

	// Warnings are the model's own validator speaking: sizes that do not match their
	// durations, undated items that are probably goals, ancestor goals named where a
	// leaf was meant. They do not block the write and they are worth surfacing, because
	// the writer is the only one positioned to fix them.
	if (result.warnings.length > 0) {
		lines.push(
			"",
			`validator warnings on what you changed (${result.warnings.length}, not blocking):`,
		);
		for (const w of result.warnings) {
			lines.push(`  • [${w.code}] ${w.subject}: ${w.message}`);
		}
	}

	// Counted rather than listed. The model carries dozens of standing warnings nobody
	// has worked through; printing them on every write is how the channel stops being
	// read. The number keeps the backlog visible.
	if (result.standingWarnings > 0) {
		lines.push(
			"",
			`(${result.standingWarnings} other validator warnings are standing on records you did not touch.)`,
		);
	}

	return lines.join("\n");
}

const SLUG_REGISTRY_COLLECTIONS = ["modelDomains", "modelGoals", "roadmapItems"] as const;

function opHasSlugReference(op: PlanningOp): boolean {
	if (op.op === "remove") {
		return false;
	}
	const { value } = op;
	return (
		(value.domain !== undefined && value.domain !== null) ||
		(value.parent !== undefined && value.parent !== null && value.parent !== "") ||
		Array.isArray(value.feedsGoals) ||
		(value.attachesTo !== undefined && value.attachesTo !== null)
	);
}

function normalizeSlug(slug: string): string {
	return slug.toLowerCase().replace(/[_-]+/g, "-");
}

function levenshteinDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i]![0] = i;
	for (let j = 0; j <= n; j++) dp[0]![j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i]![j] = Math.min(
				dp[i - 1]![j]! + 1,
				dp[i]![j - 1]! + 1,
				dp[i - 1]![j - 1]! + cost,
			);
		}
	}
	return dp[m]![n]!;
}

export function findClosestSlugs(
	badSlug: string,
	candidates: readonly string[],
	limit = 3,
): string[] {
	const badNorm = normalizeSlug(badSlug);
	const badTokens = new Set(badNorm.split("-").filter(Boolean));
	const scored: { slug: string; score: number }[] = [];

	for (const candidate of candidates) {
		const candNorm = normalizeSlug(candidate);
		const candTokens = candNorm.split("-").filter(Boolean);
		let score = 0;
		if (candNorm.includes(badNorm) || badNorm.includes(candNorm)) {
			score += 5;
		}
		for (const token of candTokens) {
			if (badTokens.has(token)) {
				score += 3;
			}
		}
		const dist = levenshteinDistance(badNorm, candNorm);
		if (dist <= 3) {
			score += 4 - dist;
		}
		if (score > 0) {
			scored.push({ slug: candidate, score });
		}
	}

	scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
	return scored.slice(0, limit).map((s) => s.slug);
}

function formatSlugViolation(
	location: string,
	kindLabel: string,
	badSlug: string,
	candidates: readonly string[],
): string {
	const closest = findClosestSlugs(badSlug, candidates);
	const closestHint = closest.length > 0 ? ` (closest: ${closest.join(", ")})` : "";
	return `${location}: unknown ${kindLabel} slug "${badSlug}"${closestHint}. Valid ${kindLabel} slugs: ${candidates.join(", ")}.`;
}

function hasItemSlug(itemSet: ReadonlySet<string>, slug: string): boolean {
	return (
		itemSet.has(slug) ||
		itemSet.has(slug.replace(/_/g, "-")) ||
		itemSet.has(slug.replace(/-/g, "_"))
	);
}

async function validatePlanningEditSlugs(
	port: PlanningPort,
	ops: readonly PlanningOp[],
): Promise<void> {
	if (!ops.some(opHasSlugReference)) {
		return;
	}

	const registryDoc = await port.read(SLUG_REGISTRY_COLLECTIONS);
	const extracted = extractPlanningSlugRegistry(registryDoc);

	const domainList = extracted.domains ? [...extracted.domains] : null;
	const domainSet = domainList ? new Set(domainList) : null;

	const goalList = extracted.goals ? [...extracted.goals] : null;
	const goalSet = goalList ? new Set(goalList) : null;

	const parentList = extracted.projectParents ? [...extracted.projectParents] : null;
	const parentSet = parentList ? new Set(parentList) : null;

	const itemList = extracted.allItemIds ? [...extracted.allItemIds] : parentList ? [...parentList] : null;
	const itemSet = itemList ? new Set(itemList) : null;

	// Collect intra-batch roadmapItems upserts so sibling/child ops in the same batch can reference them.
	for (const op of ops) {
		if (op.collection === "roadmapItems" && op.op === "upsert") {
			const id = typeof op.value.id === "string" ? op.value.id.trim() : "";
			if (id.length > 0) {
				if (itemSet && !itemSet.has(id)) {
					itemSet.add(id);
					itemList?.push(id);
				}
				if (op.value.detailLevel !== "task" && parentSet && !parentSet.has(id)) {
					parentSet.add(id);
					parentList?.push(id);
				}
			}
		}
	}

	const errors: string[] = [];

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]!;
		if (op.op === "remove") {
			continue;
		}
		const { value } = op;

		if (value.domain !== undefined && value.domain !== null && domainSet && domainList) {
			const slug = String(value.domain);
			if (typeof value.domain !== "string" || !domainSet.has(slug)) {
				errors.push(formatSlugViolation(`ops[${i}].domain`, "domain", slug, domainList));
			}
		}

		if (
			value.parent !== undefined &&
			value.parent !== null &&
			value.parent !== "" &&
			parentSet &&
			parentList
		) {
			const slug = String(value.parent);
			if (typeof value.parent !== "string" || !parentSet.has(slug)) {
				errors.push(
					formatSlugViolation(`ops[${i}].parent`, "project parent", slug, parentList),
				);
			}
		}

		if (Array.isArray(value.feedsGoals) && goalSet && goalList) {
			for (const entry of value.feedsGoals) {
				const slug = String(entry);
				if (typeof entry !== "string" || !goalSet.has(slug)) {
					errors.push(
						formatSlugViolation(`ops[${i}].feedsGoals`, "goal", slug, goalList),
					);
				}
			}
		}

		if (value.attachesTo !== undefined && value.attachesTo !== null) {
			let targetId: unknown;
			let kind: unknown;
			if (typeof value.attachesTo === "object" && !Array.isArray(value.attachesTo)) {
				const rec = value.attachesTo as Record<string, unknown>;
				targetId = rec.id;
				kind = rec.kind;
			} else if (typeof value.attachesTo === "string") {
				targetId = value.attachesTo;
			}

			if (targetId !== undefined && targetId !== null) {
				const slug = String(targetId);
				if (kind === "goal") {
					if (goalSet && goalList && (typeof targetId !== "string" || !goalSet.has(slug))) {
						errors.push(
							formatSlugViolation(`ops[${i}].attachesTo.id`, "goal", slug, goalList),
						);
					}
				} else if (kind === "item") {
					if (
						itemSet &&
						itemList &&
						(typeof targetId !== "string" || !hasItemSlug(itemSet, slug))
					) {
						errors.push(
							formatSlugViolation(`ops[${i}].attachesTo.id`, "item", slug, itemList),
						);
					}
				} else if ((goalSet && goalList) || (itemSet && itemList)) {
					const inGoals = goalSet ? goalSet.has(slug) : false;
					const inItems = itemSet ? hasItemSlug(itemSet, slug) : false;
					if (typeof targetId !== "string" || (!inGoals && !inItems)) {
						const combined = [...(goalList ?? []), ...(itemList ?? [])];
						errors.push(
							formatSlugViolation(
								`ops[${i}].attachesTo.id`,
								"attachesTo target",
								slug,
								combined,
							),
						);
					}
				}
			}
		}
	}

	if (errors.length > 0) {
		throw new Error(
			`Planning edit rejected (400 Bad Request) — invalid slug reference(s):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
		);
	}
}

export function createPlanningEditAction(
	port: PlanningPort,
): ActionDefinition<typeof planningEditInputSchema, PlanningEditOutput> {
	return defineAction<typeof planningEditInputSchema, PlanningEditOutput>({
		id: "planning_edit",
		name: "planning_edit",
		description: PLANNING_EDIT_DESCRIPTION,
		domain: "integrations",
		schema: planningEditInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp(result) {
			return result.text;
		},
		async run(input) {
			await validatePlanningEditSlugs(port, input.ops);
			const result = await port.edit(input);
			return {
				...result,
				text: renderPlanningWriteResult(result),
			};
		},
	});
}
