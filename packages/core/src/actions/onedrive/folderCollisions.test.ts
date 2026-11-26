import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { DrivePort } from "../../ports/drive.js";
import type { OneDrivePort } from "../../ports/onedrive.js";
import {
	buildGDriveFolderNodesFromInventory,
	classifyFolderCollisions,
	createDriveFolderCollisionAuditAction,
	extractCanonicalFolderStem,
	normalizeFolderCollisionKey,
	sumNonOverlappingFolderBytes,
	walkGDriveFolders,
	walkOneDriveFolders,
	type DriveFolderNode,
} from "./folderCollisions.js";

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("folderCollisions stem normalization", () => {
	it("normalizes whitespace and case in normalizeFolderCollisionKey", () => {
		expect(normalizeFolderCollisionKey("  1.Projects  ")).toBe("1.projects");
		expect(normalizeFolderCollisionKey("Archived   Areas")).toBe(
			"archived areas",
		);
	});

	it("extracts canonical stems across PARA prefixes, archive qualifiers, and copy counters", () => {
		expect(extractCanonicalFolderStem("1.Projects")).toBe("projects");
		expect(extractCanonicalFolderStem("2. Areas")).toBe("areas");
		expect(extractCanonicalFolderStem("8.To Sort")).toBe("to sort");
		expect(extractCanonicalFolderStem("To Sort")).toBe("to sort");
		expect(extractCanonicalFolderStem("00Archived Projects")).toBe("projects");
		expect(extractCanonicalFolderStem("archived projects")).toBe("projects");
		expect(extractCanonicalFolderStem("Archived Areas")).toBe("areas");
		expect(extractCanonicalFolderStem("icloud(1)")).toBe("icloud");
		expect(extractCanonicalFolderStem("Documents - Copy (2)")).toBe(
			"documents",
		);
		// Single-word "4.Archive" strips "4." to "archive" and does not collapse to empty
		expect(extractCanonicalFolderStem("4.Archive")).toBe("archive");
	});
});

describe("sumNonOverlappingFolderBytes", () => {
	it("excludes descendant shadow folders when an ancestor shadow folder is already counted", () => {
		const folders: DriveFolderNode[] = [
			{
				id: "p1",
				name: "Projects",
				path: "4.Archive/Projects",
				parent_path: "4.Archive",
				top_pillar: "4.Archive",
				depth: 2,
				size_bytes: 5000,
				child_count: 3,
			},
			{
				id: "p2",
				name: "1.Projects",
				path: "4.Archive/Projects/1.Projects",
				parent_path: "4.Archive/Projects",
				top_pillar: "4.Archive",
				depth: 3,
				size_bytes: 2000,
				child_count: 1,
			},
			{
				id: "p3",
				name: "archived projects",
				path: "4.Archive/00Archived Projects/archived projects",
				parent_path: "4.Archive/00Archived Projects",
				top_pillar: "4.Archive",
				depth: 3,
				size_bytes: 1500,
				child_count: 2,
			},
		];

		expect(sumNonOverlappingFolderBytes(folders)).toBe(6500);
	});
});

describe("classifyFolderCollisions", () => {
	const sampleTree: DriveFolderNode[] = [
		// Depth 1 roots
		{
			id: "r-projects",
			name: "1.Projects",
			path: "1.Projects",
			parent_path: "",
			top_pillar: "1.Projects",
			depth: 1,
			size_bytes: 10_000,
			child_count: 4,
		},
		{
			id: "r-areas",
			name: "2.Areas",
			path: "2.Areas",
			parent_path: "",
			top_pillar: "2.Areas",
			depth: 1,
			size_bytes: 20_000,
			child_count: 3,
		},
		{
			id: "r-archive",
			name: "4.Archive",
			path: "4.Archive",
			parent_path: "",
			top_pillar: "4.Archive",
			depth: 1,
			size_bytes: 50_000,
			child_count: 5,
		},
		{
			id: "r-people",
			name: "6.People",
			path: "6.People",
			parent_path: "",
			top_pillar: "6.People",
			depth: 1,
			size_bytes: 5_000,
			child_count: 2,
		},
		{
			id: "r-tosort",
			name: "8.To Sort",
			path: "8.To Sort",
			parent_path: "",
			top_pillar: "8.To Sort",
			depth: 1,
			size_bytes: 500_000,
			child_count: 14,
		},
		// Root-shadowed: "Projects" re-nested under 4.Archive at depth 2 and depth 3
		{
			id: "s-projects-d2",
			name: "Projects",
			path: "4.Archive/Projects",
			parent_path: "4.Archive",
			top_pillar: "4.Archive",
			depth: 2,
			size_bytes: 4_000,
			child_count: 1,
		},
		{
			id: "s-projects-d3",
			name: "1.Projects",
			path: "4.Archive/Projects/1.Projects",
			parent_path: "4.Archive/Projects",
			top_pillar: "4.Archive",
			depth: 3,
			size_bytes: 0,
			child_count: 0,
		},
		// Root-shadowed: "To Sort" re-nested under 4.Archive at depth 2
		{
			id: "s-tosort-d2",
			name: "To Sort",
			path: "4.Archive/To Sort",
			parent_path: "4.Archive",
			top_pillar: "4.Archive",
			depth: 2,
			size_bytes: 30_000,
			child_count: 4,
		},
		// Multi-depth branch collision: "Career" at depth 2 and depth 3 inside 4.Archive
		{
			id: "m-career-d2",
			name: "Career",
			path: "4.Archive/Career",
			parent_path: "4.Archive",
			top_pillar: "4.Archive",
			depth: 2,
			size_bytes: 1_000,
			child_count: 2,
		},
		{
			id: "m-career-d3",
			name: "Career",
			path: "4.Archive/Archived Areas/Career",
			parent_path: "4.Archive/Archived Areas",
			top_pillar: "4.Archive",
			depth: 3,
			size_bytes: 0,
			child_count: 0,
		},
		// Cross-pillar horizontal category sprawl: "Personal" at depth 2 across 1.Projects, 2.Areas, 6.People
		{
			id: "h-personal-1",
			name: "Personal",
			path: "1.Projects/Personal",
			parent_path: "1.Projects",
			top_pillar: "1.Projects",
			depth: 2,
			size_bytes: 2_000,
			child_count: 2,
		},
		{
			id: "h-personal-2",
			name: "Personal",
			path: "2.Areas/Personal",
			parent_path: "2.Areas",
			top_pillar: "2.Areas",
			depth: 2,
			size_bytes: 3_000,
			child_count: 1,
		},
		{
			id: "h-personal-3",
			name: "Personal",
			path: "6.People/Personal",
			parent_path: "6.People",
			top_pillar: "6.People",
			depth: 2,
			size_bytes: 1_500,
			child_count: 1,
		},
	];

	it("classifies root_shadowed, multi_depth_branch, and cross_pillar_horizontal clusters and computes KPIs", () => {
		const { summary, clusters } = classifyFolderCollisions(sampleTree, {
			provider: "onedrive",
			domain: "angus",
			truncated: false,
			max_depth_scanned: 3,
			match_mode: "canonical_stem",
		});

		expect(summary.sampled_folder_count).toBe(13);
		expect(summary.root_shadowed_cluster_count).toBe(2); // "projects" and "to sort"
		expect(summary.multi_depth_cluster_count).toBe(1); // "career"
		expect(summary.structural_collision_cluster_count).toBe(3);
		expect(summary.cross_pillar_cluster_count).toBe(1); // "personal"
		expect(summary.collision_cluster_count).toBe(4);

		// Shadowed root folders: 2 under "projects" (d2 + d3) + 1 under "to sort" (d2) = 3
		expect(summary.shadowed_root_folder_count).toBe(3);
		// Structural duplicate folders: 3 root_shadowed + 1 multi_depth_branch ("Career" at d3) = 4
		expect(summary.structural_duplicate_folder_count).toBe(4);
		// Empty shadow folders (child_count === 0): s-projects-d3 and m-career-d3 = 2
		expect(summary.empty_shadow_folder_count).toBe(2);
		// Non-overlapping shadow bytes: 4_000 (4.Archive/Projects covers d3) + 30_000 (4.Archive/To Sort) + 0 (Career d3) = 34_000
		expect(summary.shadowed_folder_bytes).toBe(34_000);
		// Cleanliness: (13 - 4) / 13 * 100 = 69.2%
		expect(summary.structural_cleanliness_pct).toBe(69.2);

		const projectsCluster = clusters.find(
			(c) => c.canonical_stem === "projects",
		);
		expect(projectsCluster?.collision_kind).toBe("root_shadowed");
		expect(projectsCluster?.primary_folder.path).toBe("1.Projects");
		expect(projectsCluster?.shadow_folder_count).toBe(2);

		const personalCluster = clusters.find(
			(c) => c.canonical_stem === "personal",
		);
		expect(personalCluster?.collision_kind).toBe("cross_pillar_horizontal");
		expect(personalCluster?.shadow_folder_count).toBe(0);
	});
});

describe("walkOneDriveFolders", () => {
	it("records excluded depth-1 folders like 8.To Sort without expanding their children", async () => {
		const listChildren = vi.fn().mockImplementation(async ({ path }) => {
			if (!path) {
				return {
					items: [
						{
							id: "od-tosort",
							name: "8.To Sort",
							size: 500_000,
							folder: { childCount: 14 },
						},
						{
							id: "od-archive",
							name: "4.Archive",
							size: 50_000,
							folder: { childCount: 2 },
						},
					],
				};
			}
			if (path === "4.Archive") {
				return {
					items: [
						{
							id: "od-archive-tosort",
							name: "To Sort",
							size: 10_000,
							folder: { childCount: 0 },
						},
					],
				};
			}
			return { items: [] };
		});

		const onedrive = { listChildren } as unknown as OneDrivePort;
		const walk = await walkOneDriveFolders(onedrive, {
			maxDepth: 3,
			excludePaths: ["8.To Sort"],
		});

		expect(walk.folders.map((f) => f.path)).toEqual([
			"8.To Sort",
			"4.Archive",
			"4.Archive/To Sort",
		]);
		// Ensure 8.To Sort was never expanded via listChildren
		expect(listChildren).not.toHaveBeenCalledWith(
			expect.objectContaining({ path: "8.To Sort" }),
		);

		const { summary } = classifyFolderCollisions(walk.folders, {
			provider: "onedrive",
			domain: "angus",
			truncated: walk.truncated,
			max_depth_scanned: walk.max_depth_scanned,
		});
		expect(summary.shadowed_root_folder_count).toBe(1);
		expect(summary.empty_shadow_folder_count).toBe(1);
	});
});

describe("buildGDriveFolderNodesFromInventory and createDriveFolderCollisionAuditAction", () => {
	it("reconstructs Google Drive folder hierarchy and runs drive_folder_collision_audit for both providers", async () => {
		const gdriveFiles = [
			{
				id: "gd-root-proj",
				name: "1.Projects",
				mimeType: "application/vnd.google-apps.folder",
				parents: ["root-drive-id"],
			},
			{
				id: "gd-root-arch",
				name: "4.Archive",
				mimeType: "application/vnd.google-apps.folder",
				parents: ["root-drive-id"],
			},
			{
				id: "gd-nested-proj",
				name: "Projects",
				mimeType: "application/vnd.google-apps.folder",
				parents: ["gd-root-arch"],
			},
			{
				id: "gd-doc-1",
				name: "Spec",
				mimeType: "application/vnd.google-apps.document",
				parents: ["gd-nested-proj"],
			},
		];
		const gdriveRootFiles = [gdriveFiles[0], gdriveFiles[1]];

		const built = buildGDriveFolderNodesFromInventory(
			"angus",
			gdriveFiles,
			gdriveRootFiles,
			{ maxDepth: 4 },
		);

		expect(built.folders.map((f) => f.path)).toEqual([
			"1.Projects",
			"4.Archive",
			"4.Archive/Projects",
		]);
		const nestedProj = built.folders.find(
			(f) => f.path === "4.Archive/Projects",
		);
		expect(nestedProj?.child_count).toBe(1);

		const onedrive: OneDrivePort = {
			getQuota: vi.fn(),
			listChildren: vi.fn().mockImplementation(async ({ path }) => {
				if (!path) {
					return {
						items: [
							{
								id: "od-1",
								name: "1.Projects",
								size: 1000,
								folder: { childCount: 1 },
							},
						],
					};
				}
				return { items: [] };
			}),
			getItemMetadata: vi.fn(),
			searchItems: vi.fn(),
			readFile: vi.fn(),
			createFolder: vi.fn(),
			uploadFile: vi.fn(),
			moveItem: vi.fn(),
			renameItem: vi.fn(),
			deleteItem: vi.fn(),
		};

		const drive: DrivePort = {
			listFiles: vi.fn().mockImplementation(async ({ q }) => {
				if (String(q).includes("'root' in parents")) {
					return { files: gdriveRootFiles };
				}
				return { files: gdriveFiles };
			}),
		} as unknown as DrivePort;

		const action = createDriveFolderCollisionAuditAction({ onedrive, drive });
		const res = await executeAction(
			action,
			{ provider: "both", domain: "angus", max_depth: 3 },
			{
				context: { userId: TEST_USER_ID, caller: "test" },
				auditSink: () => {},
			},
		);

		expect(res.onedrive?.sampled_folder_count).toBe(1);
		expect(res.onedrive?.shadowed_root_folder_count).toBe(0);
		expect(res.gdrive?.sampled_folder_count).toBe(3);
		expect(res.gdrive?.shadowed_root_folder_count).toBe(1);
		expect(res.report_markdown).toContain("Drive Folder-Collision Audit");
		expect(res.report_markdown).toContain("4.Archive/Projects");
	});
});
