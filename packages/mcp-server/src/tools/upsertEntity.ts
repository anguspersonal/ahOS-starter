import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { entityType } from "../vocab.js";
import { embedAndStore } from "../embeddings.js";

export const upsertEntityInput = {
	entity_type: entityType.describe(
		"Entity type: 'people' (a person), 'resource' (doc/reference/concept), 'area' (topic/domain/life-area), 'project'.",
	),
	title: z
		.string()
		.min(1)
		.describe(
			"Canonical name/title. Used to resolve against existing entities (case-insensitive) so repeated mentions don't create duplicates.",
		),
	description: z.string().optional().describe("Optional one-line description."),
	properties: z
		.record(z.string(), z.unknown())
		.optional()
		.describe(
			"Typed attributes, e.g. { profession: 'marketing', organization: 'Acme', email: '...' }. Shallow-merged into any existing entity.",
		),
	tags: z
		.array(z.string())
		.optional()
		.describe("Optional tags (unioned with existing)."),
};

const upsertEntitySchema = z.object(upsertEntityInput);

export async function upsertEntityHandler(
	args: z.infer<typeof upsertEntitySchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	// Resolve by (user, type, case-insensitive title) -- this is Story 2's
	// "you didn't have a record of this" novelty check and the dedup that keeps
	// the graph clean. (ilike treats %/_ as wildcards; fine for names.)
	const { data: existing, error: findErr } = await supabase
		.from("entities")
		.select("id, title, properties, tags, description")
		.eq("user_id", getCurrentUserId())
		.eq("entity_type", args.entity_type)
		.eq("archived", false)
		.ilike("title", args.title)
		.limit(1)
		.maybeSingle();
	if (findErr) throw new Error(`Resolve failed: ${findErr.message}`);

	if (existing) {
		const properties = {
			...((existing.properties as Record<string, unknown> | null) ?? {}),
			...(args.properties ?? {}),
		};
		const tags = Array.from(
			new Set([...((existing.tags as string[] | null) ?? []), ...(args.tags ?? [])]),
		);
		const description = args.description ?? existing.description;
		const { error: updErr } = await supabase
			.from("entities")
			.update({
				properties,
				tags,
				description,
				updated_at: new Date().toISOString(),
			})
			.eq("id", existing.id)
			.eq("user_id", getCurrentUserId());
		if (updErr) throw new Error(`Update failed: ${updErr.message}`);
		await embedAndStore("entities", existing.id, { title: existing.title, description, properties });
		return {
			content: [
				{
					type: "text",
					text: `Matched existing entity ${existing.id} (${args.entity_type}: "${args.title}") — merged properties/tags.`,
				},
			],
		};
	}

	const id = randomUUID();
	const description = args.description ?? null;
	const properties = args.properties ?? {};
	const { error: insErr } = await supabase.from("entities").insert({
		id,
		user_id: getCurrentUserId(),
		entity_type: args.entity_type,
		title: args.title,
		description,
		properties,
		tags: args.tags ?? [],
	});
	if (insErr) throw new Error(`Insert failed: ${insErr.message}`);
	await embedAndStore("entities", id, { title: args.title, description, properties });
	return {
		content: [
			{
				type: "text",
				text: `Created entity ${id} (${args.entity_type}: "${args.title}").`,
			},
		],
	};
}
