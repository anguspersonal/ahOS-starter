import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getPostHogConnectionFromRepo,
	listPostHogConnectionsFromRepo,
} from "../../domain/posthog/contract.js";
import { createPostHogAdapter, resolveHost } from "./index.js";

function jsonRes(body: unknown, opts: { status?: number; statusText?: string } = {}): Response {
	const status = opts.status ?? 200;
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: opts.statusText ?? (status === 200 ? "OK" : "Error"),
		json: async () => (typeof body === "string" ? JSON.parse(body) : body),
		text: async () => text,
	} as unknown as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("resolveHost", () => {
	it("resolves eu and us region keys and passes custom https origins through without trailing slashes", () => {
		expect(resolveHost("eu")).toBe("https://eu.posthog.com");
		expect(resolveHost("us")).toBe("https://us.posthog.com");
		expect(resolveHost("https://posthog.example.com///")).toBe("https://posthog.example.com");
	});
});

describe("createPostHogAdapter", () => {
	const target = { ref: "posthog:work" as const, host: "eu" as const };

	it("requests (ref, { write: false }) on reads and (ref, { write: true }) on writes", async () => {
		const getCredential = vi.fn(async (_ref: string, opts: { write: boolean }) =>
			opts.write ? "phx_write_secret" : "phx_read_secret",
		);
		const fetchFn = vi.fn(async () => jsonRes({ results: [[42]], columns: ["count"] }));
		const adapter = createPostHogAdapter({ getCredential, fetchFn });

		await adapter.runQuery(target, 110015, { kind: "HogQLQuery", query: "select 1" });
		expect(getCredential).toHaveBeenCalledWith("posthog:work", { write: false });
		expect(fetchFn).toHaveBeenLastCalledWith(
			"https://eu.posthog.com/api/projects/110015/query/",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer phx_read_secret",
				}),
			}),
		);

		await adapter.writeCall(target, "/api/projects/110015/cohorts/1/", "PATCH", { name: "x" });
		expect(getCredential).toHaveBeenCalledWith("posthog:work", { write: true });
		expect(fetchFn).toHaveBeenLastCalledWith(
			"https://eu.posthog.com/api/projects/110015/cohorts/1/",
			expect.objectContaining({
				method: "PATCH",
				headers: expect.objectContaining({
					Authorization: "Bearer phx_write_secret",
				}),
			}),
		);
	});

	it("rejects on non-2xx with status and truncated body (max 600 chars) and never leaks the API key", async () => {
		const secretKey = "phx_super_secret_token_value";
		const getCredential = vi.fn(async () => secretKey);
		const longBody = `Permission denied for ${secretKey}: ${"x".repeat(800)}`;
		const fetchFn = vi.fn(async () =>
			jsonRes(longBody, { status: 403, statusText: "Forbidden" }),
		);
		const adapter = createPostHogAdapter(getCredential, { fetchFn });

		const err = await adapter.getRaw(target, "/api/projects/110015/").catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(
			"PostHog GET /api/projects/110015/ failed for 'posthog:work' at https://eu.posthog.com: 403 Forbidden",
		);
		expect((err as Error).message).not.toContain(secretKey);
		const detailLine = (err as Error).message.split("\n")[1] ?? "";
		expect(detailLine.length).toBeLessThanOrEqual(610);
	});

	it("resolves globalThis.fetch per call when fetchFn is not fixed at construction", async () => {
		const getCredential = vi.fn(async () => "phx_read_secret");
		const adapter = createPostHogAdapter(getCredential);

		const lateFetchStub = vi.fn(async () =>
			jsonRes({
				email: "owner@work.example.com",
				organization: { id: "org_1", name: "Work" },
			}),
		);
		vi.stubGlobal("fetch", lateFetchStub);

		const identity = await adapter.getIdentity(target);
		expect(lateFetchStub).toHaveBeenCalledOnce();
		expect(identity).toEqual({
			email: "owner@work.example.com",
			organizationName: "Work",
			organizationId: "org_1",
		});
	});

	it("maps listProjects and getProject responses cleanly", async () => {
		const getCredential = vi.fn(async () => "phx_read_secret");
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(jsonRes({ results: [{ id: 110015, name: "Work" }, { id: 99 }] }))
			.mockResolvedValueOnce(
				jsonRes({
					id: 110015,
					name: "Work",
					test_account_filters: [{ key: "is_test" }],
					test_account_filters_default_checked: true,
				}),
			);
		const adapter = createPostHogAdapter({ getCredential, fetchFn });

		const projects = await adapter.listProjects(target);
		expect(projects).toEqual([
			{ id: 110015, name: "Work" },
			{ id: 99, name: "(project 99)" },
		]);

		const detail = await adapter.getProject(target, 110015);
		expect(detail).toEqual({
			id: 110015,
			name: "Work",
			testAccountFilters: [{ key: "is_test" }],
			testAccountFiltersDefaultChecked: true,
		});
	});
});

describe("ConfigRepository PostHog connection loading", () => {
	const fakeRepo = {
		listByFamily: vi.fn(async () => [
			{
				provider: "posthog:work",
				enabled: true,
				routing: "own_substrate" as const,
				status: "connected",
				credential_ref: "posthog:work",
				config: {
					host: "eu",
					project_id: 110015,
					filter_policy: "required",
					write_policy: "allowed",
				},
			},
		]),
		loadIntegration: vi.fn(async (provider: string) =>
			provider === "posthog:work"
				? {
						provider: "posthog:work",
						enabled: true,
						routing: "own_substrate" as const,
						status: "connected",
						credential_ref: "posthog:work",
						config: {
							host: "eu",
							project_id: 110015,
							filter_policy: "required",
							write_policy: "allowed",
						},
					}
				: null,
		),
	};

	it("lists and resolves connections through ConfigRepository and names known slugs on miss", async () => {
		const conns = await listPostHogConnectionsFromRepo(fakeRepo);
		expect(conns).toHaveLength(1);
		expect(conns[0]?.slug).toBe("work");

		const one = await getPostHogConnectionFromRepo(fakeRepo, "work");
		expect(one.projectId).toBe(110015);

		await expect(getPostHogConnectionFromRepo(fakeRepo, "typo")).rejects.toThrow(
			/No usable PostHog connection 'typo'.*Configured connections: work/s,
		);
	});
});
