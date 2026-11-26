import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDefinition, parseOpenApi } from "@ahkms/core";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";

async function describeSchemaHandler(args: { table?: string }): Promise<{ content: { type: "text"; text: string }[] }> {
	const action = serverRegistry().get("store_schema")!;
	return toMcpTool(action).handler(args);
}

type Call = { url: string; headers: Record<string, string> };

/**
 * A stand-in for PostgREST's OpenAPI root. Only `definitions` matters to the tool; the
 * real document also carries `paths`, `parameters` and `swagger`, which are deliberately
 * ignored, so the fixture omits them to prove nothing depends on them.
 */
function fakePostgrest(
	doc: unknown,
	init: { ok?: boolean; status?: number; statusText?: string; body?: string } = {},
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options: RequestInit = {}) => {
			calls.push({ url, headers: (options.headers ?? {}) as Record<string, string> });
			return {
				ok: init.ok ?? true,
				status: init.status ?? 200,
				statusText: init.statusText ?? "OK",
				json: async () => doc,
				text: async () => init.body ?? JSON.stringify(doc),
			} as unknown as Response;
		}),
	);
	return calls;
}

const SPEC = {
	definitions: {
		entities: {
			required: ["user_id", "name"],
			properties: {
				id: {
					format: "uuid",
					type: "string",
					description: "Note:\nThis is a Primary Key.<pk/>",
				},
				user_id: { format: "uuid", type: "string" },
				name: { format: "text", type: "string" },
				kind: { format: "entity_kind", type: "string", enum: ["project", "org"] },
				// NOT NULL *with* a default: PostgREST leaves it out of `required`, which is
				// exactly the case a "nullable" reading would get wrong.
				created_at: { format: "timestamp with time zone", type: "string" },
			},
		},
		artifacts: {
			required: ["user_id"],
			properties: {
				id: { format: "uuid", type: "string" },
				title: { format: "text", type: "string" },
				user_id: { format: "uuid", type: "string" },
			},
		},
	},
};

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content[0].text;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("parseDefinition - OpenAPI property mapping", () => {
	it("reads the Postgres type from `format` and the JSON type from `type`", () => {
		const table = parseDefinition("entities", SPEC.definitions.entities);
		const createdAt = table.columns.find((c) => c.name === "created_at");
		expect(createdAt?.type).toBe("timestamp with time zone");
		expect(createdAt?.jsonType).toBe("string");
	});

	it("flags a column in `required` as required-on-insert", () => {
		const table = parseDefinition("entities", SPEC.definitions.entities);
		expect(table.columns.find((c) => c.name === "name")?.requiredOnInsert).toBe(true);
	});

	/**
	 * The single most misreadable thing in this file. PostgREST's `required` is "must be
	 * supplied on INSERT" — NOT NULL *and* no default. `created_at timestamptz NOT NULL
	 * DEFAULT now()` is therefore absent from it. If anything downstream ever renames this
	 * field to `nullable`, this test is what fails.
	 */
	it("does NOT flag a NOT NULL column that carries a default, so the flag is not nullability", () => {
		const table = parseDefinition("entities", SPEC.definitions.entities);
		expect(table.columns.find((c) => c.name === "created_at")?.requiredOnInsert).toBe(false);
	});

	it("carries enum values and PostgREST's note through", () => {
		const table = parseDefinition("entities", SPEC.definitions.entities);
		expect(table.columns.find((c) => c.name === "kind")?.enumValues).toEqual([
			"project",
			"org",
		]);
		expect(table.columns.find((c) => c.name === "id")?.description).toContain("<pk/>");
	});

	it("falls back to 'unknown' rather than dropping a property with no format or type", () => {
		const table = parseDefinition("odd", { properties: { mystery: {} } });
		expect(table.columns).toEqual([
			{ name: "mystery", type: "unknown", jsonType: "unknown", requiredOnInsert: false },
		]);
	});

	it("sorts tables by name so the listing is stable across calls", () => {
		expect(parseOpenApi(SPEC).map((t) => t.name)).toEqual(["artifacts", "entities"]);
	});
});

describe("store_schema - the request", () => {
	it("hits the REST root with the service-role key in both headers", async () => {
		const calls = fakePostgrest(SPEC);
		await describeSchemaHandler({});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://localhost:54321/rest/v1/");
		expect(calls[0].headers.apikey).toBe("test-service-role-key");
		expect(calls[0].headers.Authorization).toBe("Bearer test-service-role-key");
	});

	it("does not double the slash when SUPABASE_URL carries a trailing one", async () => {
		const previous = process.env.SUPABASE_URL;
		process.env.SUPABASE_URL = "http://localhost:54321/";
		try {
			const calls = fakePostgrest(SPEC);
			await describeSchemaHandler({});
			expect(calls[0].url).toBe("http://localhost:54321/rest/v1/");
		} finally {
			process.env.SUPABASE_URL = previous;
		}
	});

	it("names the service-role requirement when PostgREST rejects the key", async () => {
		fakePostgrest(null, {
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			body: '{"message":"Invalid API key"}',
		});
		await expect(describeSchemaHandler({})).rejects.toThrow(/401 Unauthorized/);
		await expect(describeSchemaHandler({})).rejects.toThrow(/service_role/);
	});

	it("gives a clear, actionable message when the fetch is aborted for taking too long", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const err = new Error("This operation was aborted");
				err.name = "AbortError";
				throw err;
			}),
		);
		await expect(describeSchemaHandler({})).rejects.toThrow(/did not respond within/);
	});

	// The head arriving is not the request finishing. Before the timer was moved past
	// the body read, this case hung: `fetch` resolved, `clearTimeout` fired, and the
	// stalled `res.json()` had nothing left to abort it.
	it("times out a response whose head arrives but whose body never does", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => {
					const err = new Error("This operation was aborted");
					err.name = "AbortError";
					throw err;
				},
			})),
		);
		await expect(describeSchemaHandler({})).rejects.toThrow(/did not respond within/);
	});
});

describe("store_schema - listing", () => {
	it("lists every exposed table with its column count when no table is given", async () => {
		fakePostgrest(SPEC);
		const text = textOf(await describeSchemaHandler({}));
		expect(text).toContain("2 table(s)/view(s)");
		expect(text).toContain("artifacts  (3 column(s))");
		expect(text).toContain("entities  (5 column(s))");
	});

	/**
	 * An empty `definitions` is a configuration answer ("the public schema is no longer
	 * exposed"), never "the database has no tables". Returning a cheerful empty list would
	 * be the reads-as-working-while-doing-nothing failure this repo keeps finding.
	 */
	it("throws rather than returning an empty list when PostgREST publishes no definitions", async () => {
		fakePostgrest({ definitions: {} });
		await expect(describeSchemaHandler({})).rejects.toThrow(/no table definitions/);
	});
});

describe("store_schema - one table", () => {
	it("renders each column with its Postgres type, JSON type, enum and note", async () => {
		fakePostgrest(SPEC);
		const text = textOf(await describeSchemaHandler({ table: "entities" }));
		expect(text).toContain("entities — 5 column(s)");
		expect(text).toContain("name  text (json: string)  [required-on-insert]");
		expect(text).toContain("kind  entity_kind (json: string)  [enum: project | org]");
		expect(text).toContain("created_at  timestamp with time zone (json: string)");
	});

	it("collapses the newline PostgREST puts in a note so one column stays one line", async () => {
		fakePostgrest(SPEC);
		const text = textOf(await describeSchemaHandler({ table: "entities" }));
		const idLine = text.split("\n").find((l) => l.trim().startsWith("id "));
		expect(idLine).toContain("Note: This is a Primary Key.<pk/>");
	});

	it("states that the flag is not nullability", async () => {
		fakePostgrest(SPEC);
		const text = textOf(await describeSchemaHandler({ table: "entities" }));
		expect(text).toContain("it is not nullability");
	});

	it("emits the machine-readable fence alongside the prose", async () => {
		fakePostgrest(SPEC);
		const text = textOf(await describeSchemaHandler({ table: "artifacts" }));
		const fence = text.slice(text.indexOf("```json") + 7, text.lastIndexOf("```"));
		expect(JSON.parse(fence).columns.map((c: { name: string }) => c.name)).toEqual([
			"id",
			"title",
			"user_id",
		]);
	});

	it("lists what does exist when the table is unknown, rather than returning nothing", async () => {
		fakePostgrest(SPEC);
		await expect(describeSchemaHandler({ table: "artifact" })).rejects.toThrow(
			/no table or view named 'artifact'[\s\S]*artifacts, entities/,
		);
	});
});
