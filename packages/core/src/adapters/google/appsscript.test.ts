import { describe, expect, it, vi } from "vitest";
import type { Domain } from "../../domain/domains.js";
import type { AppsScriptPort } from "../../ports/appsscript.js";
import { createGoogleAppsScriptAdapter } from "./appsscript.js";

function makeStubAdapter(apiResponse: () => Response | Promise<Response>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const refreshLookup = vi.fn(async (d: Domain) => `rt-${d}`);
	const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		if (url === "https://oauth2.googleapis.com/token") {
			return new Response(JSON.stringify({ access_token: "at-secret-123" }), { status: 200 });
		}
		return apiResponse();
	}) as unknown as typeof fetch;
	const adapter = createGoogleAppsScriptAdapter({ clientId: "cid", clientSecret: "csecret", refreshToken: refreshLookup, fetchFn });
	return { adapter, calls, refreshLookup };
}

describe("createGoogleAppsScriptAdapter (issue #1633)", () => {
	it("1. exchanges refresh token per call, sends Bearer token, and refuses invalid domain or missing credentials", async () => {
		const { adapter, calls, refreshLookup } = makeStubAdapter(() => new Response(JSON.stringify({ scriptId: "s1" }), { status: 200 }));
		await adapter.getProject({ domain: "work", scriptId: "s1" });
		expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0]?.init?.method).toBe("POST");
		expect(String(calls[0]?.init?.body)).toContain("grant_type=refresh_token");
		expect(String(calls[0]?.init?.body)).toContain("refresh_token=rt-work");
		expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer at-secret-123");
		refreshLookup.mockClear();
		await expect(adapter.getProject({ domain: "bogus" as Domain, scriptId: "s1" })).rejects.toThrow(/bogus/);
		expect(refreshLookup).not.toHaveBeenCalled();
		const noToken = createGoogleAppsScriptAdapter({ clientId: "c", clientSecret: "s", refreshToken: async () => null });
		await expect(noToken.getProject({ domain: "angus", scriptId: "s1" })).rejects.toThrow(/angus/);
		const noClient = createGoogleAppsScriptAdapter({ clientId: "", clientSecret: "s", refreshToken: async () => "rt" });
		await expect(noClient.getProject({ domain: "work", scriptId: "s1" })).rejects.toThrow(/work/);
	});

	it("2. listProjects sends Drive files.list with escaped query/folder, orderBy, supportsAllDrives and pageSize capped at 100", async () => {
		const { adapter, calls } = makeStubAdapter(() => new Response(JSON.stringify({ files: [{ id: "f1" }] }), { status: 200 }));
		const files = await adapter.listProjects({ domain: "angus", query: "O'Reilly\\Tool", folderId: "fld'1", pageSize: 500 });
		expect(files).toEqual([{ id: "f1" }]);
		const u = new URL(calls[1]!.url);
		expect(`${u.origin}${u.pathname}`).toBe("https://www.googleapis.com/drive/v3/files");
		expect(u.searchParams.get("q")).toBe("mimeType = 'application/vnd.google-apps.script' and trashed = false and 'fld\\'1' in parents and name contains 'O\\'Reilly\\\\Tool'");
		expect(u.searchParams.get("orderBy")).toBe("modifiedTime desc");
		expect(u.searchParams.get("supportsAllDrives")).toBe("true");
		expect(u.searchParams.get("includeItemsFromAllDrives")).toBe("true");
		expect(u.searchParams.get("pageSize")).toBe("100");
	});

	it.each<{ name: string; invoke: (p: AppsScriptPort) => Promise<unknown>; method: string; url: string; body?: Record<string, unknown> }>([
		{ name: "getProject", invoke: (p) => p.getProject({ domain: "angus", scriptId: "s1" }), method: "GET", url: "https://script.googleapis.com/v1/projects/s1" },
		{ name: "getContent", invoke: (p) => p.getContent({ domain: "angus", scriptId: "s1", versionNumber: 3 }), method: "GET", url: "https://script.googleapis.com/v1/projects/s1/content?versionNumber=3" },
		{ name: "listVersions", invoke: (p) => p.listVersions({ domain: "angus", scriptId: "s1", pageSize: 20 }), method: "GET", url: "https://script.googleapis.com/v1/projects/s1/versions?pageSize=20" },
		{ name: "listDeployments", invoke: (p) => p.listDeployments({ domain: "angus", scriptId: "s1" }), method: "GET", url: "https://script.googleapis.com/v1/projects/s1/deployments" },
		{ name: "createVersion", invoke: (p) => p.createVersion({ domain: "angus", scriptId: "s1", description: "v1" }), method: "POST", url: "https://script.googleapis.com/v1/projects/s1/versions", body: { description: "v1" } },
		{ name: "createDeployment", invoke: (p) => p.createDeployment({ domain: "angus", scriptId: "s1", versionNumber: 2, description: "prod", manifestFileName: "appsscript" }), method: "POST", url: "https://script.googleapis.com/v1/projects/s1/deployments", body: { versionNumber: 2, description: "prod", manifestFileName: "appsscript" } },
		{ name: "createProject", invoke: (p) => p.createProject({ domain: "angus", title: "MyProj", parentId: "p1" }), method: "POST", url: "https://script.googleapis.com/v1/projects", body: { title: "MyProj", parentId: "p1" } },
		{ name: "updateContent", invoke: (p) => p.updateContent({ domain: "angus", scriptId: "s1", files: [{ name: "Code", type: "SERVER_JS", source: "" }] }), method: "PUT", url: "https://script.googleapis.com/v1/projects/s1/content", body: { files: [{ name: "Code", type: "SERVER_JS", source: "" }] } },
		{ name: "run", invoke: (p) => p.run({ domain: "angus", scriptId: "s1", functionName: "fn", parameters: [1], devMode: true }), method: "POST", url: "https://script.googleapis.com/v1/scripts/s1:run", body: { function: "fn", parameters: [1], devMode: true } },
	])("3. $name hits $method $url", async ({ invoke, method, url, body }) => {
		const { adapter, calls } = makeStubAdapter(() => new Response(JSON.stringify({ scriptId: "s1" }), { status: 200 }));
		await invoke(adapter);
		expect(calls[1]?.init?.method).toBe(method);
		expect(calls[1]?.url).toBe(url);
		if (body) expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(body);
	});

	it("4. non-2xx throws error with status property and never leaks token or response body", async () => {
		const { adapter } = makeStubAdapter(() => new Response("SENSITIVE_RESPONSE_BODY_XYZ", { status: 403 }));
		const err = await adapter.getProject({ domain: "angus", scriptId: "s1" }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.status).toBe(403);
		expect(err.message).not.toContain("at-secret-123");
		expect(err.message).not.toContain("rt-angus");
		expect(err.message).not.toContain("SENSITIVE_RESPONSE_BODY_XYZ");
	});

	it("5. createProject with folderId and no parentId moves file with Drive files.update and reports failed move in result", async () => {
		let patchStatus = 200;
		const { adapter, calls } = makeStubAdapter(() => {
			const last = calls[calls.length - 1]!;
			if (last.init?.method === "PATCH") return new Response("{}", { status: patchStatus });
			return new Response(JSON.stringify({ scriptId: "new-s1", title: "Standalone" }), { status: 200 });
		});
		const okRes = await adapter.createProject({ domain: "angus", title: "Standalone", folderId: "fld-9" });
		expect(okRes.moveWarning).toBeUndefined();
		const patchUrl = new URL(calls[2]!.url);
		expect(calls[2]?.init?.method).toBe("PATCH");
		expect(`${patchUrl.origin}${patchUrl.pathname}`).toBe("https://www.googleapis.com/drive/v3/files/new-s1");
		expect(patchUrl.searchParams.get("addParents")).toBe("fld-9");
		expect(patchUrl.searchParams.get("removeParents")).toBe("root");
		patchStatus = 500;
		const warnRes = await adapter.createProject({ domain: "angus", title: "Standalone", folderId: "fld-9" });
		expect(warnRes.scriptId).toBe("new-s1");
		expect(warnRes.moveWarning).toContain("Could not move new script new-s1 to folder fld-9");
	});
});
