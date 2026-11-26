import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	const { getCredential } = await import("../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import("../google/accounts.js");
	return {
		...actual,
		getGoogleAccessToken: vi.fn(async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
			await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
			return `fake_token_${account}`;
		}),
	};
});

import { getDraftRecipients, ownerAddresses, parseAddressList, resetOwnerAddressesForTests } from "../google/gmail.js";

function stubFetchQueue(responses: { payload?: unknown; ok?: boolean; status?: number }[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	let i = 0;
	vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = responses[Math.min(i++, responses.length - 1)];
		const ok = r.ok ?? true;
		return { ok, status: r.status ?? (ok ? 200 : 500), json: async () => r.payload, text: async () => JSON.stringify(r.payload ?? {}) } as Response;
	}));
	return calls;
}

const origPersonal = process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

beforeEach(() => {
	process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = "fake_personal_refresh";
	process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh";
	resetOwnerAddressesForTests();
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (origPersonal === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
	else process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = origPersonal;
	if (origWork === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
	else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWork;
});

describe("gmail recipients and ownerAddresses (#1426)", () => {
	it("5. getDraftRecipients requests format=metadata without metadataHeaders and parses To, Cc and Bcc case-insensitively", async () => {
		const calls = stubFetchQueue([{
			payload: {
				id: "r1",
				message: {
					id: "m1",
					threadId: "t1",
					payload: {
						headers: [
							{ name: "To", value: '"Hally, Angus" <a@example.com>, b@example.com' },
							{ name: "to", value: "c@example.com" },
							{ name: "CC", value: "cc1@example.com, cc2@example.com" },
							{ name: "bCc", value: "bcc1@example.com" },
						],
					},
				},
			},
		}]);
		const res = await getDraftRecipients("personal", "r1");
		expect(calls[0].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/r1?format=metadata");
		expect(res).toEqual({
			to: [{ name: "Hally, Angus", address: "a@example.com" }, { name: null, address: "b@example.com" }, { name: null, address: "c@example.com" }],
			cc: [{ name: null, address: "cc1@example.com" }, { name: null, address: "cc2@example.com" }],
			bcc: [{ name: null, address: "bcc1@example.com" }],
		});
	});

	it("6. parseAddressList splits outside quotes, angle brackets and comments, returns address: null for groups/bare names, and [] for empty", () => {
		expect(parseAddressList('"Hally, Angus" <a@example.com>, b@example.com')).toEqual([{ name: "Hally, Angus", address: "a@example.com" }, { name: null, address: "b@example.com" }]);
		expect(parseAddressList("a@example.com (Hally, Angus), <b@example.com>")).toEqual([{ name: "Hally, Angus", address: "a@example.com" }, { name: null, address: "b@example.com" }]);
		expect(parseAddressList("Friends: x@example.com;")).toEqual([{ name: "Friends: x@example.com;", address: null }]);
		expect(parseAddressList("Bare Name")).toEqual([{ name: "Bare Name", address: null }]);
		expect(parseAddressList("")).toEqual([]);
	});

	it("7. ownerAddresses lower-cases and caches successes, retries (unknown) and thrown reads, and throws when empty", async () => {
		const calls = stubFetchQueue([{ payload: { emailAddress: "owner@example.com" } }, { payload: { emailAddress: "Owner@work.example.com" } }]);
		expect([...(await ownerAddresses())]).toEqual(["owner@example.com", "owner@work.example.com"]);
		expect([...(await ownerAddresses())]).toEqual(["owner@example.com", "owner@work.example.com"]);
		expect(calls).toHaveLength(2);
		resetOwnerAddressesForTests();
		const retryCalls = stubFetchQueue([
			{ payload: { emailAddress: "owner@example.com" } },
			{ payload: { emailAddress: "(unknown)" } },
			{ ok: false, status: 404 },
			{ payload: { emailAddress: "Owner@work.example.com" } },
		]);
		expect([...(await ownerAddresses())]).toEqual(["owner@example.com"]);
		expect([...(await ownerAddresses())]).toEqual(["owner@example.com"]);
		expect(retryCalls).toHaveLength(3);
		expect([...(await ownerAddresses())]).toEqual(["owner@example.com", "owner@work.example.com"]);
		expect(retryCalls).toHaveLength(4);
		resetOwnerAddressesForTests();
		stubFetchQueue([{ payload: { emailAddress: "(unknown)" } }, { ok: false, status: 503 }]);
		await expect(ownerAddresses()).rejects.toThrow();
	});
});
