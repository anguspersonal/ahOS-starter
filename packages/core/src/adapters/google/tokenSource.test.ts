import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleTokenSource } from "./tokenSource.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("createGoogleTokenSource (issue #1480)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("mints with the angus refresh token for domain angus and the work one for work", async () => {
		const tokenBodies: string[] = [];

		const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = String(init?.body ?? "");
			tokenBodies.push(body);
			const token = body.includes("rt-angus") ? "at-angus" : "at-work";
			return jsonResponse({ access_token: token });
		}) as unknown as typeof fetch;

		const source = createGoogleTokenSource({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async (d) => (d === "angus" ? "rt-angus" : "rt-work"),
			fetchFn,
		});

		const atAngus = await source.accessToken("angus");
		const atWork = await source.accessToken("work");

		expect(atAngus).toBe("at-angus");
		expect(atWork).toBe("at-work");
		expect(tokenBodies[0]).toContain("refresh_token=rt-angus");
		expect(tokenBodies[1]).toContain("refresh_token=rt-work");
	});

	it("refuses an unknown domain and an empty refresh token before any request, naming the domain", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const refreshToken = vi.fn(async () => "   ");

		const source = createGoogleTokenSource({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken,
			fetchFn,
		});

		await expect(source.accessToken("bogus" as any)).rejects.toThrow(/bogus/);
		expect(refreshToken).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();

		await expect(source.accessToken("work")).rejects.toThrow(/work/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("names a missing client id or secret before any request", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const refreshToken = vi.fn(async () => "rt-angus");

		const missingId = createGoogleTokenSource({
			clientId: "",
			clientSecret: "csecret",
			refreshToken,
			fetchFn,
		});
		await expect(missingId.accessToken("angus")).rejects.toThrow(/angus/);

		const missingSecret = createGoogleTokenSource({
			clientId: "cid",
			clientSecret: "  ",
			refreshToken,
			fetchFn,
		});
		await expect(missingSecret.accessToken("work")).rejects.toThrow(/work/);

		expect(refreshToken).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("throws a plain Error naming the domain, status and Google error code and never the body or tokens", async () => {
		const secretRefresh = "1//03-SUPER-SECRET-REFRESH-TOKEN";
		const secretAccess = "ya29.SUPER-SECRET-ACCESS-TOKEN";
		const rawBodySecret = "RAW_RESPONSE_BODY_DETAIL_DO_NOT_LEAK";

		const failingFetch = vi.fn(async () =>
			jsonResponse(
				{
					error: "invalid_grant",
					error_description: `${rawBodySecret} ${secretRefresh} ${secretAccess}`,
				},
				400,
			),
		) as unknown as typeof fetch;

		const source = createGoogleTokenSource({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => secretRefresh,
			fetchFn: failingFetch,
		});

		let caught: Error | undefined;
		try {
			await source.accessToken("angus");
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect(caught!.name).toBe("Error");
		expect(caught!.message).toContain("angus");
		expect(caught!.message).toContain("400");
		expect(caught!.message).toContain("invalid_grant");
		expect(caught!.message).not.toContain(rawBodySecret);
		expect(caught!.message).not.toContain(secretRefresh);
		expect(caught!.message).not.toContain(secretAccess);
	});

	it("resolves globalThis.fetch per call when fetchFn is not provided", async () => {
		const fetch1 = vi.fn(async () => jsonResponse({ access_token: "at-1" }));
		const fetch2 = vi.fn(async () => jsonResponse({ access_token: "at-2" }));

		const source = createGoogleTokenSource({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
		});

		vi.stubGlobal("fetch", fetch1);
		expect(await source.accessToken("angus")).toBe("at-1");
		expect(fetch1).toHaveBeenCalledTimes(1);

		vi.stubGlobal("fetch", fetch2);
		expect(await source.accessToken("angus")).toBe("at-2");
		expect(fetch2).toHaveBeenCalledTimes(1);
	});
});
