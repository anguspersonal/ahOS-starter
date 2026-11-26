import { z } from "zod";

export const graphFilterInputSchema = z
	.object({
		query: z.string().optional(),
		entity_type: z.string().optional(),
		entity_types: z.array(z.string()).optional(),
		hierarchy_level: z.number().nullable().optional(),
		show_archived: z.boolean().optional(),
		lod_mode: z.enum(["auto", "show_all"]).optional(),
		detail_strategy: z.enum(["tiered", "clusters", "landmarks"]).optional(),
		scope_tier: z.enum(["pillars", "core", "standard", "all"]).optional(),
		include_me: z.boolean().optional(),
		physics: z
			.object({
				repulsion: z.number().optional(),
				springLength: z.number().optional(),
				springStrength: z.number().optional(),
				gravity: z.number().optional(),
				collisionBuffer: z.number().optional(),
				damping: z.number().optional(),
				coolingRate: z.number().optional(),
			})
			.optional(),
		reset: z.boolean().optional(),
	})
	.strict();

export type GraphFilterInput = z.infer<typeof graphFilterInputSchema>;

export interface GraphFilterOutput {
	success: boolean;
	filter: GraphFilterInput;
	message: string;
}

export const viewScreenInputSchema = z
	.object({
		include_record: z
			.boolean()
			.optional()
			.describe("Whether to hydrate the full database record of the currently selected entity"),
	})
	.strict();

export type ViewScreenInput = z.infer<typeof viewScreenInputSchema>;
