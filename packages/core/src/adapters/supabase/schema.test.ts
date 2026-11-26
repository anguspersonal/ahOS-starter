import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseSchemaIntrospectionAdapter } from "./schema.js";

type Call = { url: string; headers: Record<string, string> };

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

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("createSupabaseSchemaIntrospectionAdapter", () => {
	it("hits the REST root with the service-role key in both headers", async () => {
		const calls = fakePostgrest({ definitions: {} });
		const adapter = createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: "http://localhost:54321",
			serviceRoleKey: "secret-service-role-key",
		});

		await adapter.fetchOpenApi();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://localhost:54321/rest/v1/");
		expect(calls[0].headers.apikey).toBe("secret-service-role-key");
		expect(calls[0].headers.Authorization).toBe("Bearer secret-service-role-key");
	});

	it("does not double the slash when supabaseUrl carries a trailing one", async () => {
		const calls = fakePostgrest({ definitions: {} });
		const adapter = createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: () => "http://localhost:54321///",
			serviceRoleKey: () => "secret-service-role-key",
		});

		await adapter.fetchOpenApi();
		expect(calls[0].url).toBe("http://localhost:54321/rest/v1/");
	});

	it("names the service-role requirement and never leaks the key when PostgREST rejects the request", async () => {
		const secretKey = "super-secret-service-role-key-do-not-leak";
		fakePostgrest(null, {
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			body: '{"message":"Invalid API key"}',
		});
		const adapter = createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: "http://localhost:54321",
			serviceRoleKey: secretKey,
		});

		await expect(adapter.fetchOpenApi()).rejects.toThrow(/401 Unauthorized/);
		await expect(adapter.fetchOpenApi()).rejects.toThrow(/service_role/);
		try {
			await adapter.fetchOpenApi();
		} catch (err) {
			expect((err as Error).message).not.toContain(secretKey);
		}
	});

	it("gives a clear, actionable message without leaking the key when the fetch is aborted", async () => {
		const secretKey = "super-secret-service-role-key-do-not-leak";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const err = new Error("This operation was aborted");
				err.name = "AbortError";
				throw err;
			}),
		);
		const adapter = createSupabaseSchemaIntrospectionAdapter({
			supabaseUrl: "http://localhost:54321",
			serviceRoleKey: secretKey,
		});

		await expect(adapter.fetchOpenApi()).rejects.toThrow(/did not respond within/);
		try {
			await adapter.fetchOpenApi();
		} catch (err) {
			expect((err as Error).message).not.toContain(secretKey);
		}
	});
});
