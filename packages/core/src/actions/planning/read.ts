import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { PlanningIndex, PlanningPort } from "../../ports/planning.js";
import { renderPlanningIndex } from "./render.js";

export const planningReadInput = {
	collections: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Collections to return in full, e.g. ['modelIssues','modelQuestions']. " +
				"OMIT THIS ON THE FIRST CALL: with no collections the tool returns an index " +
				"(snapshot id, and a row count per collection) plus the list of writable " +
				"collections, which is how you find out what exists without pulling ~90KB of " +
				"document into context. Ask for collections by name once you know which you need.",
		),
};

export const planningReadInputSchema = z.object(planningReadInput);

export type PlanningReadInput = z.infer<typeof planningReadInputSchema>;

export interface PlanningReadOutput extends PlanningIndex {
	text: string;
}

export const PLANNING_READ_DESCRIPTION =
	"Read the Work planning document — roadmap, issues, decisions, open questions and risks. Call " +
	"it with NO arguments first: that returns the snapshot id, a row count per collection, and the " +
	"collection names, which is what you need before asking for any one of them. Full notes: " +
	"docs/guides/tools/planning_read.md";

const SLUG_REGISTRY_COLLECTIONS = ["modelDomains", "modelGoals", "roadmapItems"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractPlanningSlugRegistry(doc: PlanningIndex): {
	domains?: string[];
	goals?: string[];
	projectParents?: string[];
	allItemIds?: string[];
} {
	const data = doc.data;
	const domains =
		doc.domains ??
		(Array.isArray(data?.modelDomains)
			? data.modelDomains
					.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
					.filter((id): id is string => Boolean(id))
			: undefined);

	const goals =
		doc.goals ??
		(Array.isArray(data?.modelGoals)
			? data.modelGoals
					.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
					.filter((id): id is string => Boolean(id))
			: undefined);

	const projectParents =
		doc.projectParents ??
		(Array.isArray(data?.roadmapItems)
			? data.roadmapItems
					.filter(
						(item): item is Record<string, unknown> & { id: string } =>
							isRecord(item) &&
							typeof item.id === "string" &&
							item.id.length > 0 &&
							item.detailLevel !== "task",
					)
					.map((item) => item.id)
			: undefined);

	const allItemIds = Array.isArray(data?.roadmapItems)
		? data.roadmapItems
				.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : null))
				.filter((id): id is string => Boolean(id))
		: projectParents;

	return {
		...(domains ? { domains } : {}),
		...(goals ? { goals } : {}),
		...(projectParents ? { projectParents } : {}),
		...(allItemIds ? { allItemIds } : {}),
	};
}

async function enrichIndexWithSlugRegistry(
	port: PlanningPort,
	doc: PlanningIndex,
): Promise<PlanningIndex> {
	const initial = extractPlanningSlugRegistry(doc);
	if (initial.domains && initial.goals && initial.projectParents) {
		return {
			...doc,
			domains: initial.domains,
			goals: initial.goals,
			projectParents: initial.projectParents,
		};
	}

	try {
		const registryDoc = await port.read(SLUG_REGISTRY_COLLECTIONS);
		const extracted = extractPlanningSlugRegistry(registryDoc);
		const domains = initial.domains ?? extracted.domains;
		const goals = initial.goals ?? extracted.goals;
		const projectParents = initial.projectParents ?? extracted.projectParents;
		return {
			...doc,
			...(domains ? { domains } : {}),
			...(goals ? { goals } : {}),
			...(projectParents ? { projectParents } : {}),
		};
	} catch {
		return doc;
	}
}

export function createPlanningReadAction(
	port: PlanningPort,
): ActionDefinition<typeof planningReadInputSchema, PlanningReadOutput> {
	return defineAction<typeof planningReadInputSchema, PlanningReadOutput>({
		id: "planning_read",
		name: "planning_read",
		description: PLANNING_READ_DESCRIPTION,
		domain: "integrations",
		schema: planningReadInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp(result) {
			return result.text;
		},
		async run(input) {
			const isIndexRead = !input.collections || input.collections.length === 0;
			const rawDoc = await port.read(input.collections);
			const doc = isIndexRead ? await enrichIndexWithSlugRegistry(port, rawDoc) : rawDoc;
			return {
				...doc,
				text: renderPlanningIndex(doc),
			};
		},
	});
}
