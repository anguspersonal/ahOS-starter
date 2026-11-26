import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import {
	TARGET_KINDS,
	type BindingRepository,
	type TargetKind,
} from "../../ports/bindings.js";
import {
	bindingDomain,
	bindingName,
	resolveScopeToDomainId,
	validateTargetRef,
} from "./shared.js";

export const updateBindingInput = {
	name: bindingName.describe("Name of the binding to update."),
	domain: optionalDomainInput,
	scope: z
		.string()
		.optional()
		.describe("Deprecated, use `domain`. Omit both to target the domain-agnostic binding."),
	target_kind: z
		.enum(TARGET_KINDS)
		.optional()
		.describe("New target_kind. If set, target_ref must match its shape."),
	target_ref: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("New pointer. Validated against target_kind."),
} as const;

export const updateBindingSchema = z.object(updateBindingInput);
export type UpdateBindingInput = z.infer<typeof updateBindingSchema>;

export type UpdateBindingOutput = {
	text: string;
};

export function createBindingUpdateAction(
	repo: BindingRepository,
): ActionDefinition<typeof updateBindingSchema, UpdateBindingOutput> {
	return defineAction({
		id: "binding_update",
		description:
			"Update an existing binding's target_kind and/or target_ref, identified by (name, scope). Omit scope to target the domain-agnostic binding. If target_kind changes, target_ref must match the new shape.",
		schema: updateBindingSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (args) => {
			const domain = bindingDomain(args);
			const domainId =
				domain === undefined || domain.trim() === ""
					? null
					: await resolveScopeToDomainId(repo, domain);
			const label = domainId === null ? "domain-agnostic" : `scope '${domain}'`;
			if (!repo.findExactBinding || !repo.updateBinding) {
				throw new Error("BindingRepository write methods are not wired");
			}
			const existing = await repo.findExactBinding(args.name, domainId);
			if (!existing) {
				throw new Error(`No binding named '${args.name}' (${label}) to update.`);
			}

			const nextKind = (args.target_kind ?? existing.target_kind) as TargetKind;
			const nextRef = args.target_ref ?? existing.target_ref;
			if (args.target_kind !== undefined || args.target_ref !== undefined) {
				validateTargetRef(nextKind, nextRef);
			}

			await repo.updateBinding(existing.id, {
				target_kind: nextKind,
				target_ref: nextRef,
			});
			return {
				text: `Updated binding '${args.name}' (${label}) -> ${nextKind}.`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
