import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	OneDriveApiError,
	type OneDriveBatchDeleteFailure,
	type OneDriveBatchDeleteResult,
	type OneDriveConflictBehavior,
	type OneDriveItem,
	type OneDriveItemList,
	type OneDrivePort,
	type OneDriveQuota,
	type OneDriveQuotaState,
} from "../../../ports/onedrive.js";
import {
	createMicrosoftTokenSource,
	type MicrosoftTokenSourceConfig,
} from "../tokenSource.js";

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
export const SIMPLE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH_DELETE_ITEMS = 20;

export const ITEM_SELECT_FIELDS =
	"id,name,size,createdDateTime,lastModifiedDateTime,webUrl,eTag,parentReference,folder,file,deleted";
export const ITEM_DOWNLOAD_SELECT_FIELDS = `${ITEM_SELECT_FIELDS},@microsoft.graph.downloadUrl`;

export interface OneDriveAdapterConfig extends MicrosoftTokenSourceConfig {
	sleepFn?: (ms: number) => Promise<void>;
	maxBatchRetries?: number;
}

function encodeGraphPath(rawPath: string): string {
	return rawPath
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.split("/")
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function parseRetryAfterSeconds(
	rawHeader: string | undefined | null,
	attempt: number,
): number {
	if (rawHeader) {
		const parsed = Number.parseInt(rawHeader, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return Math.min(60, 2 ** attempt);
}

async function parseGraphError(res: Response): Promise<OneDriveApiError> {
	const raw = await res.text().catch(() => "");
	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; message?: string };
		};
		const errObj = parsed.error;
		return new OneDriveApiError(
			errObj?.message ?? (`OneDrive API HTTP ${res.status}: ${raw}` || res.statusText),
			{
				status: res.status,
				code: errObj?.code,
			},
		);
	} catch {
		return new OneDriveApiError(
			`OneDrive API HTTP ${res.status}: ${raw || res.statusText}`,
			{ status: res.status },
		);
	}
}

export function createOneDriveAdapter(
	config: OneDriveAdapterConfig,
): OneDrivePort {
	const fetchFn = config.fetchFn ?? globalThis.fetch;
	const getToken = createMicrosoftTokenSource(config);
	const sleepFn =
		config.sleepFn ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const maxBatchRetries = config.maxBatchRetries ?? 3;

	async function graphRequest<T>(
		pathOrUrl: string,
		init?: RequestInit & { query?: Record<string, string | undefined> },
	): Promise<T> {
		const token = await getToken();
		const url =
			pathOrUrl.startsWith("https://") || pathOrUrl.startsWith("http://")
				? new URL(pathOrUrl)
				: new URL(`${GRAPH_BASE_URL}${pathOrUrl}`);

		for (const [k, v] of Object.entries(init?.query ?? {})) {
			if (v !== undefined) {
				url.searchParams.set(k, v);
			}
		}

		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		if (
			init?.body !== undefined &&
			!(init.body instanceof Uint8Array) &&
			!headers.has("Content-Type")
		) {
			headers.set("Content-Type", "application/json");
		}

		const res = await fetchFn(url.toString(), { ...init, headers });
		if (!res.ok) {
			throw await parseGraphError(res);
		}
		if (res.status === 204) {
			return undefined as T;
		}
		return (await res.json()) as T;
	}

	function resolveParentPrefix(parentId?: string): string {
		if (!parentId || parentId === "root") {
			return "/me/drive/root";
		}
		return `/me/drive/items/${encodeURIComponent(parentId)}`;
	}

	return {
		async getQuota(): Promise<OneDriveQuota> {
			const data = await graphRequest<{
				id?: string;
				driveType?: string;
				owner?: OneDriveQuota["owner"];
				quota?: {
					total?: number;
					used?: number;
					remaining?: number;
					deleted?: number;
					state?: OneDriveQuotaState;
				};
			}>("/me/drive", {
				query: { $select: "id,driveType,owner,quota" },
			});
			const q = data.quota ?? {};
			return {
				id: data.id,
				driveType: data.driveType,
				owner: data.owner,
				total: q.total ?? 0,
				used: q.used ?? 0,
				remaining: q.remaining ?? 0,
				deleted: q.deleted ?? 0,
				state: q.state ?? "normal",
			};
		},

		async listChildren(params) {
			if (params.cursor) {
				const data = await graphRequest<{
					value?: OneDriveItem[];
					"@odata.nextLink"?: string;
				}>(params.cursor);
				return {
					items: data.value ?? [],
					nextCursor: data["@odata.nextLink"],
				};
			}

			let endpoint: string;
			if (params.path) {
				const encoded = encodeGraphPath(params.path);
				endpoint = encoded
					? `/me/drive/root:/${encoded}:/children`
					: "/me/drive/root/children";
			} else if (params.folderId && params.folderId !== "root") {
				endpoint = `/me/drive/items/${encodeURIComponent(params.folderId)}/children`;
			} else {
				endpoint = "/me/drive/root/children";
			}

			const data = await graphRequest<{
				value?: OneDriveItem[];
				"@odata.nextLink"?: string;
			}>(endpoint, {
				query: {
					$top:
						params.pageSize !== undefined ? String(params.pageSize) : undefined,
					$orderby: params.orderBy,
					$select: ITEM_SELECT_FIELDS,
				},
			});

			return {
				items: data.value ?? [],
				nextCursor: data["@odata.nextLink"],
			};
		},

		async searchItems(params): Promise<OneDriveItemList> {
			if (params.cursor) {
				const data = await graphRequest<{
					value?: OneDriveItem[];
					"@odata.nextLink"?: string;
				}>(params.cursor);
				return {
					items: data.value ?? [],
					nextCursor: data["@odata.nextLink"],
				};
			}

			const trimmed = params.query.trim();
			if (!trimmed) {
				throw new Error("OneDrive search query must not be empty.");
			}
			const escaped = trimmed.replace(/'/g, "''");
			const prefix = resolveParentPrefix(params.folderId);
			const endpoint = `${prefix}/search(q='${ encodeURIComponent(escaped) }')`;

			const data = await graphRequest<{
				value?: OneDriveItem[];
				"@odata.nextLink"?: string;
			}>(endpoint, {
				query: {
					$top:
						params.pageSize !== undefined ? String(params.pageSize) : undefined,
					$select: ITEM_SELECT_FIELDS,
				},
			});

			return {
				items: data.value ?? [],
				nextCursor: data["@odata.nextLink"],
			};
		},

		async getItemMetadata(params): Promise<OneDriveItem> {
			let endpoint: string;
			if (params.itemId) {
				endpoint =
					params.itemId === "root"
						? "/me/drive/root"
						: `/me/drive/items/${encodeURIComponent(params.itemId)}`;
			} else if (params.path) {
				const encoded = encodeGraphPath(params.path);
				endpoint = encoded ? `/me/drive/root:/${encoded}` : "/me/drive/root";
			} else {
				throw new Error(
					"getItemMetadata requires either itemId or path to be provided.",
				);
			}

			return graphRequest<OneDriveItem>(endpoint, {
				query: { $select: ITEM_SELECT_FIELDS },
			});
		},

		async downloadItemBytes(params) {
			// Consumer OneDrive Graph v1.0 omits `@microsoft.graph.downloadUrl` when `$select` is passed,
			// so fetch the full item metadata payload without `$select`.
			const item = await graphRequest<OneDriveItem>(
				`/me/drive/items/${encodeURIComponent(params.itemId)}`,
			);

			if (
				params.maxBytes !== undefined &&
				typeof item.size === "number" &&
				item.size > params.maxBytes
			) {
				throw new Error(
					`OneDrive file '${item.name}' (${item.size} bytes) exceeds maxBytes limit (${params.maxBytes} bytes).`,
				);
			}

			const downloadUrl = item["@microsoft.graph.downloadUrl"];
			if (!downloadUrl) {
				throw new Error(
					`OneDrive item '${item.name}' (${item.id}) has no @microsoft.graph.downloadUrl (folders cannot be downloaded as raw bytes).`,
				);
			}

			// Critical: Never forward the Graph Authorization header to the pre-authenticated download URL.
			const downloadRes = await fetchFn(downloadUrl);
			if (!downloadRes.ok) {
				throw await parseGraphError(downloadRes);
			}

			const bytes = new Uint8Array(await downloadRes.arrayBuffer());
			if (params.maxBytes !== undefined && bytes.byteLength > params.maxBytes) {
				throw new Error(
					`Downloaded OneDrive file '${item.name}' (${bytes.byteLength} bytes) exceeds maxBytes limit (${params.maxBytes} bytes).`,
				);
			}

			const mimeType =
				item.file?.mimeType ??
				downloadRes.headers.get("content-type") ??
				"application/octet-stream";

			return { item, bytes, mimeType };
		},

		async createFolder(params): Promise<OneDriveItem> {
			const prefix = resolveParentPrefix(params.parentId);
			const conflictBehavior: OneDriveConflictBehavior =
				params.conflictBehavior ?? "fail";
			return graphRequest<OneDriveItem>(`${prefix}/children`, {
				method: "POST",
				body: JSON.stringify({
					name: params.name,
					folder: {},
					"@microsoft.graph.conflictBehavior": conflictBehavior,
				}),
			});
		},

		async uploadFile(params): Promise<OneDriveItem> {
			const prefix = resolveParentPrefix(params.parentId);
			const encodedName = encodeGraphPath(params.name);
			const conflictBehavior: OneDriveConflictBehavior =
				params.conflictBehavior ?? "fail";

			if (params.data.byteLength <= SIMPLE_UPLOAD_LIMIT_BYTES) {
				return graphRequest<OneDriveItem>(
					`${prefix}:/${encodedName}:/content`,
					{
						method: "PUT",
						headers: {
							"Content-Type": params.mimeType ?? "application/octet-stream",
						},
						body: new Uint8Array(params.data),
						query: {
							"@microsoft.graph.conflictBehavior": conflictBehavior,
						},
					},
				);
			}

			// Resumable upload session for files > 4 MiB
			const session = await graphRequest<{ uploadUrl?: string }>(
				`${prefix}:/${encodedName}:/createUploadSession`,
				{
					method: "POST",
					body: JSON.stringify({
						item: {
							"@microsoft.graph.conflictBehavior": conflictBehavior,
							name: params.name,
						},
					}),
				},
			);

			if (!session.uploadUrl) {
				throw new Error(
					`OneDrive createUploadSession did not return an uploadUrl for '${params.name}'.`,
				);
			}

			const totalBytes = params.data.byteLength;
			let finalItem: OneDriveItem | undefined;

			for (
				let offset = 0;
				offset < totalBytes;
				offset += UPLOAD_CHUNK_SIZE_BYTES
			) {
				const end = Math.min(offset + UPLOAD_CHUNK_SIZE_BYTES, totalBytes);
				const chunk = params.data.subarray(offset, end);

				// Upload session URLs are pre-authenticated; omit the Graph Authorization header.
				const chunkRes = await fetchFn(session.uploadUrl, {
					method: "PUT",
					headers: {
						"Content-Length": String(chunk.byteLength),
						"Content-Range": `bytes ${offset}-${end - 1}/${totalBytes}`,
						"Content-Type": "application/octet-stream",
					},
					body: new Uint8Array(chunk),
				});

				if (!chunkRes.ok) {
					throw await parseGraphError(chunkRes);
				}

				if (chunkRes.status === 200 || chunkRes.status === 201) {
					finalItem = (await chunkRes.json()) as OneDriveItem;
				}
			}

			if (!finalItem) {
				throw new Error(
					`OneDrive upload session completed all byte chunks for '${params.name}', but Graph did not return a created DriveItem.`,
				);
			}
			return finalItem;
		},

		async readLocalFile(localPath: string) {
			const buf = await readFile(localPath);
			return {
				bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
				fileName: basename(localPath),
			};
		},

		async updateItem(params): Promise<OneDriveItem> {
			const payload: Record<string, unknown> = {};
			if (params.name !== undefined) {
				payload.name = params.name;
			}
			if (params.newParentId !== undefined) {
				payload.parentReference = { id: params.newParentId };
			}
			if (params.conflictBehavior !== undefined) {
				payload["@microsoft.graph.conflictBehavior"] = params.conflictBehavior;
			}

			return graphRequest<OneDriveItem>(
				`/me/drive/items/${encodeURIComponent(params.itemId)}`,
				{
					method: "PATCH",
					body: JSON.stringify(payload),
				},
			);
		},

		async deleteItems(params): Promise<OneDriveBatchDeleteResult> {
			const deletedItemIds: string[] = [];
			const failed: OneDriveBatchDeleteFailure[] = [];

			for (
				let i = 0;
				i < params.itemIds.length;
				i += MAX_BATCH_DELETE_ITEMS
			) {
				let pendingIds = params.itemIds.slice(i, i + MAX_BATCH_DELETE_ITEMS);
				let attempt = 1;

				while (pendingIds.length > 0) {
					const requests = pendingIds.map((itemId, idx) => ({
						id: String(idx),
						method: "DELETE" as const,
						url: `/me/drive/items/${encodeURIComponent(itemId)}`,
					}));

					const token = await getToken();
					const res = await fetchFn(`${GRAPH_BASE_URL}/$batch`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ requests }),
					});

					if (
						(res.status === 429 || res.status === 503) &&
						attempt <= maxBatchRetries
					) {
						const waitSeconds = parseRetryAfterSeconds(
							res.headers.get("Retry-After"),
							attempt,
						);
						await sleepFn(waitSeconds * 1000);
						attempt += 1;
						continue;
					}

					if (!res.ok) {
						throw await parseGraphError(res);
					}

					const batchBody = (await res.json()) as {
						responses?: Array<{
							id: string;
							status: number;
							headers?: Record<string, string>;
							body?: { error?: { code?: string; message?: string } };
						}>;
					};

					const byId = new Map(
						(batchBody.responses ?? []).map((r) => [r.id, r]),
					);
					const throttledIds: string[] = [];
					let maxWaitSeconds = 0;

					for (let idx = 0; idx < pendingIds.length; idx += 1) {
						const itemId = pendingIds[idx];
						const sub = byId.get(String(idx));
						if (!sub) {
							failed.push({
								itemId,
								status: 500,
								error: "Missing sub-response from Graph /$batch",
							});
							continue;
						}

						if (sub.status >= 200 && sub.status < 300) {
							deletedItemIds.push(itemId);
							continue;
						}

						if (
							(sub.status === 429 || sub.status === 503) &&
							attempt <= maxBatchRetries
						) {
							throttledIds.push(itemId);
							const retryHeader =
								sub.headers?.["Retry-After"] ?? sub.headers?.["retry-after"];
							const waitSec = parseRetryAfterSeconds(retryHeader, attempt);
							if (waitSec > maxWaitSeconds) {
								maxWaitSeconds = waitSec;
							}
							continue;
						}

						failed.push({
							itemId,
							status: sub.status,
							error: sub.body?.error?.message,
						});
					}

					if (throttledIds.length > 0) {
						await sleepFn(maxWaitSeconds * 1000);
						pendingIds = throttledIds;
						attempt += 1;
					} else {
						pendingIds = [];
					}
				}
			}

			return { deletedItemIds, failed };
		},
	};
}
