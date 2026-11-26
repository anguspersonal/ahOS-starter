import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import { LIST_FIELDS, type DriveFile, type DrivePort } from "../../ports/drive.js";
import type { OneDriveItem, OneDrivePort } from "../../ports/onedrive.js";
import { defineAction } from "../defineAction.js";
import { parseCounterCopyFileName } from "../onedrive/audit.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import {
	KPI_CONFIG_VERSION,
	extractCleanCanonicalFileName,
	isCounterCopyFileName,
	normalizeCanonicalDuplicateFileName,
} from "./weeklyKpiSnapshot.js";

export const DRIVE_HYGIENE_HEAL_LEVERS = [
	"dedup_same_folder",
	"delete_os_junk",
	"rename_orphan_counter_copies",
	"file_root_loose_to_sort",
] as const;

export type DriveHygieneHealLever = (typeof DRIVE_HYGIENE_HEAL_LEVERS)[number];

export const DRIVE_HYGIENE_PROVIDERS = ["onedrive", "gdrive", "both"] as const;
export type DriveHygieneProvider = (typeof DRIVE_HYGIENE_PROVIDERS)[number];

export const DEFAULT_ONEDRIVE_HEAL_PATHS = [
	"root",
	"8.To Sort",
	"1.Projects/Startups/Work (Oct 2025–Present)",
] as const;

export const MIN_ONEDRIVE_FOLDER_PAGES = 5;
export const MAX_ONEDRIVE_FOLDER_PAGES = 100;
export const MIN_GDRIVE_PAGES = 3;
export const MAX_GDRIVE_PAGES = 15;

const SAFE_OS_JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

export const driveHygieneHealInput = {
	provider: z
		.enum(DRIVE_HYGIENE_PROVIDERS)
		.optional()
		.describe(
			"Target cloud storage provider: 'onedrive' (OneDrive Personal), 'gdrive' (Google Drive), or 'both' (default 'both').",
		),
	gdrive_domains: z
		.array(z.enum(DOMAINS))
		.min(1)
		.optional()
		.describe(
			"Google Drive workspace domains to scan when provider includes 'gdrive' (default ['angus']).",
		),
	onedrive_paths: z
		.array(z.string().min(1))
		.min(1)
		.optional()
		.describe(
			"OneDrive folder paths to scan when provider includes 'onedrive' (default ['root', '8.To Sort', '1.Projects/Startups/Work (Oct 2025–Present)']).",
		),
	levers: z
		.array(z.enum(DRIVE_HYGIENE_HEAL_LEVERS))
		.min(1)
		.optional()
		.describe(
			"Band 1 (>=0.99 confidence, zero-HITL) self-healing levers to run. Defaults to all 4: ['dedup_same_folder', 'delete_os_junk', 'rename_orphan_counter_copies', 'file_root_loose_to_sort'].",
		),
	max_actions: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe(
			"Maximum number of Band 1 heal mutations to execute in a single pass (1..500, default 50).",
		),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			"When true (default), computes and returns the exact Band 1 heal plan without mutating OneDrive or Google Drive. Set false to execute.",
		),
};

export const driveHygieneHealSchema = z.object(driveHygieneHealInput);
export type DriveHygieneHealInput = z.infer<typeof driveHygieneHealSchema>;

export interface DriveHygienePlannedOperation {
	lever: DriveHygieneHealLever;
	provider: "onedrive" | "gdrive";
	domain: Domain;
	confidence: number;
	item_id: string;
	item_name: string;
	parent_key: string;
	folder_label: string;
	size_bytes: number;
	hash: string | null;
	canonical_keeper_id?: string;
	canonical_keeper_name?: string;
	target_name?: string;
	target_parent_id?: string;
	target_folder_label?: string;
	status: "planned" | "executed" | "failed" | "skipped_cap";
	error?: string;
}

export interface DriveHygieneHealResult {
	kpi_config_version: string;
	dry_run: boolean;
	provider: DriveHygieneProvider;
	levers: DriveHygieneHealLever[];
	max_actions: number;
	summary: {
		candidates_found: number;
		planned_within_cap: number;
		executed_count: number;
		failed_count: number;
		skipped_cap_count: number;
		reclaimed_bytes: number;
		by_lever: Record<
			DriveHygieneHealLever,
			{
				candidates: number;
				executed: number;
				reclaimed_bytes: number;
			}
		>;
	};
	operations: DriveHygienePlannedOperation[];
	warnings: string[];
	markdown: string;
}

export interface DriveHygieneHealPorts {
	onedrive: OneDrivePort;
	drive: DrivePort;
}

export interface ScannedDriveFile {
	provider: "onedrive" | "gdrive";
	domain: Domain;
	id: string;
	name: string;
	parentKey: string;
	folderLabel: string;
	sizeBytes: number;
	hash: string | null;
	createdAt: string | null;
}

export function isSafeAutoDeleteOsJunk(rawName: string): boolean {
	return SAFE_OS_JUNK_NAMES.has(rawName.trim().toLowerCase());
}

function isCleanCanonicalName(rawName: string): boolean {
	const trimmed = rawName.trim();
	if (isCounterCopyFileName(trimmed)) return false;
	const parsed = parseCounterCopyFileName(trimmed);
	if (parsed && parsed.counter <= 999) return false;
	return true;
}

/**
 * Deterministic comparator to choose the canonical keeper inside a same-folder
 * exact-hash cluster:
 * 1. Prefer clean filename (no `(1)`, `Copy of`, or counter suffix).
 * 2. Prefer earliest `createdAt` timestamp when available.
 * 3. Prefer shortest filename, then lexicographic `id`.
 */
export function selectCanonicalKeeper<
	T extends { id: string; name: string; createdAt?: string | null },
>(members: readonly T[]): { keeper: T; redundant: T[] } {
	const sorted = [...members].sort((a, b) => {
		const aClean = isCleanCanonicalName(a.name) ? 0 : 1;
		const bClean = isCleanCanonicalName(b.name) ? 0 : 1;
		if (aClean !== bClean) return aClean - bClean;

		const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
		const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
		if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
			return aTime - bTime;
		}

		if (a.name.length !== b.name.length) {
			return a.name.length - b.name.length;
		}
		const nameCmp = a.name.localeCompare(b.name);
		if (nameCmp !== 0) return nameCmp;
		return a.id.localeCompare(b.id);
	});

	return {
		keeper: sorted[0]!,
		redundant: sorted.slice(1),
	};
}

/**
 * Pure planner that takes scanned files across OneDrive and/or Google Drive and
 * produces the deterministic Band 1 (`>= 0.99` confidence) self-healing operations.
 */
export function planBand1DriveHygieneOperations(params: {
	files: readonly ScannedDriveFile[];
	levers: readonly DriveHygieneHealLever[];
	oneDriveToSortFolderId?: string | null;
}): DriveHygienePlannedOperation[] {
	const leverSet = new Set<DriveHygieneHealLever>(params.levers);
	const operations: DriveHygienePlannedOperation[] = [];
	const slatedForDeletionIds = new Set<string>();

	// 1. Lever: delete_os_junk (.DS_Store, Thumbs.db, desktop.ini)
	if (leverSet.has("delete_os_junk")) {
		for (const file of params.files) {
			if (isSafeAutoDeleteOsJunk(file.name)) {
				slatedForDeletionIds.add(`${file.provider}:${file.id}`);
				operations.push({
					lever: "delete_os_junk",
					provider: file.provider,
					domain: file.domain,
					confidence: 0.99,
					item_id: file.id,
					item_name: file.name,
					parent_key: file.parentKey,
					folder_label: file.folderLabel,
					size_bytes: file.sizeBytes,
					hash: file.hash,
					status: "planned",
				});
			}
		}
	}

	// 2. Lever: dedup_same_folder (same parentKey + same canonical name + identical hash + size > 0)
	if (leverSet.has("dedup_same_folder")) {
		const groups = new Map<string, ScannedDriveFile[]>();
		for (const file of params.files) {
			if (slatedForDeletionIds.has(`${file.provider}:${file.id}`)) continue;
			const normalizedHash = file.hash?.trim().toLowerCase() || null;
			if (!normalizedHash || file.sizeBytes <= 0) continue;
			const canonicalName = normalizeCanonicalDuplicateFileName(file.name);
			const groupKey = `${file.provider}::${file.domain}::${file.parentKey}::${canonicalName}::${normalizedHash}::${file.sizeBytes}`;
			const bucket = groups.get(groupKey) ?? [];
			bucket.push(file);
			groups.set(groupKey, bucket);
		}

		for (const members of groups.values()) {
			if (members.length < 2) continue;
			const { keeper, redundant } = selectCanonicalKeeper(members);
			for (const clone of redundant) {
				slatedForDeletionIds.add(`${clone.provider}:${clone.id}`);
				operations.push({
					lever: "dedup_same_folder",
					provider: clone.provider,
					domain: clone.domain,
					confidence: 0.99,
					item_id: clone.id,
					item_name: clone.name,
					parent_key: clone.parentKey,
					folder_label: clone.folderLabel,
					size_bytes: clone.sizeBytes,
					hash: clone.hash,
					canonical_keeper_id: keeper.id,
					canonical_keeper_name: keeper.name,
					status: "planned",
				});
			}
		}
	}

	// 3. Lever: rename_orphan_counter_copies (OneDrive Personal files with explicit copy suffix and no canonical sibling)
	if (leverSet.has("rename_orphan_counter_copies")) {
		const survivingNamesByFolder = new Map<string, Set<string>>();
		for (const file of params.files) {
			if (slatedForDeletionIds.has(`${file.provider}:${file.id}`)) continue;
			const folderKey = `${file.provider}::${file.domain}::${file.parentKey}`;
			const set = survivingNamesByFolder.get(folderKey) ?? new Set<string>();
			set.add(file.name.trim().toLowerCase());
			survivingNamesByFolder.set(folderKey, set);
		}

		for (const file of params.files) {
			if (file.provider !== "onedrive") continue;
			if (slatedForDeletionIds.has(`${file.provider}:${file.id}`)) continue;
			const cleanName = extractCleanCanonicalFileName(file.name);
			if (!cleanName) continue;
			const folderKey = `${file.provider}::${file.domain}::${file.parentKey}`;
			const existingNames = survivingNamesByFolder.get(folderKey) ?? new Set<string>();
			const cleanLower = cleanName.toLowerCase();
			if (existingNames.has(cleanLower)) {
				continue;
			}
			// Reserve target name so two orphans in the same folder never collide
			existingNames.add(cleanLower);
			survivingNamesByFolder.set(folderKey, existingNames);

			operations.push({
				lever: "rename_orphan_counter_copies",
				provider: "onedrive",
				domain: file.domain,
				confidence: 0.99,
				item_id: file.id,
				item_name: file.name,
				parent_key: file.parentKey,
				folder_label: file.folderLabel,
				size_bytes: file.sizeBytes,
				hash: file.hash,
				target_name: cleanName,
				status: "planned",
			});
		}
	}

	// 4. Lever: file_root_loose_to_sort (OneDrive loose files at root -> 8.To Sort)
	if (
		leverSet.has("file_root_loose_to_sort") &&
		params.oneDriveToSortFolderId
	) {
		for (const file of params.files) {
			if (file.provider !== "onedrive") continue;
			if (file.folderLabel !== "root") continue;
			if (slatedForDeletionIds.has(`${file.provider}:${file.id}`)) continue;
			operations.push({
				lever: "file_root_loose_to_sort",
				provider: "onedrive",
				domain: file.domain,
				confidence: 0.99,
				item_id: file.id,
				item_name: file.name,
				parent_key: file.parentKey,
				folder_label: file.folderLabel,
				size_bytes: file.sizeBytes,
				hash: file.hash,
				target_parent_id: params.oneDriveToSortFolderId,
				target_folder_label: "8.To Sort",
				status: "planned",
			});
		}
	}

	return operations;
}

function toScannedOneDriveFile(
	item: OneDriveItem,
	folderLabel: string,
): ScannedDriveFile | null {
	if (item.folder && !item.file) return null;
	if (!item.file && item.name.trim().toLowerCase() === "personal vault") return null;
	if (item.name.trim().toLowerCase() === "personal vault") return null;
	const hash =
		item.file?.hashes?.sha256Hash ??
		item.file?.hashes?.sha1Hash ??
		item.file?.hashes?.quickXorHash ??
		null;
	return {
		provider: "onedrive",
		domain: "angus",
		id: item.id,
		name: item.name,
		parentKey: item.parentReference?.id ?? item.parentReference?.path ?? folderLabel,
		folderLabel,
		sizeBytes: item.size ?? 0,
		hash,
		createdAt: item.createdDateTime ?? item.lastModifiedDateTime ?? null,
	};
}

function toScannedGDriveFile(item: DriveFile, domain: Domain): ScannedDriveFile | null {
	if (!item.id || !item.name) return null;
	if (item.mimeType === GOOGLE_FOLDER_MIME) return null;
	if (item.mimeType?.startsWith(GOOGLE_NATIVE_PREFIX)) return null;
	const parsedSize = Number(item.size ?? 0);
	const sizeBytes = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0;
	const parentId = item.parents?.[0] ?? "root";
	return {
		provider: "gdrive",
		domain,
		id: item.id,
		name: item.name,
		parentKey: parentId,
		folderLabel: `gdrive:${domain}:${parentId}`,
		sizeBytes,
		hash: item.sha256Checksum ?? item.md5Checksum ?? null,
		createdAt: item.createdTime ?? item.modifiedTime ?? null,
	};
}

function formatMiB(bytes: number): string {
	return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

export function renderDriveHygieneHealMarkdown(result: Omit<DriveHygieneHealResult, "markdown">): string {
	const modeLabel = result.dry_run ? "DRY-RUN PREVIEW" : "EXECUTED";
	const lines: string[] = [
		`# Drive Hygiene Self-Heal (${modeLabel})`,
		"",
		`- **KPI Config Version**: \`${result.kpi_config_version}\``,
		`- **Provider scope**: \`${result.provider}\``,
		`- **Active Band 1 levers**: ${result.levers.map((l) => `\`${l}\``).join(", ")}`,
		`- **Candidates found**: ${result.summary.candidates_found} (cap: ${result.max_actions}, planned within cap: ${result.summary.planned_within_cap})`,
		`- **Executed**: ${result.summary.executed_count} | **Failed**: ${result.summary.failed_count} | **Deferred by cap**: ${result.summary.skipped_cap_count}`,
		`- **Reclaimed storage**: ${formatMiB(result.summary.reclaimed_bytes)} (${result.summary.reclaimed_bytes} bytes)`,
		"",
		"## Breakdown by Band 1 Lever",
	];

	for (const lever of DRIVE_HYGIENE_HEAL_LEVERS) {
		const stats = result.summary.by_lever[lever];
		lines.push(
			`- \`${lever}\`: ${stats.candidates} candidate(s), ${stats.executed} executed (${formatMiB(stats.reclaimed_bytes)})`,
		);
	}

	if (result.operations.length > 0) {
		lines.push("", "## Operations");
		for (const op of result.operations.slice(0, 50)) {
			const detail =
				op.lever === "dedup_same_folder"
					? `keep \`${op.canonical_keeper_name}\` (${op.canonical_keeper_id}), trash duplicate \`${op.item_name}\``
					: op.lever === "rename_orphan_counter_copies"
						? `rename \`${op.item_name}\` -> \`${op.target_name}\``
						: op.lever === "file_root_loose_to_sort"
							? `move root file \`${op.item_name}\` -> \`${op.target_folder_label}\``
							: `delete OS junk \`${op.item_name}\``;
			lines.push(
				`- **[${op.status.toUpperCase()}]** \`${op.provider}\` (\`${op.folder_label}\`) — \`${op.lever}\`: ${detail}${op.error ? ` — error: ${op.error}` : ""}`,
			);
		}
	}

	if (result.warnings.length > 0) {
		lines.push("", "## Warnings");
		for (const w of result.warnings) {
			lines.push(`- ${w}`);
		}
	}

	return lines.join("\n");
}

export function formatDriveHygieneHealMcp(result: DriveHygieneHealResult): string {
	return result.markdown;
}

/**
 * Creates the `drive_hygiene_heal` Core Action (ADR-115).
 * Executes bounded Band 1 (`>= 0.99` confidence, zero-HITL) self-healing across
 * the 4 constituent metrics of the `cloud_storage_hygiene_pct` composite KPI.
 */
export function createDriveHygieneHealAction(
	ports: DriveHygieneHealPorts,
): ActionDefinition<typeof driveHygieneHealSchema, DriveHygieneHealResult> {
	return defineAction({
		id: "drive_hygiene_heal",
		description:
			"Execute or preview bounded Band 1 (>=0.99 confidence, zero-HITL) Cloud Drive self-healing across OneDrive Personal and Google Drive: (1) same-folder exact-hash duplicate cleanup, (2) OS junk file removal (.DS_Store/Thumbs.db/desktop.ini), (3) orphaned counter-copy canonical rename, and (4) filing loose root files into '8.To Sort'. Defaults to dry_run=true and max_actions=50.",
		domain: "ops",
		schema: driveHygieneHealSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		run: async (
			input: DriveHygieneHealInput,
			_ctx: ActionContext,
		): Promise<DriveHygieneHealResult> => {
			const provider = input.provider ?? "both";
			const gdriveDomains: Domain[] = input.gdrive_domains ?? ["angus"];
			const onedrivePaths: string[] = input.onedrive_paths ?? [
				...DEFAULT_ONEDRIVE_HEAL_PATHS,
			];
			const levers: DriveHygieneHealLever[] = input.levers ?? [
				...DRIVE_HYGIENE_HEAL_LEVERS,
			];
			const maxActions = input.max_actions ?? 50;
			const dryRun = input.dry_run ?? true;
			const warnings: string[] = [];

			const scannedFiles: ScannedDriveFile[] = [];
			const seenFileKeys = new Set<string>();
			let oneDriveToSortFolderId: string | null = null;

			if (provider === "onedrive" || provider === "both") {
				for (const rawPath of onedrivePaths) {
					const normalizedPath = rawPath.trim();
					const isRoot =
						normalizedPath.toLowerCase() === "root" || normalizedPath === "/";
					try {
						const minPages = isRoot ? 1 : MIN_ONEDRIVE_FOLDER_PAGES;
						const maxPages = isRoot ? 1 : MAX_ONEDRIVE_FOLDER_PAGES;
						let cursor: string | undefined;
						for (let page = 0; page < maxPages; page++) {
							const res = await ports.onedrive.listChildren({
								...(isRoot ? {} : { path: normalizedPath }),
								pageSize: 200,
								...(cursor ? { cursor } : {}),
							});
							const items = res.items ?? [];
							if (isRoot && page === 0) {
								const toSortFolder = items.find(
									(i) => Boolean(i.folder) && i.name === "8.To Sort",
								);
								if (toSortFolder) {
									oneDriveToSortFolderId = toSortFolder.id;
								}
							}
							const label = isRoot ? "root" : normalizedPath;
							for (const item of items) {
								const scanned = toScannedOneDriveFile(item, label);
								if (!scanned) continue;
								const key = `onedrive:${scanned.id}`;
								if (seenFileKeys.has(key)) continue;
								seenFileKeys.add(key);
								scannedFiles.push(scanned);
							}
							if (!res.nextCursor) break;
							if (page + 1 >= minPages) {
								const folderFiles = scannedFiles.filter(
									(f) => f.provider === "onedrive" && f.folderLabel === label,
								);
								const plannedForFolder = planBand1DriveHygieneOperations({
									files: folderFiles,
									levers,
									oneDriveToSortFolderId,
								});
								if (plannedForFolder.length >= maxActions) {
									break;
								}
							}
							cursor = res.nextCursor;
						}
					} catch (err) {
						warnings.push(
							`onedrive.listChildren(${normalizedPath}) failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			if (provider === "gdrive" || provider === "both") {
				for (const domain of gdriveDomains) {
					try {
						let pageToken: string | undefined;
						for (let page = 0; page < MAX_GDRIVE_PAGES; page++) {
							const res = await ports.drive.listFiles({
								domain,
								q: "trashed = false",
								pageSize: 1000,
								fields: LIST_FIELDS,
								...(pageToken ? { pageToken } : {}),
							});
							for (const file of res.files ?? []) {
								const scanned = toScannedGDriveFile(file, domain);
								if (!scanned) continue;
								const key = `gdrive:${domain}:${scanned.id}`;
								if (seenFileKeys.has(key)) continue;
								seenFileKeys.add(key);
								scannedFiles.push(scanned);
							}
							if (!res.nextPageToken) break;
							if (page + 1 >= MIN_GDRIVE_PAGES) {
								const domainFiles = scannedFiles.filter(
									(f) => f.provider === "gdrive" && f.domain === domain,
								);
								const plannedForDomain = planBand1DriveHygieneOperations({
									files: domainFiles,
									levers,
									oneDriveToSortFolderId,
								});
								if (plannedForDomain.length >= maxActions) {
									break;
								}
							}
							pageToken = res.nextPageToken;
						}
					} catch (err) {
						warnings.push(
							`drive.listFiles(${domain}) failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			const allPlanned = planBand1DriveHygieneOperations({
				files: scannedFiles,
				levers,
				oneDriveToSortFolderId,
			});

			const withinCap = allPlanned.slice(0, maxActions);
			const beyondCap = allPlanned.slice(maxActions).map((op) => ({
				...op,
				status: "skipped_cap" as const,
			}));

			let executedCount = 0;
			let failedCount = 0;
			let reclaimedBytes = 0;

			if (!dryRun && withinCap.length > 0) {
				// Batch OneDrive deletions together for efficiency
				const oneDriveDeleteOps = withinCap.filter(
					(op) =>
						op.provider === "onedrive" &&
						(op.lever === "dedup_same_folder" || op.lever === "delete_os_junk"),
				);

				if (oneDriveDeleteOps.length > 0) {
					try {
						const delRes = await ports.onedrive.deleteItems({
							itemIds: oneDriveDeleteOps.map((op) => op.item_id),
						});
						const deletedSet = new Set(delRes.deletedItemIds);
						const failedMap = new Map(
							delRes.failed.map((f) => [f.itemId, f.error ?? `HTTP ${f.status}`]),
						);
						for (const op of oneDriveDeleteOps) {
							if (deletedSet.has(op.item_id)) {
								op.status = "executed";
								executedCount++;
								reclaimedBytes += op.size_bytes;
							} else {
								op.status = "failed";
								op.error = failedMap.get(op.item_id) ?? "deleteItems did not confirm deletion";
								failedCount++;
							}
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						warnings.push(`onedrive.deleteItems failed: ${msg}`);
						for (const op of oneDriveDeleteOps) {
							op.status = "failed";
							op.error = msg;
							failedCount++;
						}
					}
				}

				// Execute Google Drive trash operations and OneDrive renames/moves
				for (const op of withinCap) {
					if (
						op.provider === "onedrive" &&
						(op.lever === "dedup_same_folder" || op.lever === "delete_os_junk")
					) {
						continue;
					}

					if (
						op.provider === "gdrive" &&
						(op.lever === "dedup_same_folder" || op.lever === "delete_os_junk")
					) {
						try {
							await ports.drive.trashFile({
								domain: op.domain,
								fileId: op.item_id,
							});
							op.status = "executed";
							executedCount++;
							reclaimedBytes += op.size_bytes;
						} catch (err) {
							op.status = "failed";
							op.error = err instanceof Error ? err.message : String(err);
							failedCount++;
						}
						continue;
					}

					if (op.provider === "onedrive" && op.lever === "rename_orphan_counter_copies") {
						try {
							await ports.onedrive.updateItem({
								itemId: op.item_id,
								name: op.target_name,
								conflictBehavior: "fail",
							});
							op.status = "executed";
							executedCount++;
						} catch (err) {
							op.status = "failed";
							op.error = err instanceof Error ? err.message : String(err);
							failedCount++;
						}
						continue;
					}

					if (op.provider === "onedrive" && op.lever === "file_root_loose_to_sort") {
						try {
							await ports.onedrive.updateItem({
								itemId: op.item_id,
								newParentId: op.target_parent_id,
								conflictBehavior: "rename",
							});
							op.status = "executed";
							executedCount++;
						} catch (err) {
							op.status = "failed";
							op.error = err instanceof Error ? err.message : String(err);
							failedCount++;
						}
					}
				}
			} else if (dryRun) {
				for (const op of withinCap) {
					if (op.lever === "dedup_same_folder" || op.lever === "delete_os_junk") {
						reclaimedBytes += op.size_bytes;
					}
				}
			}

			const allOperations = [...withinCap, ...beyondCap];
			const byLever: DriveHygieneHealResult["summary"]["by_lever"] = {
				dedup_same_folder: { candidates: 0, executed: 0, reclaimed_bytes: 0 },
				delete_os_junk: { candidates: 0, executed: 0, reclaimed_bytes: 0 },
				rename_orphan_counter_copies: { candidates: 0, executed: 0, reclaimed_bytes: 0 },
				file_root_loose_to_sort: { candidates: 0, executed: 0, reclaimed_bytes: 0 },
			};

			for (const op of allOperations) {
				const bucket = byLever[op.lever];
				bucket.candidates++;
				if (op.status === "executed") {
					bucket.executed++;
					if (op.lever === "dedup_same_folder" || op.lever === "delete_os_junk") {
						bucket.reclaimed_bytes += op.size_bytes;
					}
				} else if (dryRun && op.status === "planned") {
					if (op.lever === "dedup_same_folder" || op.lever === "delete_os_junk") {
						bucket.reclaimed_bytes += op.size_bytes;
					}
				}
			}

			const baseResult: Omit<DriveHygieneHealResult, "markdown"> = {
				kpi_config_version: KPI_CONFIG_VERSION,
				dry_run: dryRun,
				provider,
				levers,
				max_actions: maxActions,
				summary: {
					candidates_found: allPlanned.length,
					planned_within_cap: withinCap.length,
					executed_count: executedCount,
					failed_count: failedCount,
					skipped_cap_count: beyondCap.length,
					reclaimed_bytes: reclaimedBytes,
					by_lever: byLever,
				},
				operations: allOperations,
				warnings,
			};

			return {
				...baseResult,
				markdown: renderDriveHygieneHealMarkdown(baseResult),
			};
		},
		formatMcp: formatDriveHygieneHealMcp,
	});
}
