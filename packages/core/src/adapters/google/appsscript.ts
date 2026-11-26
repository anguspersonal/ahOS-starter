import {
	AppsScriptApiError, type AppsScriptPort, type ScriptDeployment, type ScriptFile,
	type ScriptOperation, type ScriptProject, type ScriptProjectListing, type ScriptVersion,
} from "../../ports/appsscript.js";
import { createGoogleTokenSource, type GoogleTokenSourceConfig } from "./tokenSource.js";

const SCRIPT_API_BASE = "https://script.googleapis.com/v1";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const LIST_FIELDS =
	"nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, owners(displayName,emailAddress), parents, webViewLink, trashed, shared)";

export type GoogleAppsScriptAdapterConfig = GoogleTokenSourceConfig;
const escapeQueryValue = (v: string): string => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function createGoogleAppsScriptAdapter(config: GoogleAppsScriptAdapterConfig): AppsScriptPort {
	const tokenSource = createGoogleTokenSource(config);

	async function request<T>(accessToken: string, method: string, url: string, body?: unknown): Promise<T> {
		const fetchImpl = config.fetchFn ?? globalThis.fetch;
		const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetchImpl(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
		if (!res.ok) throw new AppsScriptApiError(`Google Apps Script API ${method} failed (HTTP ${res.status})`, res.status);
		return (await res.json()) as T;
	}

	return {
		async listProjects({ domain, query, folderId, pageSize = 25 }) {
			const token = await tokenSource.accessToken(domain);
			const clauses = ["mimeType = 'application/vnd.google-apps.script'", "trashed = false"];
			if (folderId) clauses.push(`'${escapeQueryValue(folderId)}' in parents`);
			if (query) clauses.push(`name contains '${escapeQueryValue(query)}'`);
			const qs = new URLSearchParams({
				q: clauses.join(" and "), pageSize: String(Math.min(pageSize, 100)),
				orderBy: "modifiedTime desc", fields: LIST_FIELDS, includeItemsFromAllDrives: "true", supportsAllDrives: "true",
			});
			const data = await request<{ files?: ScriptProjectListing[] }>(token, "GET", `${DRIVE_FILES_URL}?${qs.toString()}`);
			return data.files ?? [];
		},
		async getProject({ domain, scriptId }) {
			const token = await tokenSource.accessToken(domain);
			return request<ScriptProject>(token, "GET", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}`);
		},
		async createProject({ domain, title, parentId, folderId }) {
			const token = await tokenSource.accessToken(domain);
			const project = await request<ScriptProject>(token, "POST", `${SCRIPT_API_BASE}/projects`, { title, parentId: parentId || undefined });
			if (!parentId && folderId && project.scriptId) {
				const qs = new URLSearchParams({ addParents: folderId, removeParents: "root", fields: "id, parents", supportsAllDrives: "true" });
				try {
					await request(token, "PATCH", `${DRIVE_FILES_URL}/${encodeURIComponent(project.scriptId)}?${qs.toString()}`);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					return { ...project, moveWarning: `Could not move new script ${project.scriptId} to folder ${folderId}: ${detail}` };
				}
			}
			return project;
		},
		async getContent({ domain, scriptId, versionNumber }) {
			const token = await tokenSource.accessToken(domain);
			const qs = versionNumber !== undefined ? `?versionNumber=${encodeURIComponent(String(versionNumber))}` : "";
			const data = await request<{ scriptId?: string; files?: ScriptFile[] }>(token, "GET", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/content${qs}`);
			return { scriptId: data.scriptId ?? scriptId, files: data.files ?? [] };
		},
		async updateContent({ domain, scriptId, files }) {
			const token = await tokenSource.accessToken(domain);
			const data = await request<{ scriptId?: string; files?: ScriptFile[] }>(token, "PUT", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/content`, { files });
			return { scriptId: data.scriptId ?? scriptId, files: data.files ?? [] };
		},
		async createVersion({ domain, scriptId, description }) {
			const token = await tokenSource.accessToken(domain);
			return request<ScriptVersion>(token, "POST", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/versions`, { description });
		},
		async listVersions({ domain, scriptId, pageSize = 50 }) {
			const token = await tokenSource.accessToken(domain);
			const qs = new URLSearchParams({ pageSize: String(Math.min(pageSize, 100)) });
			const data = await request<{ versions?: ScriptVersion[] }>(token, "GET", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/versions?${qs.toString()}`);
			return data.versions ?? [];
		},
		async listDeployments({ domain, scriptId }) {
			const token = await tokenSource.accessToken(domain);
			const data = await request<{ deployments?: ScriptDeployment[] }>(token, "GET", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/deployments`);
			return data.deployments ?? [];
		},
		async createDeployment({ domain, scriptId, versionNumber, description, manifestFileName = "appsscript" }) {
			const token = await tokenSource.accessToken(domain);
			return request<ScriptDeployment>(token, "POST", `${SCRIPT_API_BASE}/projects/${encodeURIComponent(scriptId)}/deployments`, { versionNumber, description, manifestFileName });
		},
		async run({ domain, scriptId, functionName, parameters = [], devMode = false }) {
			const token = await tokenSource.accessToken(domain);
			return request<ScriptOperation>(token, "POST", `${SCRIPT_API_BASE}/scripts/${encodeURIComponent(scriptId)}:run`, { function: functionName, parameters, devMode });
		},
	};
}
