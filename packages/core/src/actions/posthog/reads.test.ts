import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	HOGQL_PROPERTY_ACCESS_HINT,
	type PostHogConnection,
} from "../../domain/posthog/contract.js";
import type { PostHogPort } from "../../ports/posthog.js";
import type { ActionContext } from "../types.js";
import {
	createPosthogConnectionsAction,
	posthogConnectionsInput,
} from "./connections.js";
import {
	createPosthogProjectFilterAction,
	posthogProjectFilterInput,
} from "./projectFilter.js";
import {
	createPosthogQueryAction,
	posthogQueryInput,
} from "./query.js";

const TEST_CONTEXT: ActionContext = {
	userId: "user-1",
	caller: "mcp",
	requestId: "req-1",
};

const conns: Record<string, PostHogConnection> = {
	work: {
		slug: "work",
		ref: "posthog:work",
		projectId: 110015,
		host: "eu",
		filterPolicy: "required",
		writePolicy: "allowed",
		platformScoping: { app: "$lib = 'posthog-react-native'", web: "$lib = 'web'" },
	},
	acting: {
		slug: "acting",
		ref: "posthog:acting",
		projectId: 190313,
		host: "eu",
		filterPolicy: "not_applicable",
		writePolicy: "forbidden",
		platformScoping: null,
	},
	fresh: {
		slug: "fresh",
		ref: "posthog:fresh",
		projectId: 200000,
		host: "us",
		filterPolicy: null,
		// Undeclared on BOTH axes, which is the state the guards must refuse on.
		writePolicy: null,
		platformScoping: null,
	},
};

const GUARDED = {
	kind: "HogQLQuery",
	query: "select count() from events where {filters}",
	filters: { filterTestAccounts: true },
};

function makePort(
	connectionList: PostHogConnection[] = Object.values(conns),
	overrides?: Partial<PostHogPort>,
): PostHogPort {
	return {
		getIdentity: vi.fn(async () => ({
			email: "owner@work.example.com",
			organizationName: "Work",
			organizationId: "org-1",
		})),
		listProjects: vi.fn(async () => [{ id: 110015, name: "Work" }]),
		getProject: vi.fn(async () => ({
			id: 110015,
			name: "Work",
			testAccountFilters: [{ key: "is_test", type: "event", value: ["true"], operator: "is_not" }],
			testAccountFiltersDefaultChecked: true,
		})),
		runQuery: vi.fn(async (_t: unknown, _p: number, query: Record<string, unknown>) => {
			const filters = query.filters as { filterTestAccounts?: unknown } | undefined;
			return filters?.filterTestAccounts === false
				? { columns: ["count"], results: [[10891]] }
				: { columns: ["count"], results: [[8930]] };
		}),
		writeCall: vi.fn(async (_t: unknown, path: string, method: string) => ({
			status: "ok" as const,
			method,
			path,
			body: {},
		})),
		getRaw: vi.fn(async () => ({})),
		listConnections: vi.fn(async () => connectionList),
		getConnection: vi.fn(async (slug: string) => {
			const found = connectionList.find((c) => c.slug === slug);
			if (found) return found;
			const known = connectionList.map((c) => c.slug);
			throw new Error(
				`No usable PostHog connection '${slug}'. ${
					known.length
						? `Configured connections: ${known.join(", ")}.`
						: "No PostHog connections are configured yet."
				} A connection is one user_integrations row with provider 'posthog:${slug}' and a config carrying host and project_id (ADR-060).`,
			);
		}),
		...overrides,
	};
}

describe("posthog read actions — contract parity", () => {
	it("1. posthog_connections contract matches legacy tool", () => {
		const action = createPosthogConnectionsAction(makePort());

		expect(action.id).toBe("posthog_connections");
		expect(action.description).toBe(
			"List the configured PostHog connections with their project id, region and test-account filter policy. Each connection is a separate PostHog project with its own contract, so their numbers are NOT comparable and must never be summed. A connection whose filter policy is UNDECLARED refuses reads until a policy is set.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(posthogConnectionsInput)),
		);
	});

	it("2. posthog_project_filter contract matches legacy tool", () => {
		const action = createPosthogProjectFilterAction(makePort());

		expect(action.id).toBe("posthog_project_filter");
		expect(action.description).toBe(
			"Read a PostHog project's own 'filter out internal and test users' setting, live from PostHog. This is the authoritative content of the test-account contract (#742); it is deliberately not copied into this repo, so use this rather than assuming what it contains.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				connection: {
					type: "string",
					minLength: 1,
					description: "Connection slug, e.g. 'work' (the row provider is 'posthog:<slug>').",
				},
			},
			required: ["connection"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(posthogProjectFilterInput)),
		);
	});

	it("3. posthog_query contract matches legacy tool", () => {
		const action = createPosthogQueryAction(makePort());

		expect(action.id).toBe("posthog_query");
		expect(action.description).toBe(
			"Run one read query against a single PostHog connection and return the rows stamped with connection, project, region, filter policy and pull time. Refuses (never silently rewrites) a HogQL query that omits the {filters} placeholder when the connection requires filtering, because PostHog would otherwise return unfiltered numbers that look correct. One connection per call by design: cross-connection totals are meaningless.",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				connection: {
					type: "string",
					minLength: 1,
					description: "Connection slug, e.g. 'work'. Run posthog_connections to list them.",
				},
				query: {
					type: "object",
					propertyNames: {
						type: "string",
					},
					additionalProperties: {},
					description:
						"A PostHog query object, passed through verbatim. For raw SQL use {kind:'HogQLQuery', query:'...'}. " +
						"IMPORTANT: when the connection's filter policy is 'required', a HogQL query MUST include the literal " +
						"`{filters}` placeholder in its WHERE clause (e.g. `... where timestamp >= now() - interval 7 day and {filters}`) " +
						"AND pass `filters: {filterTestAccounts: true}` alongside it. Without both, PostHog silently returns unfiltered " +
						"numbers that look correct — measured at 18% high on 7-day event volume for project 110015. Structured query " +
						"kinds (TrendsQuery etc.) set `filterTestAccounts: true` directly instead. There is no " +
						"debugging bypass on this tool — for a declared debugging read that needs unfiltered " +
						"traffic, use posthog_query_debug instead, which always returns filtered and unfiltered " +
						`together rather than the unfiltered figure alone. ${HOGQL_PROPERTY_ACCESS_HINT}`,
				},
			},
			required: ["connection", "query"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(posthogQueryInput)));
	});
});

describe("posthog_query", () => {
	it("refuses an unguarded query BEFORE touching the network", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);

		await expect(
			action.run(
				{
					connection: "work",
					query: { kind: "HogQLQuery", query: "select count() from events" },
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/\{filters\} placeholder/);

		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("refuses a read against an undeclared connection before the network", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);

		await expect(
			action.run({ connection: "fresh", query: GUARDED }, TEST_CONTEXT),
		).rejects.toThrow(/no filter_policy declared/);

		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("runs a guarded query and returns the rows", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);
		const out = await action.run({ connection: "work", query: GUARDED }, TEST_CONTEXT);

		expect(port.runQuery).toHaveBeenCalledOnce();
		expect(out).toContain("8930");
	});

	it("puts the stamp BEFORE any number", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);
		const out = await action.run({ connection: "work", query: GUARDED }, TEST_CONTEXT);

		expect(out.startsWith("connection:    posthog:work\n")).toBe(true);
		expect(out.indexOf("posthog:work")).toBeLessThan(out.indexOf("8930"));
		expect(out.indexOf("110015")).toBeLessThan(out.indexOf("8930"));
		expect(out).toMatch(/filter policy: required/);
		expect(out).toMatch(/region: {8}eu/);
		expect(out).toMatch(/pulled at: {5}\d{4}-\d{2}-\d{2}T/);
	});

	it("lets an unfiltered query through where the project has no filter", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);
		const out = await action.run(
			{
				connection: "acting",
				query: { kind: "HogQLQuery", query: "select count() from events" },
			},
			TEST_CONTEXT,
		);

		expect(port.runQuery).toHaveBeenCalledOnce();
		expect(out).toMatch(/filter policy: not_applicable/);
	});

	it("passes the query through verbatim rather than rewriting it", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);
		await action.run({ connection: "work", query: GUARDED }, TEST_CONTEXT);

		expect(vi.mocked(port.runQuery).mock.calls[0][2]).toEqual(GUARDED);
	});

	it("has no debugging bypass — an unguarded query is refused even with an unrecognised purpose field", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);
		const argsWithLegacyPurpose = {
			connection: "work",
			query: { kind: "HogQLQuery", query: "select count() from events" },
			purpose: "debugging",
		} as unknown as { connection: string; query: Record<string, unknown> };

		await expect(action.run(argsWithLegacyPurpose, TEST_CONTEXT)).rejects.toThrow(
			/filter_policy 'required'/,
		);
		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("names the configured connections when an unknown slug is requested", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);

		await expect(
			action.run({ connection: "unknown", query: GUARDED }, TEST_CONTEXT),
		).rejects.toThrow(/No usable PostHog connection 'unknown'\. Configured connections: work, acting, fresh\./);
		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("documents HogQL property-access syntax on query input and appends the hint on hogql_query field errors (#1944)", async () => {
		const port = makePort();
		const action = createPosthogQueryAction(port);

		expect(posthogQueryInput.query.description).toContain("properties.<name>");
		expect(posthogQueryInput.query.description).toContain("properties.$lib");
		expect(posthogQueryInput.query.description).toContain("properties.$os");
		expect(posthogQueryInput.query.description).toContain("person.properties.<name>");

		vi.mocked(port.runQuery).mockRejectedValueOnce(
			new Error("PostHog 400 (hogql_query): Unable to resolve field: $lib"),
		);
		await expect(
			action.run({ connection: "work", query: GUARDED }, TEST_CONTEXT),
		).rejects.toThrow(/Unable to resolve field: \$lib.*properties\.\$lib/s);

		const plainErr = new Error("PostHog 502 Bad Gateway");
		vi.mocked(port.runQuery).mockRejectedValueOnce(plainErr);
		await expect(action.run({ connection: "work", query: GUARDED }, TEST_CONTEXT)).rejects.toBe(
			plainErr,
		);
	});
});

describe("posthog_connections", () => {
	it("spells out UNDECLARED rather than leaving a blank", async () => {
		const action = createPosthogConnectionsAction(makePort());
		const out = await action.run({}, TEST_CONTEXT);

		expect(out).toMatch(/UNDECLARED \(reads are refused/);
	});

	it("warns that numbers across connections are not comparable", async () => {
		const action = createPosthogConnectionsAction(makePort());
		const out = await action.run({}, TEST_CONTEXT);

		expect(out).toMatch(/never be summed/);
	});

	it("names each connection's slug, host, project id and policy, and never a key", async () => {
		const action = createPosthogConnectionsAction(makePort());
		const out = await action.run({}, TEST_CONTEXT);

		expect(out).toContain("posthog:work");
		expect(out).toContain("110015");
		expect(out).toContain("region: eu");
		expect(out).toContain("filter policy: required");
		expect(out).toContain("posthog:acting");
		expect(out).toContain("190313");
		expect(out).toContain("filter policy: not_applicable");
		expect(out).toContain("posthog:fresh");
		expect(out).toContain("region: us");
		expect(out).not.toMatch(/phx_|api_key|secret/i);
	});

	it("explains how to configure a connection when none exist", async () => {
		const action = createPosthogConnectionsAction(makePort([]));
		const out = await action.run({}, TEST_CONTEXT);

		expect(out).toContain("No PostHog connections configured");
	});
});

describe("posthog_project_filter", () => {
	it("returns the project's own clauses, stamped", async () => {
		const port = makePort();
		const action = createPosthogProjectFilterAction(port);
		const out = await action.run({ connection: "work" }, TEST_CONTEXT);

		expect(out).toContain("is_test");
		expect(out).toMatch(/connection: {4}posthog:work/);
		expect(out).toMatch(/not stored in this repo/);
	});
});
