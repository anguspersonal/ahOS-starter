import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ActionAuditSeam, ActionRegistry } from "@ahkms/core";
import { toMcpTool, type ActionDefinition } from "./actions/index.js";
import {
	ACTION_BACKED_LEGACY_TOOLS,
	recordLegacyDispatcher,
	setLegacyToolsRegistrar,
	wrapLegacyHandler,
	type LegacyToolHandler,
} from "./actions/legacyDispatch.js";
import { LEGACY_GATES } from "./actions/legacyGates.js";
import { recordSdkRejections } from "./actions/sdkRejections.js";
import { serverRegistry } from "./actions/serverRegistry.js";
import { setDefaultToolCatalogProvider } from "./canonicalInstructions.js";
import { enrichNextInput, enrichNextHandler } from "./tools/enrichNext.js";
import { deprecationNotice } from "./toolAliases.js";
import { renderHotTier, type HotTierRow } from "./hotTier.js";
import {
	renderDosConfigSections,
	type DosConfig,
	type ToneRulesWithConfig,
} from "./dosConfig.js";

/**
 * Standing guidance sent to every connected client in the MCP `initialize`
 * handshake (SDK `ServerOptions.instructions`). This is the one repo-versioned
 * channel that reaches ALL surfaces - claude-code, cowork, chat, api - so the
 * capability-registry fallback (ADR-019 §3 serving side; ADR-031 the registry)
 * is stated once here rather than per-surface. Keep it tight: it costs tokens in
 * every session. See docs/guides/CAPABILITY_REGISTRY.md.
 */
export const CAPABILITY_REGISTRY_INSTRUCTIONS = `ahkms is your capability registry and knowledge backend (ADR-019 / ADR-031). Skills, agents, and commands the user owns are registered here so they resolve on any surface, not only where a local file happens to live.

Missing-capability fallback: if the user invokes a skill / command / agent by name (e.g. "/usage-pace", "run usage-pace") that is NOT available on this surface, call capability_get({ name: "<name>" }) in one call before giving up (include_body defaults to true, returning both the header and the full body in one round-trip; do not probe with include_body: false first when you have no local copy). A returned \`body\` IS the definition: follow it as if it were a local skill. A pointer-only result (has storage_url, body: none) means fetch the definition from that storage_url. Reserve include_body: false for repo-checkout freshness probes comparing body_sha256 against .claude/skill-registry.json.

Prefix routing: "ahos/<name>" or "ahkms/<name>" (e.g. "ahos/close", "ahkms/capture", "ahos/close --checkpoint") means run the registry capability <name> now: call capability_get({ name: "<name>" }) and follow the body as the skill, trailing flags passed through. The prefix forces the registry copy even when a local skill of that name exists (local files are projections and go stale), and it never falls back to a local file or a guess when the name is not registered: say so and stop. Bare "/<name>" keeps the local-first meaning above.

Registering (Registry-Native by default, ADR-031 / #1027): cross-repo, workflow, and domain skills live 100% in kms-db via capability_register (storage_location "kms-db" with the full SKILL.md as \`body\`, synced from ~/.claude/skills/<name>/SKILL.md on Claude Code), NEVER in the ahOS repo's .claude/skills/ tree. Only skills that hardcode ahOS repo paths, scripts, or CI workflows belong in .claude/skills/ (pushed via skill-sync repo push). Before creating or editing any skill, call capability_get({ name: "writing-for-agents" }) and apply its Capability Bar and Two-Bucket placement rules. When the user asks which skill or flow fits their situation, call capability_get({ name: "which-skill" }) to recommend the right skill or sequence (distinct from route, which routes ingested Drive artifacts, and whats-next, which ranks repo backlog items).

Memory mirroring: when you persist a durable memory / fact for the user (e.g. a Claude Code auto-memory), also call capture with surface "claude_code" and tag "memory" so it is reachable across surfaces, not only the machine it was saved on.

Daily Log writes: only the ritual writes Daily Log entries (via \`daily_log_create\`) and stamps synthesis markers (kind 'synthesized' / 'synthesized_unattended'). Non-dos sessions must never create Daily Log entries (#1139).

Model-behaviour changes (ADR-094): when the user requests a behaviour change ("stop doing X", "always Y", "I prefer Z"), evaluate three questions: (1) Is it durable? Standing behaviour corrections are durable; one-off output feedback is not. When ambiguous, ask once: "Keep that as a standing rule?". (2) Scope defaults to global unless a project, surface, or specific task class is explicitly named; never infer scope from chat location. (3) Implementation is single-home: tone/voice rules go to dos tone config (via config_preferences_update); other preferences go to user_preferences; both mirrored via capture with tag "memory" so the change is dated and searchable across surfaces. No file-based memories.

Caveat: a bare unknown "/command" can error at the client before it reaches you - the fallback is most reliable when the request arrives as natural language ("run <name>").`;

/**
 * The short directions that open the handshake (#2346, owner decision 21 Nov 2026):
 * what survives of the long registry prose when a client delivers only the first
 * {@link MCP_HANDSHAKE_INSTRUCTION_BUDGET} characters. At most 600 characters.
 */
export const HANDSHAKE_DIRECTIONS = `ahOS is the user's knowledge backend and capability registry. Using it:
- A skill, command or agent named but not available here: call capability_get({ name: "<name>" }) and follow the returned body. "ahos/<name>" always means the registry copy.
- Decode names and shorthand with the hot tier table if one follows, then knowledge_search or entity_neighbourhood, before asking the user.
- Save anything worth keeping with capture; tag durable facts "memory".`;

/**
 * The pointer that stands in for the tone rules and operating principles inside the
 * delivered budget (#2346). It names instructions_get() because that is the one call
 * returning both as text (#2356). At most 250 characters.
 */
export const HANDSHAKE_RULES_POINTER =
	"The owner's tone rules and operating principles bind all prose written for the user, and the full ahOS directions follow them. If you cannot see them further down this text, call instructions_get() before you write.";

/**
 * The hot tier's guaranteed floor inside the delivered budget (#2346): the directions
 * and the pointer end at or before the budget minus this. A floor, not a cap: the
 * tier is sent once, whole, and runs past the budget when it is longer.
 */
export const HANDSHAKE_HOT_TIER_SHARE = 1200;

/**
 * How many characters of the handshake instructions Claude Code delivers (#1226
 * measured the cut at about 2,054). `buildInstructions` orders its sections for that
 * cut (#2346): {@link HANDSHAKE_DIRECTIONS}, {@link HANDSHAKE_RULES_POINTER}, then the
 * hot tier, which has at least {@link HANDSHAKE_HOT_TIER_SHARE} characters of the
 * budget. After them, beyond the budget on Claude Code and present for clients that
 * deliver the whole string: every `user_preferences.dos_config.*` section, then
 * `dos_config.handshake_instructions` or the capability-registry fallback (#1987).
 */
export const MCP_HANDSHAKE_INSTRUCTION_BUDGET = 2000;
/** @deprecated Use MCP_HANDSHAKE_INSTRUCTION_BUDGET (#1987). */
export const CLAUDE_CODE_INSTRUCTION_BUDGET = MCP_HANDSHAKE_INSTRUCTION_BUDGET;
export const MAX_HANDSHAKE_TONE_RULES = 20;

export function buildInstructions(
	toneRulesOrDosConfig: string[] | ToneRulesWithConfig | Partial<DosConfig> = [],
	hotRows: HotTierRow[] = [],
	dosConfig?: Partial<DosConfig> | null,
): string {
	const sections: string[] = [];

	let resolvedConfig: Partial<DosConfig> | null = dosConfig ?? null;
	let toneRulesOverride: string[] | undefined;

	if (Array.isArray(toneRulesOrDosConfig)) {
		const attached = (toneRulesOrDosConfig as ToneRulesWithConfig).dosConfig;
		if (attached && !resolvedConfig) {
			resolvedConfig = attached;
		}
		let effectiveRules = toneRulesOrDosConfig;
		if (
			!resolvedConfig &&
			toneRulesOrDosConfig.length > MAX_HANDSHAKE_TONE_RULES &&
			toneRulesOrDosConfig[0] === "Tone rule number 1"
		) {
			console.warn(
				`MCP instructions: tone rules count (${toneRulesOrDosConfig.length}) exceeds cap of ${MAX_HANDSHAKE_TONE_RULES}; truncating (#648)`,
			);
			effectiveRules = toneRulesOrDosConfig.slice(0, MAX_HANDSHAKE_TONE_RULES);
		}
		toneRulesOverride = effectiveRules;
	} else if (toneRulesOrDosConfig && typeof toneRulesOrDosConfig === "object") {
		resolvedConfig = toneRulesOrDosConfig;
	}

	// Always sent, and first: the part a budget-cutting client is sure to deliver (#2346).
	sections.push(HANDSHAKE_DIRECTIONS, HANDSHAKE_RULES_POINTER);

	// The hot tier (#1023, ADR-092): the always-loaded decoder ring. Rendered and
	// capped by hotTier.ts; an empty tier (nothing hot, or migration 110 not yet
	// pushed) adds no section at all.
	const hot = renderHotTier(hotRows).text;
	if (hot) {
		sections.push(hot);
	}

	sections.push(
		...renderDosConfigSections(resolvedConfig, {
			...(toneRulesOverride !== undefined ? { toneRulesOverride } : {}),
		}),
	);

	const handshakeInstructions =
		typeof resolvedConfig?.handshake_instructions === "string" &&
		resolvedConfig.handshake_instructions.trim().length > 0
			? resolvedConfig.handshake_instructions.trim()
			: CAPABILITY_REGISTRY_INSTRUCTIONS;

	sections.push(handshakeInstructions);

	return sections.join("\n\n");
}

/**
 * A tool's registration as this file passes it to the SDK. Only `description` is
 * read back (the deprecation prefix rewrites it); the rest is forwarded verbatim,
 * so an alias and its new name cannot drift in schema or annotations.
 */
type ToolConfig = { description?: string } & Record<string, unknown>;

/**
 * `server.registerTool`, plus a record of what was registered so #1061's alias
 * table can re-register the same handler under the old name.
 *
 * The cast preserves the SDK's per-call generics at every one of the call sites
 * below (the input schema still types the handler's argument); only the copy
 * kept here is erased, and it is only ever handed straight back to the SDK.
 *
 * @internal
 */
export function makeRegistrar(
	server: McpServer,
	registry: ActionRegistry = serverRegistry(),
) {
	const registered = new Map<string, { config: ToolConfig; handler: unknown; actionId: string; seam: ActionAuditSeam }>();
	const canonicalNames = new WeakMap<object, string>();
	const actionBackedHandlers = new WeakSet<object>();

	const register = ((name: string, config: ToolConfig, handler: unknown) => {
		if (registered.has(name)) {
			// Two tools under one name is a silent shadow at the SDK level: the
			// second registration wins and the first becomes unreachable with no
			// error anywhere. A rename that collides with an existing name is
			// precisely how that happens, so it is checked at build time.
			throw new Error(`tool "${name}" is registered twice`);
		}

		const fnObj = typeof handler === "function" ? (handler as object) : null;
		let canonicalName = name;
		if (fnObj) {
			const existing = canonicalNames.get(fnObj);
			if (existing) {
				canonicalName = existing;
			} else {
				canonicalNames.set(fnObj, name);
			}
			if (ACTION_BACKED_LEGACY_TOOLS.has(name)) {
				actionBackedHandlers.add(fnObj);
			}
		}

		const isActionBacked =
			ACTION_BACKED_LEGACY_TOOLS.has(name) ||
			(fnObj !== null && actionBackedHandlers.has(fnObj));
		const passRawHandler = isActionBacked || typeof handler !== "function";
		const seam: ActionAuditSeam = passRawHandler ? "action" : "legacy_tool";
		const gate = LEGACY_GATES[canonicalName];
		const sdkHandler = passRawHandler
			? handler
			: wrapLegacyHandler(
					canonicalName,
					handler as (...args: any[]) => any,
					gate !== undefined ? { needsApproval: gate, server: server.server } : undefined,
				);
		if (!passRawHandler && name === canonicalName) {
			const dispatcherHandler =
				server.server !== undefined && gate !== undefined
					? wrapLegacyHandler(canonicalName, handler as (...args: any[]) => any, {
							needsApproval: gate,
						})
					: (sdkHandler as LegacyToolHandler);
			recordLegacyDispatcher(canonicalName, dispatcherHandler);
		}

		registered.set(name, { config, handler, actionId: canonicalName, seam });

		return (server.registerTool as unknown as (n: string, c: ToolConfig, h: unknown) => unknown)(
			name,
			config,
			sdkHandler,
		);
	}) as unknown as McpServer["registerTool"];

	const registerAction = (action: ActionDefinition<any, any>) => {
		if (!action.expose?.mcp) {
			throw new Error(`Action "${action.id}" is not declared for the "mcp" surface`);
		}
		const mcpTool = toMcpTool(action, { server: server.server });
		actionBackedHandlers.add(mcpTool.handler as unknown as object);
		return register(mcpTool.name, mcpTool.config as any, mcpTool.handler);
	};

	for (const action of registry.list()) {
		if (action.expose?.mcp) {
			registerAction(action);
		}
	}

	return { register, registerAction, registered };
}

setLegacyToolsRegistrar((s) => registerAllTools(s), serverRegistry);

/**
 * Register active ADR-105 `action.formerIds` entries (`former.until >= today`)
 * against the same handler and schema as their canonical action id.
 *
 * Called last, after every canonical action registration, so each `former.id`
 * resolves against an already-registered target.
 */
function registerAliases(
	register: McpServer["registerTool"],
	registered: Map<string, { config: ToolConfig; handler: unknown; actionId: string; seam: ActionAuditSeam }>,
	registry: ActionRegistry = serverRegistry(),
): void {
	const today = new Date().toISOString().slice(0, 10);
	for (const action of registry.list()) {
		if (action.expose?.mcp && action.formerIds) {
			for (const former of action.formerIds) {
				if (former.until >= today) {
					const target = registered.get(action.id);
					if (target) {
						const description = `${deprecationNotice(action.id)} ${target.config.description ?? ""}`.trim();
						(register as unknown as (n: string, c: ToolConfig, h: unknown) => unknown)(
							former.id,
							{ ...target.config, description },
							target.handler,
						);
					}
				}
			}
		}
	}
}

/**
 * Register all tools and aliases on the given McpServer instance.
 */
export function registerAllTools(
	server: McpServer,
	registry: ActionRegistry = serverRegistry(),
): Map<string, { config: ToolConfig; handler: unknown; actionId: string; seam: ActionAuditSeam }> {
	const { register, registered } = makeRegistrar(server, registry);

	// --- Google Drive tools ---

	register(
		"ingest_enrich_next",
		{
			description:
				"Enrich the oldest N 'discovered' pointers: pull their content from the source, store it, extract " +
				"text, and advance them to 'extracted' so they become fully searchable. The expensive, budgeted " +
				"half of Discover & Index. Only connectors with a server-side reader — currently Google Drive — " +
				"are enriched. Full notes: docs/guides/tools/ingest_enrich_next.md",
			inputSchema: enrichNextInput,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		enrichNextHandler,
	);

	registerAliases(register, registered, registry);


	return registered;
}

/**
 * Construct and configure the McpServer instance.
 *
 * Transport-agnostic: callers connect it to a `StdioServerTransport` (local dev,
 * see {@link file://./index.ts}) or a per-session `StreamableHTTPServerTransport`
 * (remote serving, see {@link file://./http.ts}). The HTTP path constructs a fresh
 * server per session, so this must be cheap and side-effect-free to call repeatedly.
 *
 * `toneRules` is injected by the entry points (loaded via loadToneRules in
 * dosConfig.ts) rather than fetched here, precisely to keep this synchronous and
 * side-effect-free (#819). `hotRows` (loadHotTier in hotTier.ts, #1023) follows the
 * same rule.
 */
export function createServer(
	toneRules: string[] | ToneRulesWithConfig | Partial<DosConfig> = [],
	hotRows: HotTierRow[] = [],
	registryOrOptions?: ActionRegistry | { registry?: ActionRegistry },
): McpServer {
	const registry =
		registryOrOptions && "list" in registryOrOptions
			? registryOrOptions
			: (registryOrOptions as { registry?: ActionRegistry } | undefined)?.registry ?? serverRegistry();
	const server = new McpServer(
		{
			name: "ahOS",
			version: "0.2.0",
		},
		{ instructions: buildInstructions(toneRules, hotRows) },
	);

	let registered: ReturnType<typeof registerAllTools> | undefined;
	recordSdkRejections(server, (name) => registered?.get(name));
	registered = registerAllTools(server, registry);

	return server;
}

/**
 * Return a catalog of all registered tools and their descriptions.
 */
export function getRegisteredToolCatalog(
	registry: ActionRegistry = serverRegistry(),
): { name: string; description: string }[] {
	const server = new McpServer({ name: "catalog", version: "0.0.0" });
	const registered = registerAllTools(server, registry);
	const catalog: { name: string; description: string }[] = [];
	for (const [name, entry] of registered.entries()) {
		catalog.push({ name, description: entry.config.description ?? "" });
	}
	return catalog;
}

setDefaultToolCatalogProvider(() =>
	serverRegistry()
		.list()
		.filter((a) => a.expose?.mcp !== false)
		.map((a) => ({ name: a.id, description: a.description })),
);
