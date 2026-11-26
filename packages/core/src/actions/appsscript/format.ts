import type {
	ScriptDeployment,
	ScriptFile,
	ScriptProject,
	ScriptVersion,
} from "../../ports/appsscript.js";
import { formatFile, type DriveFile } from "../../ports/drive.js";

export interface FormattedDriveFile {
	id: string | null;
	name: string | null;
	mime_type: string | null;
	modified_time: string | null;
	created_time: string | null;
	parents: string[] | null;
	web_view_link: string | null;
}

export interface FormattedScriptProject {
	script_id: string | null;
	title: string | null;
	create_time: string | null;
	update_time: string | null;
	parent_id: string | null;
}

export interface FormattedScriptFile {
	name: string | null;
	type: ScriptFile["type"];
	source: string;
	line_count: number;
}

export interface FormattedScriptVersion {
	script_id: string | null;
	version_number: number | null;
	description: string | null;
	create_time: string | null;
}

export interface FormattedScriptDeployment {
	deployment_id: string | null;
	version_number: number | null;
	description: string | null;
	manifest_file_name: string | null;
	update_time: string | null;
	entry_points: Array<{
		entry_point_type: string | null;
		web_app_url: string | null;
	}>;
}

/**
 * Normalise a Drive file entry for structured Apps Script project listings.
 */
export function formatDriveFile(f: DriveFile): FormattedDriveFile {
	const item: FormattedDriveFile = {
		id: f.id ?? null,
		name: f.name ?? null,
		mime_type: f.mimeType ?? null,
		modified_time: f.modifiedTime ?? null,
		created_time: f.createdTime ?? null,
		parents: f.parents ?? null,
		web_view_link: f.webViewLink ?? null,
	};
	Object.defineProperty(item, "_mcpLine", {
		value: formatFile(f),
		enumerable: false,
	});
	return item;
}

/**
 * Format a single Drive project listing line for MCP text output.
 */
export function formatDriveFileLine(
	f: FormattedDriveFile | DriveFile | string,
): string {
	if (typeof f === "string") return f;
	const cached = (f as { _mcpLine?: string })._mcpLine;
	if (cached) return cached;
	const mimeType = "mime_type" in f ? f.mime_type : f.mimeType;
	const modifiedTime = "modified_time" in f ? f.modified_time : f.modifiedTime;
	const size = "size" in f ? f.size : undefined;
	const trashed = "trashed" in f ? f.trashed : undefined;
	const owners = "owners" in f ? f.owners : undefined;
	const bits: string[] = [mimeType ?? "?"];
	if (size) bits.push(`${size} bytes`);
	if (modifiedTime) bits.push(`modified ${modifiedTime}`);
	if (trashed) bits.push("TRASHED");
	if (owners?.[0]?.emailAddress) bits.push(`owner ${owners[0].emailAddress}`);
	return `• [${f.id}] ${f.name ?? "(unnamed)"} (${bits.join(", ")})`;
}

/**
 * Normalise project metadata into structured snake_case fields.
 */
export function formatProject(p: ScriptProject): FormattedScriptProject {
	return {
		script_id: p.scriptId ?? null,
		title: p.title ?? null,
		create_time: p.createTime ?? null,
		update_time: p.updateTime ?? null,
		parent_id: p.parentId ?? null,
	};
}

/**
 * Format project metadata for human/agent MCP reading.
 */
export function formatProjectLine(p: FormattedScriptProject | ScriptProject): string {
	const scriptId = "script_id" in p ? p.script_id : p.scriptId;
	const createTime = "create_time" in p ? p.create_time : p.createTime;
	const updateTime = "update_time" in p ? p.update_time : p.updateTime;
	const parentId = "parent_id" in p ? p.parent_id : p.parentId;
	const bits: string[] = [];
	if (createTime) bits.push(`created: ${createTime}`);
	if (updateTime) bits.push(`modified: ${updateTime}`);
	if (parentId) bits.push(`container: ${parentId}`);
	return `• [${scriptId}] ${p.title ?? "(unnamed script)"} (${bits.join(", ")})`;
}

/**
 * Normalise a script file entry with computed line_count.
 */
export function formatScriptFile(f: ScriptFile): FormattedScriptFile {
	const source = f.source ?? "";
	return {
		name: f.name ?? null,
		type: f.type ?? null,
		source,
		line_count: f.source ? f.source.split("\n").length : 0,
	};
}

/**
 * Format a list of project files for human/agent reading.
 */
export function formatScriptFiles(
	files: Array<ScriptFile | FormattedScriptFile>,
): string {
	if (files.length === 0) return "No files in project.";
	return files
		.map((f) => {
			const ext = f.type === "HTML" ? ".html" : f.type === "JSON" ? ".json" : ".gs";
			const displayName = f.name?.endsWith(ext) ? f.name : `${f.name}${ext}`;
			const lines =
				"line_count" in f && typeof f.line_count === "number"
					? f.line_count
					: f.source
						? f.source.split("\n").length
						: 0;
			return `• ${displayName} (${f.type}, ${lines} lines)`;
		})
		.join("\n");
}

/**
 * Normalise a script version entry into structured snake_case fields.
 */
export function formatVersion(v: ScriptVersion): FormattedScriptVersion {
	return {
		script_id: v.scriptId ?? null,
		version_number: v.versionNumber ?? null,
		description: v.description ?? null,
		create_time: v.createTime ?? null,
	};
}

/**
 * Format a list of versions for human/agent reading.
 */
export function formatVersions(
	versions: Array<ScriptVersion | FormattedScriptVersion>,
): string {
	if (versions.length === 0) return "No versions found.";
	return versions
		.map((v) => {
			const versionNumber =
				"version_number" in v ? v.version_number : v.versionNumber;
			const createTime = "create_time" in v ? v.create_time : v.createTime;
			const desc = v.description ? `: ${v.description}` : "";
			return `• v${versionNumber}${desc} (created ${createTime ?? "unknown"})`;
		})
		.join("\n");
}

/**
 * Normalise a script deployment entry into structured snake_case fields.
 */
export function formatDeployment(d: ScriptDeployment): FormattedScriptDeployment {
	const cfg = d.deploymentConfig;
	return {
		deployment_id: d.deploymentId ?? null,
		version_number: cfg?.versionNumber ?? null,
		description: cfg?.description ?? null,
		manifest_file_name: cfg?.manifestFileName ?? null,
		update_time: d.updateTime ?? null,
		entry_points: (d.entryPoints ?? []).map((e) => ({
			entry_point_type: e.entryPointType ?? null,
			web_app_url: e.webApp?.url ?? null,
		})),
	};
}

/**
 * Format a list of deployments for human/agent reading.
 */
export function formatDeployments(
	deployments: Array<ScriptDeployment | FormattedScriptDeployment>,
): string {
	if (deployments.length === 0) return "No deployments found.";
	return deployments
		.map((d) => {
			if ("deployment_id" in d) {
				const v = d.version_number ? `v${d.version_number}` : "head";
				const desc = d.description ? ` - ${d.description}` : "";
				const eps = d.entry_points
					?.map((e) => e.entry_point_type)
					.filter(Boolean)
					.join(", ");
				const epStr = eps ? ` [${eps}]` : "";
				return `• [${d.deployment_id}] ${v}${desc}${epStr} (updated ${d.update_time ?? "unknown"})`;
			}
			const cfg = d.deploymentConfig;
			const v = cfg?.versionNumber ? `v${cfg.versionNumber}` : "head";
			const desc = cfg?.description ? ` - ${cfg.description}` : "";
			const eps = d.entryPoints
				?.map((e) => e.entryPointType)
				.filter(Boolean)
				.join(", ");
			const epStr = eps ? ` [${eps}]` : "";
			return `• [${d.deploymentId}] ${v}${desc}${epStr} (updated ${d.updateTime ?? "unknown"})`;
		})
		.join("\n");
}
