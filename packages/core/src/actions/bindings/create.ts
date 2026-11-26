import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { TARGET_KINDS, type BindingRepository } from "../../ports/bindings.js";
import {
	bindingDomain,
	bindingName,
	resolveScopeToDomainId,
	validateTargetRef,
} from "./shared.js";

export const createBindingInput = {
	name: bindingName.describe("Dotted-namespace binding name, e.g. 'notion.inbox_db'."),
	domain: optionalDomainInput,
	scope: z
		.string()
		.optional()
		.describe(
			"Deprecated, use `domain`. Omit both for a domain-agnostic binding (applies to every domain as a fallback).",
		),
	target_kind: z
		.enum(TARGET_KINDS)
		.describe(
			"integration_config (points at user_integrations.config), entity (an entities property), or literal (a bare non-secret constant).",
		),
	target_ref: z
		.record(z.string(), z.unknown())
		.describe(
			"Pointer, shape per target_kind: integration_config={provider,json_path}; entity={entity_id,property}; literal={value}. Never a secret/token.",
		),
} as const;

export const createBindingSchema = z.object(createBindingInput);
export type CreateBindingInput = z.infer<typeof createBindingSchema>;

export type CreateBindingOutput = {
	text: string;
};

export function createBindingCreateAction(
	repo: BindingRepository,
): ActionDefinition<typeof createBindingSchema, CreateBindingOutput> {
	return defineAction({
		id: "binding_create",
		description:
			"Create a named pointer resolved at serve time by (scope, name). target_kind ∈ integration_config {provider,json_path} | entity {entity_id,property} | literal {value}. scope ('personal'|'work') scopes it to a domain; omit scope for a domain-agnostic fallback. name is a dotted namespace (e.g. 'notion.inbox_db'). A binding is a pointer into existing config/entities — never a copy, never a secret.",
		schema: createBindingSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args) => {
			validateTargetRef(args.target_kind, args.target_ref);
			const domain = bindingDomain(args);
			const domainId =
				domain === undefined || domain.trim() === ""
					? null
					: await resolveScopeToDomainId(repo, domain);
			const label = domainId === null ? "domain-agnostic" : `scope '${domain}'`;
			if (!repo.findExactBinding || !repo.createBinding) {
				throw new Error("BindingRepository write methods are not wired");
			}
			const existing = await repo.findExactBinding(args.name, domainId);
			if (existing) {
				throw new Error(
					`A binding named '${args.name}' (${label}) already exists. Use binding_update to change it.`,
				);
			}
			await repo.createBinding({
				domain_entity_id: domainId,
				name: args.name,
				target_kind: args.target_kind,
				target_ref: args.target_ref,
			});
			return {
				text: `Created binding '${args.name}' (${label}) -> ${args.target_kind}.`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
