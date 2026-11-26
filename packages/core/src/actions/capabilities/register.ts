import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { CapabilityRepository } from "../../ports/capabilities.js";
import {
	CLIENT_SURFACES,
	findRegistrationConflicts,
	KINDS,
	readCapabilityProps,
	reconcileCapabilityScope,
	RUNTIME_SURFACES,
	SCOPES,
	STORAGE_LOCATIONS,
	type CapabilityActionPorts,
	type CapabilityKind,
} from "./shared.js";

export const registerCapabilityInput = {
	name: z
		.string()
		.min(1)
		.describe("Capability name; unique per user (case-insensitive). Re-registering an existing name updates it (full replace)."),
	description: z.string().nullable().optional().describe("Short summary of what the capability does."),
	kind: z
		.union([z.enum(KINDS), z.array(z.enum(KINDS)).min(1)])
		.describe("Capability kind(s): skill | agent | command (single or array for twins e.g. ['skill', 'agent'])."),
	surface: z
		.array(z.enum(RUNTIME_SURFACES))
		.min(1)
		.describe("Runtime execution surfaces: claude-code | claude-synced | api. Non-empty array."),
	clients: z
		.array(z.enum(CLIENT_SURFACES))
		.optional()
		.describe("Informational client surfaces: chat | cowork | mobile | cursor | ide | terminal."),
	scope: z
		.enum(SCOPES)
		.optional()
		.describe("Identity-context / binding scope: global | personal | work | ahLtd."),
	domain: optionalDomainInput,
	storage_location: z
		.enum(STORAGE_LOCATIONS)
		.describe("Canonical home. kms-db/kms-repo = hosted by the kms; claude/openai = indexed (external owner)."),
	storage_url: z
		.string()
		.nullable()
		.optional()
		.describe("Pointer to the canonical home (repo path / URL). Required unless storage_location='kms-db'; must be omitted for kms-db."),
	body: z
		.string()
		.nullable()
		.optional()
		.describe("Plain-text bytes. Required and authoritative when storage_location='kms-db'; otherwise an optional backup snapshot. For twins (skill+agent), one body is shared (anti-drift)."),
} as const;

export const registerCapabilitySchema = z.object(registerCapabilityInput);
export type CapabilityRegisterInput = z.infer<typeof registerCapabilitySchema>;

export type CapabilityRegisterOutput = {
	id: string;
	created: boolean;
	text: string;
};

function validateConditional(args: CapabilityRegisterInput): void {
	const hasBody = typeof args.body === "string" && args.body.trim() !== "";
	const hasUrl = typeof args.storage_url === "string" && args.storage_url.trim() !== "";
	if (args.storage_location === "kms-db") {
		if (!hasBody) {
			throw new Error("capability_register: body is required when storage_location='kms-db' (it is the source of truth).");
		}
		if (hasUrl) {
			throw new Error("capability_register: storage_url must be omitted when storage_location='kms-db' (the body is the source).");
		}
	} else if (!hasUrl) {
		throw new Error(
			`capability_register: storage_url is required when storage_location='${args.storage_location}' (the pointer to the canonical home).`,
		);
	}
}

function resolveRepo(
	ports: CapabilityRepository | Pick<CapabilityActionPorts, "repo">,
): CapabilityRepository {
	return "repo" in ports && ports.repo ? ports.repo : (ports as CapabilityRepository);
}

export function createCapabilityRegisterAction(
	ports: CapabilityRepository | Pick<CapabilityActionPorts, "repo">,
): ActionDefinition<typeof registerCapabilitySchema, CapabilityRegisterOutput> {
	return defineAction({
		id: "capability_register",
		description:
			"Register a capability — a skill, agent or command — in the registry, creating it or fully " +
			"replacing it by name. Full replace, not merge: fields you omit are cleared, so send the whole " +
			"capability every time. Skill bar & placement: capability_get({ name: 'writing-for-agents' }). " +
			"Full notes: docs/guides/tools/capability_register.md",
		schema: registerCapabilitySchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (args) => {
			validateConditional(args);

			const repo = resolveRepo(ports);
			const kinds: CapabilityKind[] = Array.isArray(args.kind) ? args.kind : [args.kind];
			const hasBody = typeof args.body === "string" && args.body.trim() !== "";
			const now = new Date().toISOString();
			const properties: Record<string, unknown> = {
				kind: kinds,
				surface: args.surface,
				storage_location: args.storage_location,
				storage_url: args.storage_url ?? null,
				body: hasBody ? args.body : null,
				body_synced_at: hasBody ? now : null,
			};
			if (args.clients && args.clients.length > 0) {
				properties.clients = args.clients;
			}
			const resolvedScope = reconcileCapabilityScope(args.domain, args.scope);
			if (resolvedScope) {
				properties.scope = resolvedScope;
			}

			const existing = await repo.findByName(args.name);
			const kindLabel = kinds.join("+");

			if (existing) {
				const priorProps = readCapabilityProps(existing);
				if (priorProps.repo_mirror) {
					properties.repo_mirror = priorProps.repo_mirror;
				}
				const cleanedTags = Array.isArray(existing.tags)
					? existing.tags.filter(
							(t) => t !== "also:skill" && t !== "drift:twin-unsourced" && !t.startsWith("scope:"),
					  )
					: [];
				await repo.update(existing.id, {
					title: args.name,
					description: args.description ?? null,
					properties,
					tags: cleanedTags,
					...(resolvedScope === "personal" ? { domain_override: "angus" } : {}),
				});
				const mirrorWarning = priorProps.repo_mirror
					? ` Warning: '${args.name}' is mirrored from ${priorProps.repo_mirror} (.claude/skill-registry.json); direct capability_register updates drift from git until synced via skill-sync repo push.`
					: "";
				return {
					id: existing.id,
					created: false,
					text: `Updated capability [${existing.id}] ${args.name} (${kindLabel}, ${args.storage_location}).${mirrorWarning}`,
				};
			}

			const allRows = await repo.list({ includeArchived: false });
			const similar = findRegistrationConflicts(args.name, allRows);
			const { id } = await repo.insert({
				title: args.name,
				description: args.description ?? null,
				properties,
				tags: [],
				...(resolvedScope === "personal" ? { domain_override: "angus" } : {}),
			});
			const similarityNote =
				similar.length > 0
					? ` Note: similar capability name(s) already registered (${similar.map((s) => `'${s}'`).join(", ")}) — prefer extending an existing skill or adding a branch over minting a duplicate or mode-sibling.`
					: "";
			return {
				id,
				created: true,
				text: `Registered capability [${id}] ${args.name} (${kindLabel}, ${args.storage_location}).${similarityNote}`,
			};
		},
		formatMcp: (output) => output.text,
	});
}
