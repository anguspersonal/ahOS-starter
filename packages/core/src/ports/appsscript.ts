import type { Domain } from "../domain/domains.js";
import type { DriveFile } from "./drive.js";

export class AppsScriptApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "AppsScriptApiError";
		this.status = status;
	}
}

export type ScriptProjectListing = DriveFile;

export interface ScriptFile {
	name?: string | null;
	type?: "SERVER_JS" | "HTML" | "JSON" | "ENUM_TYPE_UNSPECIFIED" | string | null;
	source?: string | null;
	createTime?: string | null;
	updateTime?: string | null;
}
export interface ScriptProject {
	scriptId?: string | null;
	title?: string | null;
	parentId?: string | null;
	createTime?: string | null;
	updateTime?: string | null;
	moveWarning?: string | null;
}
export interface ScriptVersion {
	scriptId?: string | null;
	versionNumber?: number | null;
	description?: string | null;
	createTime?: string | null;
}
export interface ScriptDeployment {
	deploymentId?: string | null;
	deploymentConfig?: { scriptId?: string | null; versionNumber?: number | null; manifestFileName?: string | null; description?: string | null } | null;
	updateTime?: string | null;
	entryPoints?: Array<{ entryPointType?: string | null; webApp?: { url?: string | null } | null }> | null;
}
export interface ScriptOperation {
	done?: boolean | null;
	error?: { code?: number | null; message?: string | null; details?: Array<Record<string, unknown>> | null } | null;
	response?: ({ result?: unknown } & Record<string, unknown>) | null;
}

export interface AppsScriptPort {
	listProjects(params: { domain: Domain; query?: string; folderId?: string; pageSize?: number }): Promise<ScriptProjectListing[]>;
	getProject(params: { domain: Domain; scriptId: string }): Promise<ScriptProject>;
	createProject(params: { domain: Domain; title: string; parentId?: string; folderId?: string }): Promise<ScriptProject>;
	getContent(params: { domain: Domain; scriptId: string; versionNumber?: number }): Promise<{ scriptId?: string; files: ScriptFile[] }>;
	updateContent(params: { domain: Domain; scriptId: string; files: ScriptFile[] }): Promise<{ scriptId?: string; files: ScriptFile[] }>;
	createVersion(params: { domain: Domain; scriptId: string; description?: string }): Promise<ScriptVersion>;
	listVersions(params: { domain: Domain; scriptId: string; pageSize?: number }): Promise<ScriptVersion[]>;
	listDeployments(params: { domain: Domain; scriptId: string }): Promise<ScriptDeployment[]>;
	createDeployment(params: { domain: Domain; scriptId: string; versionNumber: number; description?: string; manifestFileName?: string }): Promise<ScriptDeployment>;
	run(params: { domain: Domain; scriptId: string; functionName: string; parameters?: unknown[]; devMode?: boolean }): Promise<ScriptOperation>;
}
