import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPostHogAdapter } from "../../adapters/posthog/index.js";
import type { PostHogConnection } from "../../domain/posthog/contract.js";
import type { PostHogPort } from "../../ports/posthog.js";
import { executeAction } from "../adapters/direct.js";
import type { ActionContext } from "../types.js";
import { createPosthogQueryAction } from "./query.js";
import {
	createPosthogQueryDebugAction,
	posthogQueryDebugInput,
	renderComparison,
} from "./queryDebug.js";
import {
	createPosthogWriteAction,
	posthogWriteInput,
} from "./write.js";

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
			// The debug tool's whole point is that this flag is the only thing that differs
			// between the two legs, so the mock has to actually respond to it rather than
			// return one fixed number for every call.
			return filters?.filterTestAccounts === false
				? { columns: ["count"], results: [[10891]] }
				: { columns: ["count"], results: [[8930]] };
		}),
		writeCall: vi.fn(async (_t: unknown, path: string, method: string) => ({
			status: "ok" as const,
			method,
			path,
			body: { id: 225061, name: "Non-organic install traffic" },
		})),
		getRaw: vi.fn(async () => ({ id: 225061, name: "before name" })),
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

describe("posthog write and debug actions — contract parity (#1483)", () => {
	it("1. posthog_query_debug contract matches legacy tool", () => {
		const action = createPosthogQueryDebugAction(makePort());

		expect(action.id).toBe("posthog_query_debug");
		expect(action.description).toBe(
			"Run one guarded query twice against a 'required'-policy connection — as given, and with only " +
				"filterTestAccounts flipped to false — and render total, filtered and difference together. The " +
				"unfiltered number is never emitted alone. Requires a `reason`, carried into the stamp. Full " +
				"notes: docs/guides/tools/posthog_query_debug.md",
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
					description: "Connection slug, e.g. 'work'. Must declare filter_policy 'required'.",
				},
				query: {
					type: "object",
					propertyNames: {
						type: "string",
					},
					additionalProperties: {},
					description:
						"The SAME guarded query shape posthog_query requires: for HogQL, the {filters} " +
						"placeholder in the SQL plus filters:{filterTestAccounts:true}; structured kinds " +
						"set filterTestAccounts:true directly. Pass exactly ONE query — this tool derives " +
						"the unfiltered leg itself by flipping filterTestAccounts to false on the identical " +
						"query text, it does not accept two.",
				},
				reason: {
					type: "string",
					minLength: 1,
					description:
						"Why this debugging read needs unfiltered traffic, e.g. 'reproducing the " +
						"scroll-to-end crash, which was hit on a test account'. Required: this tool exists " +
						"for a declared debugging purpose, not a general bypass of filter_policy, and the " +
						"reason is carried into the stamp so that purpose travels with the numbers.",
				},
			},
			required: ["connection", "query", "reason"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(
			z.toJSONSchema(z.object(posthogQueryDebugInput)),
		);
	});

	it("2. posthog_write contract matches legacy tool", () => {
		const action = createPosthogWriteAction(makePort());

		expect(action.id).toBe("posthog_write");
		expect(action.description).toBe(
			"Make one authenticated write against a PostHog connection (POST/PATCH/PUT/DELETE on an /api/ " +
				"path). Travels on a SEPARATE write credential, so reads keep a key that cannot mutate anything. " +
				"Refuses unless the connection declares write_policy 'allowed'; cohort and project-filter edits " +
				"need acknowledging, because they restate history. Full notes: docs/guides/tools/posthog_write.md",
		);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				connection: {
					type: "string",
					minLength: 1,
					description: "Connection slug, e.g. 'work'. Must declare write_policy 'allowed'.",
				},
				method: {
					type: "string",
					enum: ["POST", "PATCH", "PUT", "DELETE"],
					description: "HTTP method. DELETE additionally requires acknowledge_destructive.",
				},
				path: {
					type: "string",
					minLength: 1,
					description:
						"PostHog API path, starting '/api/'. When it names a project (/api/projects/<id>/...) " +
						"that id must match the connection's project, so a stamped result always describes " +
						"the project it claims. Example: '/api/projects/110015/cohorts/225061/'.",
				},
				body: {
					type: "object",
					propertyNames: {
						type: "string",
					},
					additionalProperties: {},
					description: "JSON request body, passed through verbatim. Omit for DELETE.",
				},
				acknowledge_retroactive: {
					type: "boolean",
					description:
						"Required for cohort and project-filter edits. Those are applied at QUERY time to " +
						"all history, so saving one restates every past number rather than only changing " +
						"what happens next. Set true only when that is understood and intended.",
				},
				acknowledge_destructive: {
					type: "boolean",
					description: "Required for DELETE. There is no undo.",
				},
			},
			required: ["connection", "method", "path"],
			additionalProperties: false,
		});
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(posthogWriteInput)));
	});
});

// The write passthrough is the widest surface here and the only one that can change
// anything, so every guard gets a test that proves it refuses BEFORE the network. A
// guard that fires after the write has landed is not a guard.
describe("posthog_write", () => {
	const cohortPath = "/api/projects/110015/cohorts/225061/";

	it("3. refuses DELETE without acknowledge_destructive with today's text and makes no port call", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		await expect(
			action.run(
				{
					connection: "work",
					method: "DELETE",
					path: "/api/projects/110015/insights/7/",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(
			"DELETE /api/projects/110015/insights/7/ refused: pass acknowledge_destructive: true. PostHog deletes are not recoverable from this surface, and no other guard here distinguishes a delete from an edit.",
		);
		expect(port.writeCall).not.toHaveBeenCalled();
	});

	it("4. refuses a connection that declares writes forbidden through assertWriteAllowed and a path outside the project through assertPathInProject", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		await expect(
			action.run(
				{
					connection: "acting",
					method: "PATCH",
					path: "/api/projects/190313/cohorts/1/",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/write_policy 'forbidden'/);
		expect(port.writeCall).not.toHaveBeenCalled();

		// The stamp is the whole point of this surface. A write to another project carrying
		// this connection's stamp would be a provenance lie, so the path is checked.
		await expect(
			action.run(
				{
					connection: "work",
					method: "PATCH",
					path: "/api/projects/999/cohorts/1/",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/addresses project 999.*is project 110015/s);
		expect(port.writeCall).not.toHaveBeenCalled();
	});

	it("refuses a connection whose write_policy is undeclared, before the network", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		await expect(
			action.run(
				{
					connection: "fresh",
					method: "PATCH",
					path: "/api/projects/200000/cohorts/1/",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/no write_policy declared/);
		expect(port.writeCall).not.toHaveBeenCalled();
	});

	it("refuses a path outside /api/", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		await expect(
			action.run(
				{
					connection: "work",
					method: "POST",
					path: "/internal/thing",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/must start with '\/api\/'/);
		expect(port.writeCall).not.toHaveBeenCalled();
	});

	// The lesson of 2026-09-09 encoded as a refusal rather than a comment: a cohort edit
	// restates history, so it cannot be made by accident.
	it("refuses a cohort edit without acknowledging that it restates history", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		await expect(
			action.run(
				{
					connection: "work",
					method: "PATCH",
					path: cohortPath,
					body: { name: "x" },
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/restates every past number/);
		expect(port.writeCall).not.toHaveBeenCalled();
	});

	it("performs an acknowledged cohort edit and shows what it overwrote", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		const text = await action.run(
			{
				connection: "work",
				method: "PATCH",
				path: cohortPath,
				body: { name: "Non-organic install traffic" },
				acknowledge_retroactive: true,
			},
			TEST_CONTEXT,
		);
		expect(port.writeCall).toHaveBeenCalledOnce();
		expect(port.getRaw).toHaveBeenCalledOnce();
		expect(text).toContain("before name");
		expect(text).toContain("This edit is retroactive");
		// Stamp first, same as every read.
		expect(text.indexOf("connection:")).toBeLessThan(text.indexOf("PATCH"));
	});

	it("records a non-fatal before-image note when getRaw fails on a retroactive edit", async () => {
		const port = makePort(Object.values(conns), {
			getRaw: vi.fn(async () => {
				throw new Error("403 Forbidden\nextra line");
			}),
		});
		const action = createPosthogWriteAction(port);

		const text = await action.run(
			{
				connection: "work",
				method: "PATCH",
				path: cohortPath,
				body: { name: "Non-organic install traffic" },
				acknowledge_retroactive: true,
			},
			TEST_CONTEXT,
		);
		expect(port.writeCall).toHaveBeenCalledOnce();
		expect(text).toContain("before: (could not be read on the read credential: 403 Forbidden)");
		expect(text).not.toContain("extra line");
	});

	it("does not demand the retroactive acknowledgement for an ordinary write", async () => {
		const port = makePort();
		const action = createPosthogWriteAction(port);

		const text = await action.run(
			{
				connection: "work",
				method: "POST",
				path: "/api/projects/110015/insights/",
				body: { name: "New insight" },
			},
			TEST_CONTEXT,
		);
		expect(port.writeCall).toHaveBeenCalledOnce();
		expect(text).not.toContain("This edit is retroactive");
	});
});

// #970: a second declared purpose for the same connection — debugging, unfiltered — not
// an override of posthog_query's guard.
describe("posthog_query_debug", () => {
	it("5. runs the query twice (filtered and total) and renders the comparison as renderComparison does today", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);

		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(port.runQuery).toHaveBeenCalledTimes(2);
		const calls = vi.mocked(port.runQuery).mock.calls;
		const queries = calls.map((c) => c[2] as Record<string, unknown>);

		// Same SQL string both times — only the flag differs.
		expect(queries[0].query).toBe(GUARDED.query);
		expect(queries[1].query).toBe(GUARDED.query);
		const flags = queries.map(
			(q) => (q.filters as { filterTestAccounts?: unknown }).filterTestAccounts,
		);
		expect(flags.sort()).toEqual([false, true]);

		const expectedComparison = renderComparison(
			{ columns: ["count"], results: [[8930]] },
			{ columns: ["count"], results: [[10891]] },
		);
		expect(out).toContain(expectedComparison);
	});

	it("6. the write uses the write key ({ write: true }), the debug query the read key ({ write: false })", async () => {
		const getCredential = vi.fn(async (_ref: string, opts: { write: boolean }) =>
			opts.write ? "phx_write_secret" : "phx_read_secret",
		);
		const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const bodyStr = typeof init?.body === "string" ? init.body : "";
			const isUnfiltered = bodyStr.includes('"filterTestAccounts":false');
			const payload = bodyStr.includes("HogQLQuery")
				? { columns: ["count"], results: [[isUnfiltered ? 10891 : 8930]] }
				: { id: 1, name: "New insight" };
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => payload,
				text: async () => JSON.stringify(payload),
			} as unknown as Response;
		});

		const adapter = createPostHogAdapter({
			getCredential,
			fetchFn,
			config: {
				listByFamily: async () => [],
				loadIntegration: async () => ({
					provider: "posthog:work",
					enabled: true,
					routing: "own_substrate" as const,
					status: "connected",
					credential_ref: "posthog:work",
					config: {
						host: "eu",
						project_id: 110015,
						filter_policy: "required" as const,
						write_policy: "allowed" as const,
					},
				}),
			},
		});

		const debugAction = createPosthogQueryDebugAction(adapter);
		await debugAction.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);
		expect(getCredential).toHaveBeenCalledWith("posthog:work", { write: false });
		expect(getCredential).not.toHaveBeenCalledWith("posthog:work", { write: true });

		getCredential.mockClear();

		const writeAction = createPosthogWriteAction(adapter);
		await writeAction.run(
			{
				connection: "work",
				method: "POST",
				path: "/api/projects/110015/insights/",
				body: { name: "New insight" },
			},
			TEST_CONTEXT,
		);
		expect(getCredential).toHaveBeenCalledWith("posthog:work", { write: true });
	});

	it("refuses an unguarded query BEFORE touching the network, same as posthog_query", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);

		await expect(
			action.run(
				{
					connection: "work",
					query: { kind: "HogQLQuery", query: "select count() from events" },
					reason: "reproducing a bug",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/\{filters\} placeholder/);

		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("refuses a connection with no filter_policy declared", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);

		await expect(
			action.run(
				{ connection: "fresh", query: GUARDED, reason: "reproducing a bug" },
				TEST_CONTEXT,
			),
		).rejects.toThrow(/no filter_policy declared/);

		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("refuses a connection whose policy is not_applicable — nothing to compare against", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);

		await expect(
			action.run(
				{
					connection: "acting",
					query: { kind: "HogQLQuery", query: "select count() from events" },
					reason: "reproducing a bug",
				},
				TEST_CONTEXT,
			),
		).rejects.toThrow(/not_applicable/);

		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("requires a non-empty reason at the schema level", () => {
		const schema = z.object(posthogQueryDebugInput);
		expect(
			schema.safeParse({ connection: "work", query: GUARDED, reason: "" }).success,
		).toBe(false);
		expect(schema.safeParse({ connection: "work", query: GUARDED }).success).toBe(
			false,
		);
		expect(
			schema.safeParse({ connection: "work", query: GUARDED, reason: "ok" }).success,
		).toBe(true);
	});

	it("renders total AND filtered together — the unfiltered number never appears alone", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(out).toContain("8930");
		expect(out).toContain("10891");
		expect(out).toMatch(/total\s+\(unfiltered/i);
		expect(out).toMatch(/filtered\s+\(test accounts excluded/i);
	});

	it("labels the delta line 'difference', never 'test traffic'", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(out).toContain("1961"); // 10891 - 8930
		expect(out).toMatch(/difference \(total − filtered\):\s+1961/);
		// The caveat below the number is allowed to explain when a delta like this IS
		// test-account traffic; what must never happen is the delta itself being labelled
		// that on the line that carries the number (#970's correctness detail).
		expect(out).not.toMatch(/^\s*test traffic:/im);
	});

	it("carries the reason into the stamp", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{
				connection: "work",
				query: GUARDED,
				reason: "reproducing the scroll-to-end crash",
			},
			TEST_CONTEXT,
		);

		expect(out).toContain("reproducing the scroll-to-end crash");
	});

	it("inverts the stamp's filter-policy line to flag the debug read", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(out).toMatch(/filter policy: required — DEBUG READ, INCLUDES TEST ACCOUNTS/);
	});

	it("puts the stamp BEFORE any number, same discipline as posthog_query", async () => {
		const port = makePort();
		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(out.indexOf("posthog:work")).toBeLessThan(out.indexOf("8930"));
	});

	it("does not mutate posthog_query's own guard or behaviour", async () => {
		const port = makePort();
		const queryAction = createPosthogQueryAction(port);
		await expect(
			executeAction(queryAction, {
				connection: "work",
				query: { kind: "HogQLQuery", query: "select count() from events" },
			}),
		).rejects.toThrow(/\{filters\} placeholder/);
	});

	it("renders both full result tables and skips the subtraction for a non-scalar result (e.g. a breakdown), never labelling it a difference or test traffic", async () => {
		const port = makePort();
		vi.mocked(port.runQuery)
			.mockImplementationOnce(async () => ({
				columns: ["$os", "count"],
				results: [
					["iOS", 100],
					["Android", 50],
				],
			}))
			.mockImplementationOnce(async () => ({
				columns: ["$os", "count"],
				results: [
					["iOS", 120],
					["Android", 55],
				],
			}));

		const action = createPosthogQueryDebugAction(port);
		const out = await action.run(
			{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
			TEST_CONTEXT,
		);

		expect(out).toContain("total (unfiltered, includes test accounts):");
		expect(out).toContain("filtered (test accounts excluded):");
		expect(out).toContain("iOS");
		expect(out).toContain("120");
		expect(out).toContain("100");
		expect(out).toMatch(/No difference computed/);
		expect(out).not.toMatch(/difference \(total/);
		expect(out).not.toMatch(/test traffic/i);
	});

	it("appends the property-access hint when runQuery fails with a HogQL unresolved-field error (#1944)", async () => {
		const port = makePort();
		vi.mocked(port.runQuery).mockRejectedValueOnce(
			new Error("PostHog 400 (hogql_query): Unable to resolve field: $lib"),
		);

		const action = createPosthogQueryDebugAction(port);
		await expect(
			action.run(
				{ connection: "work", query: GUARDED, reason: "reproducing a bug" },
				TEST_CONTEXT,
			),
		).rejects.toThrow(/Unable to resolve field: \$lib.*properties\.\$lib.*person\.properties\.<name>/s);
	});
});
