import { describe, expect, it } from "vitest";
import { createGoogleDriveAdapter } from "../../adapters/google/drive/index.js";
import { executeAction } from "../adapters/direct.js";
import { createDriveListAction } from "./list.js";
import { createDriveAboutAction, createDriveGetMetadataAction, createDriveListPermissionsAction } from "./metadata.js";
import { createDriveUpdateContentAction } from "./uploadFile.js";

function makeLivePort(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
	const sleeps: number[] = [];
	const port = createGoogleDriveAdapter({
		clientId: "cid", clientSecret: "csec",
		refreshToken: async (d) => (d === "work" ? "rt-h" : "rt-p"),
		sleepFn: async (ms) => { sleeps.push(ms); },
		fetchFn: async (input, init) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				return new Response(JSON.stringify({ access_token: "tok-1" }), { status: 200 });
			}
			return handler(url, init);
		},
	});
	return { port, sleeps };
}

describe("Drive ops alignment (#1653)", () => {
	it("1. incompleteSearch: true requests incompleteSearch in LIST_FIELDS and warns on partial corpus", async () => {
		let seenFields: string | null = null;
		const { port } = makeLivePort((url) => {
			seenFields = url.searchParams.get("fields");
			return new Response(JSON.stringify({ files: [{ id: "f-1", name: "Report.pdf", mimeType: "application/pdf" }], incompleteSearch: true }), { status: 200 });
		});
		const action = createDriveListAction(port);
		const out = await executeAction(action, { domain: "work" }, { context: { caller: "mcp" } });
		expect(seenFields).toContain("incompleteSearch");
		expect(out.file_ids).toEqual(["f-1"]);
		expect(out.count).toBe(1);
		expect(action.formatMcp!(out)).toContain("Drive searched only part of the corpus; results may be missing.");
	});

	it("2. drive_list_permissions pages across pages, states a cut past the cap, and reports empty cleanly", async () => {
		const { port } = makeLivePort((url) => {
			const token = url.searchParams.get("pageToken");
			if (url.pathname.includes("/f-empty/")) return new Response(JSON.stringify({ permissions: [] }), { status: 200 });
			if (url.pathname.includes("/f-two/")) {
				return !token
					? new Response(JSON.stringify({ permissions: [{ id: "p-1", role: "owner", type: "user", emailAddress: "a@example.com" }], nextPageToken: "p2" }), { status: 200 })
					: new Response(JSON.stringify({ permissions: [{ id: "p-2", role: "reader", type: "domain", domain: "work.example.com" }] }), { status: 200 });
			}
			const n = token ? Number(token.slice(1)) : 1;
			return new Response(JSON.stringify({ permissions: [{ id: `p-${n}`, role: "reader", type: "user", emailAddress: `u${n}@b.com` }], nextPageToken: `p${n + 1}` }), { status: 200 });
		});
		const emptyAction = createDriveListPermissionsAction(port);
		const emptyOut = await executeAction(emptyAction, { domain: "angus", file_id: "f-empty" }, { context: { caller: "mcp" } });
		expect(emptyAction.formatMcp!(emptyOut)).toBe("Drive returned no permissions.");

		const twoOut = await executeAction(emptyAction, { domain: "work", file_id: "f-two" }, { context: { caller: "mcp" } });
		expect(twoOut.permissions.map((p) => p.id)).toEqual(["p-1", "p-2"]);
		expect(twoOut.truncated).toBe(false);

		const cappedTwo = createDriveListPermissionsAction(port, { maxPages: 2 });
		const cutTwoOut = await executeAction(cappedTwo, { domain: "work", file_id: "f-many" }, { context: { caller: "mcp" } });
		expect(cutTwoOut).toMatchObject({ count: 2, pages_fetched: 2, truncated: true });
		expect(cappedTwo.formatMcp!(cutTwoOut)).toContain("Stopped after 2 pages; more permissions exist on Drive.");

		const cutTenOut = await executeAction(emptyAction, { domain: "work", file_id: "f-many" }, { context: { caller: "mcp" } });
		expect(cutTenOut).toMatchObject({ count: 10, pages_fetched: 10, truncated: true });
		expect(emptyAction.formatMcp!(cutTenOut)).toContain("Stopped after 10 pages; more permissions exist on Drive.");
	});

	it("3. drive_about maps storage quota fields and handles unlimited accounts without percent", async () => {
		const { port } = makeLivePort((url) => {
			const isUnlimited = url.searchParams.get("fields")?.includes("storageQuota") && calls++ > 0;
			return new Response(JSON.stringify({
				user: { emailAddress: isUnlimited ? "owner@work.example.com" : "owner@example.com" },
				storageQuota: isUnlimited
					? { usage: "5000", usageInDrive: "4000", usageInDriveTrash: "1000" }
					: { limit: "10000", usage: "2500", usageInDrive: "2000", usageInDriveTrash: "500" },
			}), { status: 200 });
		});
		let calls = 0;
		const action = createDriveAboutAction(port);
		const capped = await executeAction(action, { domain: "angus" }, { context: { caller: "mcp" } });
		expect(capped).toEqual({
			domain: "angus", email: "owner@example.com", quota_limit_bytes: 10000,
			usage_bytes: 2500, usage_in_drive_bytes: 2000, usage_in_trash_bytes: 500, usage_percent: 25,
		});
		expect(action.formatMcp!(capped)).toContain("25% used");

		const unlimited = await executeAction(action, { domain: "work" }, { context: { caller: "mcp" } });
		expect(unlimited).toEqual({
			domain: "work", email: "owner@work.example.com", quota_limit_bytes: null,
			usage_bytes: 5000, usage_in_drive_bytes: 4000, usage_in_trash_bytes: 1000, usage_percent: null,
		});
		expect(action.formatMcp!(unlimited)).not.toContain("%");
	});

	it("4. drive_update_content enforces expected_version, refuses Google Docs, and emits receipt without names or content", async () => {
		const writes: URL[] = [];
		const { port } = makeLivePort((url, init) => {
			if ((init?.method ?? "GET") === "PATCH") {
				writes.push(url);
				return new Response(JSON.stringify({ id: "f-bin", name: "SecretName.txt", mimeType: "text/plain", size: "11", version: "43" }), { status: 200 });
			}
			if (url.pathname.endsWith("/f-doc")) {
				return new Response(JSON.stringify({ id: "f-doc", mimeType: "application/vnd.google-apps.document", version: "9" }), { status: 200 });
			}
			return new Response(JSON.stringify({ id: "f-bin", name: "SecretName.txt", mimeType: "text/plain", version: "42" }), { status: 200 });
		});
		const metaAction = createDriveGetMetadataAction(port);
		const meta = await executeAction(metaAction, { domain: "angus", file_id: "f-bin" }, { context: { caller: "mcp" } });
		expect(meta.version).toBe("42");

		const updateAction = createDriveUpdateContentAction(port);
		await expect(executeAction(updateAction, {
			domain: "angus", file_id: "f-bin", text: "stale write", mime_type: "text/plain", expected_version: "41",
		}, { context: { caller: "mcp" } })).rejects.toThrow("the file changed since you read it");
		expect(writes).toHaveLength(0);

		await expect(executeAction(updateAction, {
			domain: "angus", file_id: "f-doc", text: "nope", mime_type: "text/plain", expected_version: "9",
		}, { context: { caller: "mcp" } })).rejects.toThrow(/Google-native/);
		expect(writes).toHaveLength(0);

		const ok = await executeAction(updateAction, {
			domain: "angus", file_id: "f-bin", text: "fresh payload", mime_type: "text/plain", expected_version: "42", keep_revision_forever: true,
		}, { context: { caller: "mcp" } });
		expect(writes).toHaveLength(1);
		expect(writes[0].searchParams.get("keepRevisionForever")).toBe("true");
		expect(ok).toEqual({ domain: "angus", file_id: "f-bin", file_ids: ["f-bin"], byte_count: 13, version: "43", keep_revision_forever: true });
		const rendered = JSON.stringify(ok) + "\n" + updateAction.formatMcp!(ok);
		expect(rendered).not.toContain("SecretName.txt");
		expect(rendered).not.toContain("fresh payload");
	});

	it("5. retries reads on 429 and 403 rateLimitExceeded up to twice, and never retries writes on 429", async () => {
		let getAttempts = 0;
		let patchAttempts = 0;
		const { port, sleeps } = makeLivePort((_url, init) => {
			if ((init?.method ?? "GET") === "PATCH") {
				patchAttempts++;
				return new Response(JSON.stringify({ error: { code: 429, message: "Too Many Requests" } }), { status: 429 });
			}
			getAttempts++;
			if (getAttempts === 1) return new Response(JSON.stringify({ error: { code: 429, message: "Slow down" } }), { status: 429 });
			if (getAttempts === 2) {
				return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } }), { status: 403 });
			}
			return new Response(JSON.stringify({ id: "f-1", name: "Notes.txt", mimeType: "text/plain", version: "7" }), { status: 200 });
		});

		const meta = await executeAction(createDriveGetMetadataAction(port), { domain: "angus", file_id: "f-1" }, { context: { caller: "mcp" } });
		expect(meta.version).toBe("7");
		expect(getAttempts).toBe(3);
		expect(sleeps).toEqual([250, 500]);

		await expect(executeAction(createDriveUpdateContentAction(port), {
			domain: "angus", file_id: "f-1", text: "next", mime_type: "text/plain", expected_version: "7",
		}, { context: { caller: "mcp" } })).rejects.toMatchObject({ status: 429 });
		expect(patchAttempts).toBe(1);
	});
});
