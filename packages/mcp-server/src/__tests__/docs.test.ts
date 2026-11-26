import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	const { getCredential } = await import("../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import(
		"../google/accounts.js"
	);
	return {
		...actual,
		getGoogleAccessToken: vi.fn(
			async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
				await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
				return "fake_access_token";
			},
		),
	};
});

import { countDocumentTabs, readDocument } from "../google/docs.js";

const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

beforeEach(() => {
	process.env.GOOGLE_REFRESH_TOKEN = "fake_refresh_token";
	process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh_token";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ documentId: "d1", title: "T", body: { content: [] } }),
			text: async () => "{}",
		}) as Response),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (origRefresh === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
	else process.env.GOOGLE_REFRESH_TOKEN = origRefresh;
	if (origWork === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
	else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWork;
});

describe("google/docs wrappers", () => {
	it("mints for the requested account and delegates readDocument and countDocumentTabs", async () => {
		const doc = await readDocument("d1", "work");
		expect(doc.documentId).toBe("d1");
		expect(await countDocumentTabs("d1", "work")).toBe(1);
	});

	it("does not silently fall back to the personal account when Work is unwired", async () => {
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		await expect(readDocument("d1", "work")).rejects.toThrow(
			/GOOGLE_REFRESH_TOKEN_WORK is not set/,
		);
		await expect(countDocumentTabs("d1", "work")).rejects.toThrow(
			/GOOGLE_REFRESH_TOKEN_WORK is not set/,
		);
	});
});
