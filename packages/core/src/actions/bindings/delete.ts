import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { BindingRepository } from "../../ports/bindings.js";
import { bindingDomain, bindingName, resolveScopeToDomainId } from "./shared.js";

export const deleteBindingInput = {
	name: bindingName.describe("Name of the binding to delete."),
	domain: optionalDomainInput,
	scope: z
		.string()
		.optional()
		.describe("Deprecated, use `domain`. Omit both to target the domain-agnostic binding."),
} as const;

export const deleteBindingSchema = z.object(deleteBindingInput);
export type DeleteBindingInput = z.infer<typeof deleteBindingSchema>;

export type DeleteBindingOutput = {
	text: string;
};

export function createBindingDeleteAction(
	repo: BindingRepository,
): ActionDefinition<typeof deleteBindingSchema, DeleteBindingOutput> {
	return defineAction({
		id: "binding_delete",
		description:
			"Hard-delete a binding by (name, scope). Omit scope to target the domain-agnostic binding. Bindings are plumbing, not knowledge — a deleted binding simply fails loud (manifest) next time it's resolved.",
		schema: deleteBindingSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args) => {
			const domain = bindingDomain(args);
			const domainId =
				domain === undefined || domain.trim() === ""
					? null
					: await resolveScopeToDomainId(repo, domain);
			const label = domainId === null ? "domain-agnostic" : `scope '${domain}'`;
			if (!repo.findExactBinding || !repo.deleteBinding) {
				throw new Error("BindingRepository write methods are not wired");
			}
			const existing = await repo.findExactBinding(args.name, domainId);
			if (!existing) {
				throw new Error(`No binding named '${args.name}' (${label}) to delete.`);
			}
			await repo.deleteBinding(existing.id);
			return {
				text: `Deleted binding '${args.name}' (${label}).`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
