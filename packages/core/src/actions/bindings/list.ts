import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { BindingRepository, BindingRow } from "../../ports/bindings.js";
import { bindingDomain, resolveScopeToDomainId } from "./shared.js";

export const listBindingsInput = {
	domain: optionalDomainInput,
	scope: z.string().optional().describe("Deprecated, use `domain`."),
	name: z.string().optional().describe("Filter to one binding name (exact)."),
} as const;

export const listBindingsSchema = z.object(listBindingsInput);
export type ListBindingsInput = z.infer<typeof listBindingsSchema>;

export type ListBindingsOutput = {
	rows: BindingRow[];
	text: string;
};

export function createBindingListAction(
	repo: BindingRepository,
): ActionDefinition<typeof listBindingsSchema, ListBindingsOutput> {
	return defineAction({
		id: "binding_list",
		description:
			"List bindings, optionally filtered by scope ('personal'|'work') or exact name. Shows each binding's scope, target_kind, and target_ref (pointer only — no resolved secret values).",
		schema: listBindingsSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args) => {
			const domains = await repo.listDomains();
			const domainTitle = (id: string | null): string =>
				id === null ? "(any)" : (domains.find((d) => d.id === id)?.title ?? id);

			const domain = bindingDomain(args);
			const domainId = domain ? await resolveScopeToDomainId(repo, domain) : undefined;
			const rows = await repo.listBindings({
				name: args.name,
				domainId,
			});

			if (rows.length === 0) {
				return { rows: [], text: "No bindings found." };
			}

			const summary = rows
				.map(
					(r) =>
						`• ${r.name} [${domainTitle(r.domain_entity_id)}] ${r.target_kind}=${JSON.stringify(r.target_ref)}`,
				)
				.join("\n");
			return {
				rows,
				text: `Bindings (${rows.length}):\n${summary}`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
