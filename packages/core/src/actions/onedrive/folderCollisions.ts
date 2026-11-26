/**
 * Recursive Cross-Depth Folder-Collision Detector & Structural Hygiene KPIs
 * (issue #2093, ADR-115 Recommended Capability Anatomy, ADR-119).
 *
 * Detects cross-depth folder collisions across OneDrive Personal and Google Drive
 * (`angus` and `work`), classifying collision clusters into:
 *   1. `root_shadowed`: a depth-1 root folder (`1.Projects`, `2.Areas`, `8.To Sort`,
 *      `Documents`, `Videos`, `Attachments`, `tools`) re-appears nested at depth >= 2
 *      (for example `4.Archive/Projects/1.Projects` or `4.Archive/To Sort`).
 *   2. `multi_depth_branch`: a non-root folder name appears at multiple depths or is
 *      duplicated within the same top-level pillar branch (for example `4.Archive/Career`
 *      and `4.Archive/Archived Areas/Career`).
 *   3. `cross_pillar_horizontal`: a category folder name is repeated at the same depth
 *      across multiple top-level pillars (for example `1.Projects/Personal`,
 *      `2.Areas/Personal`, `6.People/Personal`).
 *
 * Strictly isomorphic (`@ahkms/core`): zero `node:*` imports.
 */

import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import {
	FILE_FIELDS,
	isFolder as isGDriveFolder,
	type DriveFile,
	type DrivePort,
} from "../../ports/drive.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";

export const FOLDER_COLLISION_KINDS = [
	"root_shadowed",
	"multi_depth_branch",
	"cross_pillar_horizontal",
] as const;

export type FolderCollisionKind = (typeof FOLDER_COLLISION_KINDS)[number];

export const FOLDER_COLLISION_MATCH_MODES = [
	"canonical_stem",
	"exact_name",
] as const;

export type FolderCollisionMatchMode =
	(typeof FOLDER_COLLISION_MATCH_MODES)[number];

export const FOLDER_COLLISION_PROVIDERS = [
	"onedrive",
	"gdrive",
	"both",
] as const;

export type FolderCollisionProvider =
	(typeof FOLDER_COLLISION_PROVIDERS)[number];

/**
 * Default paths whose children are not expanded during recursive OneDrive folder walks
 * because they are flat file dumps (e.g. `8.To Sort` has ~140k loose files).
 * The folder itself is still recorded at depth 1 so shadows like `4.Archive/To Sort`
 * are detected against it.
 */
export const DEFAULT_ONEDRIVE_COLLISION_EXCLUDE_PATHS: readonly string[] = [
	"8.To Sort",
];

export interface DriveFolderNode {
	provider: "onedrive" | "gdrive";
	domain: Domain;
	id: string;
	name: string;
	normalized_name: string;
	canonical_stem: string;
	path: string;
	depth: number;
	top_pillar: string;
	size_bytes: number;
	child_count: number | null;
	modified_time: string | null;
	web_url: string | null;
}

export interface FolderCollisionCluster {
	key: string;
	canonical_stem: string;
	collision_kind: FolderCollisionKind;
	folder_count: number;
	shadow_folder_count: number;
	empty_shadow_count: number;
	depths: number[];
	min_depth: number;
	max_depth: number;
	depth_span: number;
	pillars: string[];
	total_bytes: number;
	shadow_bytes: number;
	primary_folder: DriveFolderNode;
	shadow_folders: DriveFolderNode[];
	folders: DriveFolderNode[];
}

export interface FolderHygieneSummary {
	provider: "onedrive" | "gdrive";
	domain: Domain;
	sampled_folder_count: number;
	truncated: boolean;
	max_depth_scanned: number;
	collision_cluster_count: number;
	root_shadowed_cluster_count: number;
	multi_depth_cluster_count: number;
	structural_collision_cluster_count: number;
	cross_pillar_cluster_count: number;
	/** Primary KPI (Target: 0): count of depth >= 2 folders that shadow a depth-1 root folder. */
	shadowed_root_folder_count: number;
	/** Total redundant folders in `root_shadowed` and `multi_depth_branch` clusters. */
	structural_duplicate_folder_count: number;
	/** Duplicate folders with `child_count === 0` ready for immediate zero-risk cleanup. */
	empty_shadow_folder_count: number;
	/** Non-overlapping bytes held inside `root_shadowed` and `multi_depth_branch` shadow folders. */
	shadowed_folder_bytes: number;
	/** Secondary KPI (Target >= 98%): `(sampled - structural_duplicates) / sampled * 100`. */
	structural_cleanliness_pct: number;
	top_collisions: FolderCollisionCluster[];
}

export interface FolderTreeWalkResult {
	provider: "onedrive" | "gdrive";
	domain: Domain;
	folders: DriveFolderNode[];
	truncated: boolean;
	max_depth_scanned: number;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * Normalize a folder name by trimming, collapsing internal whitespace, and lowercasing.
 */
export function normalizeFolderCollisionKey(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Extract a canonical folder stem for structural collision detection:
 * - Lowercases and collapses whitespace.
 * - Strips trailing copy counters such as `(1)`, `(2)`, or `- Copy`.
 * - Strips leading PARA numeric prefixes such as `1.`, `2. `, `8.`, or `00`.
 * - Strips leading `archived ` / `archive ` / `backup - ` qualifiers when a
 *   non-empty stem remains (so `1.Projects`, `Projects`, `00Archived Projects`,
 *   and `archived projects` all map to `"projects"`).
 */
export function extractCanonicalFolderStem(name: string): string {
	const base = normalizeFolderCollisionKey(name);
	if (!base) return "";

	let stem = base
		.replace(/\s*\(\d+\)\s*$/, "")
		.replace(/\s+-\s+copy(?:\s*\(\d+\))?$/i, "")
		.trim();

	// Strip leading PARA numbering like "1.Projects", "2. Areas", "00Archived Projects"
	stem = stem
		.replace(/^\d+\s*[._-]\s*/, "")
		.replace(/^00+\s*/, "")
		.trim();

	// Strip leading archive/backup prefixes only if a meaningful target stem follows
	const qualifierMatch = stem.match(
		/^(?:archived|archive|backups|backup)(?:\s*[-_:]\s*|\s+)(.+)$/i,
	);
	if (qualifierMatch && qualifierMatch[1].trim().length >= 2) {
		stem = qualifierMatch[1].trim();
	}

	return stem.length > 0 ? stem : base;
}

function isDescendantPath(childPath: string, ancestorPath: string): boolean {
	const normChild = childPath.replace(/^\/+|\/+$/g, "").toLowerCase();
	const normAncestor = ancestorPath.replace(/^\/+|\/+$/g, "").toLowerCase();
	if (!normChild || !normAncestor || normChild === normAncestor) return false;
	return normChild.startsWith(`${normAncestor}/`);
}

/**
 * Sum `size_bytes` across a set of folders while excluding descendants of another folder
 * in the same set so nested folder sizes are never double-counted.
 */
export function sumNonOverlappingFolderBytes(
	folders: readonly DriveFolderNode[],
): number {
	const sorted = [...folders].sort((a, b) => a.depth - b.depth);
	const acceptedPaths: string[] = [];
	let total = 0;

	for (const folder of sorted) {
		const overlapped = acceptedPaths.some((ancestor) =>
			isDescendantPath(folder.path, ancestor),
		);
		if (!overlapped) {
			acceptedPaths.push(folder.path);
			total += Math.max(0, folder.size_bytes);
		}
	}
	return total;
}

const KIND_SEVERITY_ORDER: Record<FolderCollisionKind, number> = {
	root_shadowed: 0,
	multi_depth_branch: 1,
	cross_pillar_horizontal: 2,
};

/**
 * Classify a flat list of discovered `DriveFolderNode`s into sorted collision clusters
 * and compute the `FolderHygieneSummary` KPI rollup.
 */
export function classifyFolderCollisions(
	folders: readonly DriveFolderNode[],
	opts: {
		provider: "onedrive" | "gdrive";
		domain: Domain;
		truncated?: boolean;
		max_depth_scanned?: number;
		match_mode?: FolderCollisionMatchMode;
		max_clusters?: number;
	},
): {
	summary: FolderHygieneSummary;
	clusters: FolderCollisionCluster[];
} {
	const matchMode = opts.match_mode ?? "canonical_stem";
	const groups = new Map<string, DriveFolderNode[]>();

	for (const folder of folders) {
		const normalizedName =
			folder.normalized_name || normalizeFolderCollisionKey(folder.name);
		const canonicalStem =
			folder.canonical_stem || extractCanonicalFolderStem(folder.name);
		const enrichedFolder: DriveFolderNode =
			folder.normalized_name && folder.canonical_stem
				? folder
				: {
						...folder,
						normalized_name: normalizedName,
						canonical_stem: canonicalStem,
					};
		const key =
			matchMode === "exact_name" ? normalizedName : canonicalStem;
		if (!key) continue;
		const bucket = groups.get(key);
		if (bucket) {
			bucket.push(enrichedFolder);
		} else {
			groups.set(key, [enrichedFolder]);
		}
	}

	const clusters: FolderCollisionCluster[] = [];

	for (const [key, members] of groups.entries()) {
		if (members.length < 2) continue;

		const sortedMembers = [...members].sort((a, b) => {
			if (a.depth !== b.depth) return a.depth - b.depth;
			return a.path.localeCompare(b.path);
		});

		const depths = Array.from(
			new Set(sortedMembers.map((m) => m.depth)),
		).sort((a, b) => a - b);
		const minDepth = depths[0];
		const maxDepth = depths[depths.length - 1];
		const pillars = Array.from(
			new Set(sortedMembers.map((m) => m.top_pillar)),
		).sort();

		let collisionKind: FolderCollisionKind;
		if (minDepth === 1 && maxDepth >= 2) {
			collisionKind = "root_shadowed";
		} else if (depths.length > 1 || pillars.length === 1) {
			collisionKind = "multi_depth_branch";
		} else {
			collisionKind = "cross_pillar_horizontal";
		}

		const primaryFolder = sortedMembers[0];
		const shadowFolders =
			collisionKind === "cross_pillar_horizontal"
				? []
				: sortedMembers.slice(1);
		const emptyShadowCount = shadowFolders.filter(
			(f) => f.child_count === 0,
		).length;

		clusters.push({
			key,
			canonical_stem: sortedMembers[0].canonical_stem,
			collision_kind: collisionKind,
			folder_count: sortedMembers.length,
			shadow_folder_count: shadowFolders.length,
			empty_shadow_count: emptyShadowCount,
			depths,
			min_depth: minDepth,
			max_depth: maxDepth,
			depth_span: maxDepth - minDepth,
			pillars,
			total_bytes: sumNonOverlappingFolderBytes(sortedMembers),
			shadow_bytes: sumNonOverlappingFolderBytes(shadowFolders),
			primary_folder: primaryFolder,
			shadow_folders: shadowFolders,
			folders: sortedMembers,
		});
	}

	clusters.sort((a, b) => {
		const sevDiff =
			KIND_SEVERITY_ORDER[a.collision_kind] -
			KIND_SEVERITY_ORDER[b.collision_kind];
		if (sevDiff !== 0) return sevDiff;
		if (b.shadow_folder_count !== a.shadow_folder_count) {
			return b.shadow_folder_count - a.shadow_folder_count;
		}
		if (b.shadow_bytes !== a.shadow_bytes) {
			return b.shadow_bytes - a.shadow_bytes;
		}
		return a.key.localeCompare(b.key);
	});

	const rootShadowedClusters = clusters.filter(
		(c) => c.collision_kind === "root_shadowed",
	);
	const multiDepthClusters = clusters.filter(
		(c) => c.collision_kind === "multi_depth_branch",
	);
	const crossPillarClusters = clusters.filter(
		(c) => c.collision_kind === "cross_pillar_horizontal",
	);

	const shadowedRootFolderCount = rootShadowedClusters.reduce(
		(acc, c) => acc + c.shadow_folder_count,
		0,
	);
	const structuralDuplicateFolderCount =
		shadowedRootFolderCount +
		multiDepthClusters.reduce((acc, c) => acc + c.shadow_folder_count, 0);
	const emptyShadowFolderCount = clusters.reduce(
		(acc, c) => acc + c.empty_shadow_count,
		0,
	);

	const allStructuralShadowFolders = [
		...rootShadowedClusters.flatMap((c) => c.shadow_folders),
		...multiDepthClusters.flatMap((c) => c.shadow_folders),
	];
	const shadowedFolderBytes = sumNonOverlappingFolderBytes(
		allStructuralShadowFolders,
	);

	const sampledFolderCount = folders.length;
	const structuralCleanlinessPct =
		sampledFolderCount > 0
			? round1(
					(Math.max(0, sampledFolderCount - structuralDuplicateFolderCount) /
						sampledFolderCount) *
						100,
				)
			: 100;

	const maxDepthScanned =
		opts.max_depth_scanned ??
		folders.reduce((max, f) => Math.max(max, f.depth), 0);

	const maxClusters = opts.max_clusters ?? 25;
	const topCollisions = clusters.slice(0, maxClusters);

	const summary: FolderHygieneSummary = {
		provider: opts.provider,
		domain: opts.domain,
		sampled_folder_count: sampledFolderCount,
		truncated: opts.truncated ?? false,
		max_depth_scanned: maxDepthScanned,
		collision_cluster_count: clusters.length,
		root_shadowed_cluster_count: rootShadowedClusters.length,
		multi_depth_cluster_count: multiDepthClusters.length,
		structural_collision_cluster_count:
			rootShadowedClusters.length + multiDepthClusters.length,
		cross_pillar_cluster_count: crossPillarClusters.length,
		shadowed_root_folder_count: shadowedRootFolderCount,
		structural_duplicate_folder_count: structuralDuplicateFolderCount,
		empty_shadow_folder_count: emptyShadowFolderCount,
		shadowed_folder_bytes: shadowedFolderBytes,
		structural_cleanliness_pct: structuralCleanlinessPct,
		top_collisions: topCollisions,
	};

	return { summary, clusters };
}

function isExcludedPath(
	candidatePath: string,
	excludePaths: readonly string[],
): boolean {
	const normCandidate = candidatePath
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	for (const raw of excludePaths) {
		const normExclude = raw.replace(/^\/+|\/+$/g, "").toLowerCase();
		if (
			normExclude.length > 0 &&
			(normCandidate === normExclude ||
				normCandidate.startsWith(`${normExclude}/`))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Walk a OneDrive folder tree breadth-first up to `maxDepth` and `maxFolders`.
 * Records every discovered folder node, and skips expanding children of paths in
 * `excludePaths` (defaulting to `["8.To Sort"]`).
 */
export async function walkOneDriveFolders(
	onedrive: OneDrivePort,
	opts: {
		rootPath?: string;
		maxDepth?: number;
		maxFolders?: number;
		excludePaths?: readonly string[];
		seedRootItems?: readonly OneDriveItem[];
	} = {},
): Promise<FolderTreeWalkResult> {
	const maxDepth = opts.maxDepth ?? 4;
	const maxFolders = opts.maxFolders ?? 400;
	const excludePaths =
		opts.excludePaths ?? DEFAULT_ONEDRIVE_COLLISION_EXCLUDE_PATHS;
	const cleanRoot = opts.rootPath
		? opts.rootPath.replace(/^\/+|\/+$/g, "")
		: "";

	const folders: DriveFolderNode[] = [];
	let truncated = false;
	let maxDepthScanned = 0;

	interface QueueEntry {
		folderId?: string;
		path: string;
		depth: number;
		seedItems?: readonly OneDriveItem[];
	}

	const queue: QueueEntry[] = [
		{
			path: cleanRoot,
			depth: 0,
			seedItems: !cleanRoot ? opts.seedRootItems : undefined,
		},
	];

	while (queue.length > 0 && folders.length < maxFolders) {
		const current = queue.shift()!;
		let cursor: string | undefined;
		let usedSeed = false;

		do {
			const page =
				current.seedItems && !usedSeed
					? ((usedSeed = true),
						{ items: [...current.seedItems], nextCursor: undefined })
					: await onedrive.listChildren({
							...(current.folderId ? { folderId: current.folderId } : {}),
							...(current.path ? { path: current.path } : {}),
							pageSize: 200,
							cursor,
						});

			for (const item of page.items) {
				if (!item.folder) continue;
				const childPath = current.path
					? `${current.path}/${item.name}`
					: item.name;
				const childDepth = current.depth + 1;
				const topPillar = childPath.split("/")[0] || item.name;

				const node: DriveFolderNode = {
					provider: "onedrive",
					domain: "angus",
					id: item.id,
					name: item.name,
					normalized_name: normalizeFolderCollisionKey(item.name),
					canonical_stem: extractCanonicalFolderStem(item.name),
					path: childPath,
					depth: childDepth,
					top_pillar: topPillar,
					size_bytes: typeof item.size === "number" ? item.size : 0,
					child_count:
						typeof item.folder.childCount === "number"
							? item.folder.childCount
							: null,
					modified_time: item.lastModifiedDateTime ?? null,
					web_url: item.webUrl ?? null,
				};

				folders.push(node);
				if (childDepth > maxDepthScanned) {
					maxDepthScanned = childDepth;
				}

				if (
					childDepth < maxDepth &&
					(item.folder.childCount === undefined || item.folder.childCount > 0) &&
					!isExcludedPath(childPath, excludePaths)
				) {
					queue.push({
						folderId: item.id,
						path: childPath,
						depth: childDepth,
					});
				}

				if (folders.length >= maxFolders) {
					truncated = true;
					break;
				}
			}

			cursor = page.nextCursor;
		} while (cursor && folders.length < maxFolders);
	}

	if (queue.length > 0 && folders.length >= maxFolders) {
		truncated = true;
	}

	return {
		provider: "onedrive",
		domain: "angus",
		folders,
		truncated,
		max_depth_scanned: maxDepthScanned,
	};
}

/**
 * Reconstruct `DriveFolderNode`s from in-memory Google Drive file/folder lists.
 * Shared by `walkGDriveFolders` and `weekly_kpi_snapshot`.
 */
export function buildGDriveFolderNodesFromInventory(
	domain: Domain,
	allFiles: readonly DriveFile[],
	rootFiles: readonly DriveFile[],
	opts: {
		maxDepth?: number;
		maxFolders?: number;
		excludePaths?: readonly string[];
		truncated?: boolean;
	} = {},
): FolderTreeWalkResult {
	const maxDepth = opts.maxDepth ?? 4;
	const maxFolders = opts.maxFolders ?? 400;
	const excludePaths = opts.excludePaths ?? [];

	const rootFolderIds = new Set<string>();
	const rawById = new Map<string, DriveFile>();
	let truncated = opts.truncated ?? false;

	for (const f of rootFiles) {
		if (f.id && f.name && isGDriveFolder(f.mimeType)) {
			rootFolderIds.add(f.id);
			rawById.set(f.id, f);
		}
	}

	for (const f of allFiles) {
		if (!f.id || !f.name || !isGDriveFolder(f.mimeType)) continue;
		if (!rawById.has(f.id)) {
			if (rawById.size >= maxFolders) {
				truncated = true;
				break;
			}
			rawById.set(f.id, f);
		}
	}

	const childCountByParent = new Map<string, number>();
	for (const f of allFiles) {
		const parentId = f.parents?.[0];
		if (parentId) {
			childCountByParent.set(
				parentId,
				(childCountByParent.get(parentId) ?? 0) + 1,
			);
		}
	}

	const folders: DriveFolderNode[] = [];
	let maxDepthScanned = 0;

	for (const f of rawById.values()) {
		if (!f.id || !f.name) continue;

		const segments: string[] = [f.name];
		const visited = new Set<string>([f.id]);
		let current: DriveFile | undefined = f;
		let reachedRoot = rootFolderIds.has(f.id);

		while (!reachedRoot && current?.parents?.[0]) {
			const parentId = current.parents[0];
			if (visited.has(parentId)) break;
			visited.add(parentId);

			const parentFile = rawById.get(parentId);
			if (!parentFile || !parentFile.name) {
				break;
			}
			segments.unshift(parentFile.name);
			if (rootFolderIds.has(parentId)) {
				reachedRoot = true;
				break;
			}
			current = parentFile;
		}

		if (rootFolderIds.size > 0 && !reachedRoot) continue;

		const depth = segments.length;
		if (depth > maxDepth) continue;

		const folderPath = segments.join("/");
		if (isExcludedPath(folderPath, excludePaths)) continue;

		const topPillar = segments[0] || f.name;
		if (depth > maxDepthScanned) {
			maxDepthScanned = depth;
		}

		folders.push({
			provider: "gdrive",
			domain,
			id: f.id,
			name: f.name,
			normalized_name: normalizeFolderCollisionKey(f.name),
			canonical_stem: extractCanonicalFolderStem(f.name),
			path: folderPath,
			depth,
			top_pillar: topPillar,
			size_bytes: f.size ? Number(f.size) || 0 : 0,
			child_count: childCountByParent.get(f.id) ?? 0,
			modified_time: f.modifiedTime ?? null,
			web_url: f.webViewLink ?? null,
		});
	}

	return {
		provider: "gdrive",
		domain,
		folders,
		truncated,
		max_depth_scanned: maxDepthScanned,
	};
}

/**
 * Walk a Google Drive folder tree up to `maxDepth` and `maxFolders` by querying
 * root folders and all non-trashed folders in bulk and reconstructing parent chains
 * in memory (avoiding N+1 API calls).
 */
export async function walkGDriveFolders(
	drive: DrivePort,
	opts: {
		domain: Domain;
		maxDepth?: number;
		maxFolders?: number;
		excludePaths?: readonly string[];
	},
): Promise<FolderTreeWalkResult> {
	const maxDepth = opts.maxDepth ?? 4;
	const maxFolders = opts.maxFolders ?? 400;
	const excludePaths = opts.excludePaths ?? [];

	const rootResp = await drive.listFiles({
		domain: opts.domain,
		q: "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
		pageSize: 200,
		fields: `nextPageToken, files(${FILE_FIELDS})`,
	});

	const allFolders: DriveFile[] = [];
	let pageToken: string | undefined;
	let truncated = false;

	do {
		const pageSize = Math.min(
			200,
			Math.max(1, maxFolders - allFolders.length + 50),
		);
		const resp = await drive.listFiles({
			domain: opts.domain,
			q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
			pageSize,
			pageToken,
			fields: `nextPageToken, files(${FILE_FIELDS})`,
		});

		for (const f of resp.files ?? []) {
			allFolders.push(f);
			if (allFolders.length >= maxFolders) {
				truncated = Boolean(resp.nextPageToken);
				break;
			}
		}

		pageToken = resp.nextPageToken ?? undefined;
		if (allFolders.length >= maxFolders && pageToken) {
			truncated = true;
			break;
		}
	} while (pageToken && allFolders.length < maxFolders);

	return buildGDriveFolderNodesFromInventory(
		opts.domain,
		allFolders,
		rootResp.files ?? [],
		{
			maxDepth,
			maxFolders,
			excludePaths,
			truncated,
		},
	);
}

export const DriveFolderCollisionAuditInputSchema = z.object({
	provider: z
		.enum(FOLDER_COLLISION_PROVIDERS)
		.default("onedrive")
		.describe(
			"Cloud drive provider to audit: 'onedrive' (OneDrive Personal), 'gdrive' (Google Drive), or 'both' (default 'onedrive').",
		),
	domain: z
		.enum(DOMAINS)
		.default("angus")
		.describe(
			"Google Drive workspace domain when provider is 'gdrive' or 'both' ('angus' or 'work'; default 'angus').",
		),
	root_path: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional OneDrive subfolder path relative to root to scope the scan (for example '4.Archive'). Defaults to root.",
		),
	max_depth: z
		.number()
		.int()
		.min(2)
		.max(8)
		.default(4)
		.describe("Maximum folder nesting depth to scan (2..8, default 4)."),
	max_folders: z
		.number()
		.int()
		.min(10)
		.max(2000)
		.default(400)
		.describe(
			"Maximum number of folders to inspect per provider (10..2000, default 400).",
		),
	match_mode: z
		.enum(FOLDER_COLLISION_MATCH_MODES)
		.default("canonical_stem")
		.describe(
			"Matching strategy: 'canonical_stem' strips PARA prefixes ('1.Projects', '00Archived Projects') and copy counters ('(1)'); 'exact_name' matches case-insensitive folder names only.",
		),
	exclude_paths: z
		.array(z.string().min(1))
		.optional()
		.describe(
			"Folder paths whose children should not be expanded during OneDrive recursion (defaults to ['8.To Sort'] to avoid paging flat file dumps while still matching '8.To Sort' at depth 1).",
		),
	max_clusters: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(25)
		.describe(
			"Maximum number of collision clusters to return per provider (1..100, default 25).",
		),
});

export type DriveFolderCollisionAuditInput = z.infer<
	typeof DriveFolderCollisionAuditInputSchema
>;

export interface DriveFolderCollisionAuditResult {
	provider: FolderCollisionProvider;
	match_mode: FolderCollisionMatchMode;
	max_depth: number;
	max_folders: number;
	onedrive?: FolderHygieneSummary;
	gdrive?: FolderHygieneSummary;
	report_markdown: string;
}

function formatBytesShort(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const gib = bytes / 1024 ** 3;
	if (gib >= 1) return `${gib.toFixed(2)} GiB`;
	const mib = bytes / 1024 ** 2;
	if (mib >= 1) return `${mib.toFixed(1)} MiB`;
	const kib = bytes / 1024;
	if (kib >= 1) return `${kib.toFixed(1)} KiB`;
	return `${bytes} B`;
}

function formatSummaryBlock(label: string, s: FolderHygieneSummary): string {
	const lines: string[] = [
		`### ${label}`,
		`- Sampled folders: ${s.sampled_folder_count}${s.truncated ? " (truncated)" : ""} (max depth ${s.max_depth_scanned})`,
		`- KPI · Shadowed Root Folders: ${s.shadowed_root_folder_count} (target: 0)`,
		`- KPI · Structural Cleanliness: ${s.structural_cleanliness_pct}% (target: >= 98%)`,
		`- Collision clusters: ${s.collision_cluster_count} total (${s.root_shadowed_cluster_count} root_shadowed, ${s.multi_depth_cluster_count} multi_depth_branch, ${s.cross_pillar_cluster_count} cross_pillar_horizontal)`,
		`- Structural duplicate folders: ${s.structural_duplicate_folder_count} (${s.empty_shadow_folder_count} empty shadow folders, ${formatBytesShort(s.shadowed_folder_bytes)} shadowed payload)`,
	];

	if (s.top_collisions.length > 0) {
		lines.push("", "Top collision clusters:");
		for (const c of s.top_collisions.slice(0, 10)) {
			const paths = c.folders
				.map(
					(f) =>
						`/${f.path} (d${f.depth}${f.child_count !== null ? `, ${f.child_count} items` : ""})`,
				)
				.join(" vs ");
			lines.push(
				`- [${c.collision_kind}] "${c.canonical_stem}" (${c.folder_count} folders, ${c.shadow_folder_count} shadow, ${formatBytesShort(c.shadow_bytes)}): ${paths}`,
			);
		}
	}
	return lines.join("\n");
}

export function renderDriveFolderCollisionAuditMarkdown(input: {
	match_mode: FolderCollisionMatchMode;
	max_depth: number;
	onedrive?: FolderHygieneSummary;
	gdrive?: FolderHygieneSummary;
}): string {
	const sections: string[] = [
		`## Drive Folder-Collision Audit (match_mode=${input.match_mode}, max_depth=${input.max_depth})`,
	];
	if (input.onedrive) {
		sections.push(
			"",
			formatSummaryBlock("OneDrive Personal (angus)", input.onedrive),
		);
	}
	if (input.gdrive) {
		sections.push(
			"",
			formatSummaryBlock(
				`Google Drive (${input.gdrive.domain})`,
				input.gdrive,
			),
		);
	}
	return sections.join("\n");
}

/**
 * Create the `drive_folder_collision_audit` Core Action backed by `OneDrivePort` and `DrivePort`.
 */
export function createDriveFolderCollisionAuditAction(ports: {
	onedrive: OneDrivePort;
	drive: DrivePort;
}): ActionDefinition<
	typeof DriveFolderCollisionAuditInputSchema,
	DriveFolderCollisionAuditResult
> {
	return defineAction({
		id: "drive_folder_collision_audit",
		name: "drive_folder_collision_audit",
		description:
			"Recursively scan OneDrive Personal and/or Google Drive folder trees to detect cross-depth folder name collisions (root_shadowed PARA/root folders re-nested deeper in the tree, multi_depth_branch duplicates, and cross_pillar_horizontal category sprawl) and compute structural folder hygiene KPIs.",
		domain: "integrations",
		schema: DriveFolderCollisionAuditInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(
			input: DriveFolderCollisionAuditInput,
			_context: ActionContext,
		): Promise<DriveFolderCollisionAuditResult> {
			const provider = input.provider ?? "onedrive";
			const domain = input.domain ?? "angus";
			const maxDepth = input.max_depth ?? 4;
			const maxFolders = input.max_folders ?? 400;
			const matchMode = input.match_mode ?? "canonical_stem";
			const maxClusters = input.max_clusters ?? 25;
			const excludePaths =
				input.exclude_paths ?? DEFAULT_ONEDRIVE_COLLISION_EXCLUDE_PATHS;

			let onedriveSummary: FolderHygieneSummary | undefined;
			let gdriveSummary: FolderHygieneSummary | undefined;

			if (provider === "onedrive" || provider === "both") {
				const walk = await walkOneDriveFolders(ports.onedrive, {
					rootPath: input.root_path,
					maxDepth,
					maxFolders,
					excludePaths,
				});
				onedriveSummary = classifyFolderCollisions(walk.folders, {
					provider: "onedrive",
					domain: "angus",
					truncated: walk.truncated,
					max_depth_scanned: walk.max_depth_scanned,
					match_mode: matchMode,
					max_clusters: maxClusters,
				}).summary;
			}

			if (provider === "gdrive" || provider === "both") {
				const walk = await walkGDriveFolders(ports.drive, {
					domain,
					maxDepth,
					maxFolders,
					excludePaths: input.exclude_paths ?? [],
				});
				gdriveSummary = classifyFolderCollisions(walk.folders, {
					provider: "gdrive",
					domain,
					truncated: walk.truncated,
					max_depth_scanned: walk.max_depth_scanned,
					match_mode: matchMode,
					max_clusters: maxClusters,
				}).summary;
			}

			const report_markdown = renderDriveFolderCollisionAuditMarkdown({
				match_mode: matchMode,
				max_depth: maxDepth,
				onedrive: onedriveSummary,
				gdrive: gdriveSummary,
			});

			return {
				provider,
				match_mode: matchMode,
				max_depth: maxDepth,
				max_folders: maxFolders,
				...(onedriveSummary ? { onedrive: onedriveSummary } : {}),
				...(gdriveSummary ? { gdrive: gdriveSummary } : {}),
				report_markdown,
			};
		},
	});
}
