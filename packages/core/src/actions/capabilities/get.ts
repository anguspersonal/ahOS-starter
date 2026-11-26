import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import type { CapabilityEntityRow, CapabilityRepository } from "../../ports/capabilities.js";
import {
	CLIENT_SURFACES,
	findSuggestions,
	KINDS,
	matchCapabilityRows,
	normalizeCapabilityLookup,
	readCapabilityProps,
	reconcileCapabilityScope,
	RUNTIME_SURFACES,
	SCOPES,
	STORAGE_LOCATIONS,
	wrapServedCapabilityBody,
	type CapabilityActionPorts,
} from "./shared.js";

export const getCapabilitiesInput = {
	name: z
		.string()
		.optional()
		.describe(
			"Fetch a single capability by exact name (case-insensitive); strips optional 'ahos/' or 'ahkms/' namespace prefix and resolves ritual and skill aliases (sync/synth/dos, reflect/dos-reflect, prep/prep-day-unattended, groom-issues/unblock).",
		),
	kind: z.enum(KINDS).optional().describe("Filter by kind (matches if capability contains this kind)."),
	surface: z.enum(RUNTIME_SURFACES).optional().describe("Filter to capabilities available on this runtime surface."),
	client: z.enum(CLIENT_SURFACES).optional().describe("Filter to capabilities available on this client."),
	scope: z.enum(SCOPES).optional().describe("Filter by scope (global | personal | work | ahLtd)."),
	domain: optionalDomainInput,
	storage_location: z.enum(STORAGE_LOCATIONS).optional().describe("Filter by canonical home."),
	include_archived: z.boolean().optional().describe("Include archived capabilities. Defaults to false."),
	include_body: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			"Default true. false returns the header (kind, surface, clients, scope, storage, body_sha256, body_synced_at, updated_at) without the body, for freshness probes: about 1 KB instead of the whole skill.",
		),
} as const;

export const getCapabilitiesSchema = z.object(getCapabilitiesInput);
export type CapabilityGetInput = z.input<typeof getCapabilitiesSchema>;

export type CapabilityGetOutput = {
	rows: CapabilityEntityRow[];
	text: string;
};

function stripRowBody(row: CapabilityEntityRow): CapabilityEntityRow {
	if (!row.properties || !("body" in row.properties)) return row;
	const { body: _body, ...restProps } = row.properties;
	return { ...row, properties: restProps };
}

function renderCapabilityBlock(
	row: CapabilityEntityRow,
	bodyHash: (body: string) => string,
	withBody: boolean,
): string {
	const p = readCapabilityProps(row);
	const hosted = p.storage_location.startsWith("kms-");
	const sha256 = p.body ? bodyHash(p.body) : null;
	const servedBody = p.body
		? wrapServedCapabilityBody(p.body, p.storage_location, p.storage_url)
		: "(no body stored)";
	const lines = [
		`${row.title} (${p.kind.join("+") || "unknown"})`,
		row.description ? `  ${row.description}` : null,
		`  surface: ${p.surface.join(", ") || "(none)"}`,
		p.clients.length > 0 ? `  clients: ${p.clients.join(", ")}` : null,
		p.scope ? `  scope: ${p.scope}` : null,
		`  storage: ${p.storage_location} (${hosted ? "hosted" : "indexed"})${p.storage_url ? ` -> ${p.storage_url}` : ""}`,
		p.repo_mirror
			? `  repo_mirror: ${p.repo_mirror} (edit in git; direct capability_register drifts from .claude/skill-registry.json)`
			: null,
		sha256 ? `  body_sha256: ${sha256}` : null,
		p.body_synced_at
			? `  body_synced_at: ${p.body_synced_at}${hosted ? "" : " (snapshot)"}`
			: "  body: (none)",
		row.updated_at ? `  updated_at: ${row.updated_at}` : null,
		...(withBody ? ["", servedBody] : []),
	].filter((line): line is string => line !== null);
	return lines.join("\n");
}

function resolveGetPorts(
	ports: CapabilityActionPorts | (CapabilityRepository & { bodyHash: (body: string) => string }),
): CapabilityActionPorts {
	if ("repo" in ports && ports.repo) {
		return { repo: ports.repo, bodyHash: ports.bodyHash };
	}
	const flat = ports as CapabilityRepository & { bodyHash: (body: string) => string };
	return { repo: flat, bodyHash: flat.bodyHash };
}

export function createCapabilityGetAction(
	ports: CapabilityActionPorts | (CapabilityRepository & { bodyHash: (body: string) => string }),
): ActionDefinition<typeof getCapabilitiesSchema, CapabilityGetOutput> {
	return defineAction({
		id: "capability_get",
		description:
			"List capabilities from the registry, filtered by kind, surface or storage location. Pass `name` " +
			"for one capability by exact case-insensitive name: that returns a freshness header (kind, " +
			"surface, storage, body_sha256) and the " +
			"stored body, so a surface with no local copy still gets the real definition. Full notes: " +
			"docs/guides/tools/capability_get.md",
		schema: getCapabilitiesSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (args) => {
			const { repo, bodyHash } = resolveGetPorts(ports);
			let rows = await repo.list({ includeArchived: Boolean(args.include_archived) });
			if (!args.include_archived) rows = rows.filter((row) => !row.archived);
			if (args.kind) rows = rows.filter((row) => readCapabilityProps(row).kind.includes(args.kind!));
			if (args.storage_location) {
				rows = rows.filter((row) => readCapabilityProps(row).storage_location === args.storage_location);
			}
			if (args.surface) rows = rows.filter((row) => readCapabilityProps(row).surface.includes(args.surface!));
			if (args.client) rows = rows.filter((row) => readCapabilityProps(row).clients.includes(args.client!));
			const filterScope = reconcileCapabilityScope(args.domain, args.scope);
			const allowGlobalFallback = Boolean(args.name) && Boolean(args.domain) && !args.scope;

			if (args.name) {
				const { stripped: needle, candidates } = normalizeCapabilityLookup(args.name);
				const scopedRows = filterScope
					? rows.filter((row) => readCapabilityProps(row).scope === filterScope)
					: rows;
				let exactMatches = matchCapabilityRows(scopedRows, candidates);
				if (exactMatches.length === 0 && allowGlobalFallback) {
					const globalRows = rows.filter((row) => {
						const s = readCapabilityProps(row).scope;
						return s === null || s === "global";
					});
					exactMatches = matchCapabilityRows(globalRows, candidates);
				}
				if (exactMatches.length === 0) {
					const candidateRows = allowGlobalFallback
						? rows.filter((row) => {
								const s = readCapabilityProps(row).scope;
								return s === filterScope || s === null || s === "global";
						  })
						: scopedRows;
					const suggestions = findSuggestions(needle, candidateRows);
					if (suggestions.length > 0) {
						const formatted = suggestions.map((s) => `'${s}'`).join(", ");
						return {
							rows: [],
							text: `No capabilities found matching '${args.name}'. Did you mean: ${formatted}?`,
						};
					}
					return { rows: [], text: "No capabilities found." };
				}
				rows = exactMatches;
			} else if (filterScope) {
				rows = rows.filter((row) => readCapabilityProps(row).scope === filterScope);
			}

			if (rows.length === 0) return { rows: [], text: "No capabilities found." };

			if (args.name) {
				const withBody = args.include_body !== false;
				const text = rows.map((row) => renderCapabilityBlock(row, bodyHash, withBody)).join("\n\n");
				const outRows = withBody ? rows : rows.map(stripRowBody);
				return { rows: outRows, text };
			}

			const summary = rows
				.map((row) => {
					const p = readCapabilityProps(row);
					const hosted = p.storage_location.startsWith("kms-");
					const scopeStr = p.scope ? ` scope=${p.scope}` : "";
					const homeSuffix = p.repo_mirror ? "(repo-mirror)" : hosted ? "" : "(indexed)";
					return `• ${row.title} [${p.kind.join("+") || "?"}] surface=${p.surface.join("+") || "?"}${scopeStr} home=${p.storage_location}${homeSuffix}`;
				})
				.join("\n");
			const outRows = args.include_body === true ? rows : rows.map(stripRowBody);
			return { rows: outRows, text: `Capabilities (${rows.length}):\n${summary}` };
		},
		formatMcp: (output) => output.text,
	});
}
