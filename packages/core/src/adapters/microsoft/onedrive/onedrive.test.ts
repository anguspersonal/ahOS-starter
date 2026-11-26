import { describe, expect, it, vi } from "vitest";
import type { OneDriveApiError } from "../../../ports/onedrive.js";
import {
	createMicrosoftTokenSource,
	MICROSOFT_ONEDRIVE_SCOPES,
	MICROSOFT_TOKEN_URL,
} from "../tokenSource.js";
import {
	createOneDriveAdapter,
	ITEM_SELECT_FIELDS,
	SIMPLE_UPLOAD_LIMIT_BYTES,
	UPLOAD_CHUNK_SIZE_BYTES,
} from "./index.js";

describe("createMicrosoftTokenSource (#2043)", () => {
	it("caches access_token before expiry and rotates refresh_token on re-fetch after expiry", async () => {
		let nowMs = 1_000_000;
		const tokenBodies: string[] = [];
		let callCount = 0;

		const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(String(input)).toBe(MICROSOFT_TOKEN_URL);
			expect(init?.method).toBe("POST");
			tokenBodies.push(String(init?.body ?? ""));
			callCount += 1;
			return new Response(
				JSON.stringify({
					access_token: `at-${callCount}`,
					refresh_token: `rt-rotated-${callCount}`,
					expires_in: 3600,
					scope: MICROSOFT_ONEDRIVE_SCOPES.join(" "),
				}),
				{ status: 200 },
			);
		});

		const getToken = createMicrosoftTokenSource({
			clientId: "ms-client-id",
			clientSecret: "ms-client-secret",
			refreshToken: () => "rt-initial",
			fetchFn,
			nowFn: () => nowMs,
		});

		const first = await getToken();
		nowMs += 60_000; // +1 min, well before 3600s expiry
		const second = await getToken();

		expect(first).toBe("at-1");
		expect(second).toBe("at-1");
		expect(fetchFn).toHaveBeenCalledTimes(1);

		const firstParams = new URLSearchParams(tokenBodies[0]);
		expect(firstParams.get("client_id")).toBe("ms-client-id");
		expect(firstParams.get("client_secret")).toBe("ms-client-secret");
		expect(firstParams.get("refresh_token")).toBe("rt-initial");
		expect(firstParams.get("grant_type")).toBe("refresh_token");
		expect(firstParams.get("scope")).toBe("Files.ReadWrite offline_access User.Read");

		// Advance past 3600s expiry window
		nowMs += 3_600_000;
		const third = await getToken();
		expect(third).toBe("at-2");
		expect(fetchFn).toHaveBeenCalledTimes(2);

		const secondParams = new URLSearchParams(tokenBodies[1]);
		expect(secondParams.get("refresh_token")).toBe("rt-rotated-1");
	});

	it("throws a clear error when refreshToken is missing or token exchange fails", async () => {
		const missingSource = createMicrosoftTokenSource({
			clientId: "ms-client-id",
			refreshToken: () => null,
			fetchFn: vi.fn(),
		});
		await expect(missingSource()).rejects.toThrow(/Missing Microsoft OAuth refresh token/);

		const failingSource = createMicrosoftTokenSource({
			clientId: "ms-client-id",
			refreshToken: () => "rt-bad",
			fetchFn: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "invalid_grant",
							error_description: "Refresh token has expired",
						}),
						{ status: 400 },
					),
			),
		});
		await expect(failingSource()).rejects.toThrow(
			/Microsoft OAuth token refresh failed \(400\): invalid_grant Refresh token has expired/,
		);
	});
});

function makeAdapter(
	handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
	opts?: { sleepFn?: (ms: number) => Promise<void> },
) {
	return createOneDriveAdapter({
		clientId: "ms-cid",
		clientSecret: "ms-csecret",
		refreshToken: () => "rt-personal",
		sleepFn: opts?.sleepFn,
		fetchFn: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === MICROSOFT_TOKEN_URL) {
				return new Response(
					JSON.stringify({
						access_token: "at-graph",
						refresh_token: "rt-personal-2",
						expires_in: 3600,
					}),
					{ status: 200 },
				);
			}
			return handler(url, init);
		}),
	});
}

describe("createOneDriveAdapter (#2043)", () => {
	it("getQuota queries /v1.0/me/drive and maps quota fields", async () => {
		let capturedUrl: URL | undefined;
		let capturedAuth: string | null = null;
		const adapter = makeAdapter((url, init) => {
			capturedUrl = url;
			capturedAuth = new Headers(init?.headers).get("Authorization");
			return new Response(
				JSON.stringify({
					id: "drive-123",
					driveType: "personal",
					owner: { user: { id: "u-1", displayName: "Angus Hally" } },
					quota: {
						total: 1099511627776,
						used: 900000000000,
						remaining: 199511627776,
						deleted: 52428800,
						state: "normal",
					},
				}),
				{ status: 200 },
			);
		});

		const quota = await adapter.getQuota();
		expect(capturedUrl?.pathname).toBe("/v1.0/me/drive");
		expect(capturedUrl?.searchParams.get("$select")).toBe("id,driveType,owner,quota");
		expect(capturedAuth).toBe("Bearer at-graph");
		expect(quota).toEqual({
			id: "drive-123",
			driveType: "personal",
			owner: { user: { id: "u-1", displayName: "Angus Hally" } },
			total: 1099511627776,
			used: 900000000000,
			remaining: 199511627776,
			deleted: 52428800,
			state: "normal",
		});
	});

	it("listChildren supports root, folderId, path, and @odata.nextLink cursor pagination", async () => {
		const seenUrls: URL[] = [];
		const adapter = makeAdapter((url) => {
			seenUrls.push(url);
			return new Response(
				JSON.stringify({
					value: [{ id: "item-1", name: "Backups", folder: { childCount: 3 } }],
					"@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc",
				}),
				{ status: 200 },
			);
		});

		const page1 = await adapter.listChildren({
			path: "/8.To Sort/Sub folder",
			pageSize: 50,
			orderBy: "name asc",
		});
		expect(page1).toEqual({
			items: [{ id: "item-1", name: "Backups", folder: { childCount: 3 } }],
			nextCursor: "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc",
		});
		expect(seenUrls[0].pathname).toBe("/v1.0/me/drive/root:/8.To%20Sort/Sub%20folder:/children");
		expect(seenUrls[0].searchParams.get("$top")).toBe("50");
		expect(seenUrls[0].searchParams.get("$orderby")).toBe("name asc");
		expect(seenUrls[0].searchParams.get("$select")).toBe(ITEM_SELECT_FIELDS);

		await adapter.listChildren({
			cursor: "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc",
		});
		expect(seenUrls[1].href).toBe(
			"https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc",
		);
	});

	it("searchItems queries /me/drive/root/search(q='...') and escapes single quotes", async () => {
		let capturedUrl: URL | undefined;
		const adapter = makeAdapter((url) => {
			capturedUrl = url;
			return new Response(
				JSON.stringify({
					value: [{ id: "file-9", name: "Angus's Tax.pdf", size: 1024 }],
				}),
				{ status: 200 },
			);
		});

		const res = await adapter.searchItems({ query: "Angus's Tax", pageSize: 25 });
		expect(res.items).toHaveLength(1);
		expect(decodeURIComponent(capturedUrl?.pathname ?? "")).toBe(
			"/v1.0/me/drive/root/search(q='Angus''s Tax')",
		);
		expect(capturedUrl?.searchParams.get("$top")).toBe("25");
	});

	it("downloadItemBytes fetches @microsoft.graph.downloadUrl WITHOUT Authorization header", async () => {
		const calls: Array<{ url: URL; auth: string | null }> = [];
		const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

		const adapter = makeAdapter((url, init) => {
			calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
			if (url.hostname === "graph.microsoft.com") {
				return new Response(
					JSON.stringify({
						id: "item-dl",
						name: "photo.jpg",
						size: payload.byteLength,
						file: { mimeType: "image/jpeg", hashes: { sha256Hash: "AABBCC" } },
						"@microsoft.graph.downloadUrl":
							"https://my.microsoftpersonalcontent.com/personal/download?tempauth=xyz",
					}),
					{ status: 200 },
				);
			}
			return new Response(payload, {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		});

		const result = await adapter.downloadItemBytes({ itemId: "item-dl" });
		expect(result.item.id).toBe("item-dl");
		expect(result.mimeType).toBe("image/jpeg");
		expect(Array.from(result.bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);

		expect(calls).toHaveLength(2);
		expect(calls[0].url.hostname).toBe("graph.microsoft.com");
		expect(calls[0].url.searchParams.get("$select")).toBeNull();
		expect(calls[0].auth).toBe("Bearer at-graph");
		// Critical: @microsoft.graph.downloadUrl MUST NOT receive an Authorization header
		expect(calls[1].url.hostname).toBe("my.microsoftpersonalcontent.com");
		expect(calls[1].auth).toBeNull();
	});

	it("uploadFile uses simple PUT /content for payloads <= 4 MiB", async () => {
		let capturedUrl: URL | undefined;
		let capturedInit: RequestInit | undefined;
		const smallBytes = new Uint8Array([1, 2, 3, 4, 5]);

		const adapter = makeAdapter((url, init) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({
					id: "uploaded-small",
					name: "notes.txt",
					size: smallBytes.byteLength,
				}),
				{ status: 201 },
			);
		});

		const uploaded = await adapter.uploadFile({
			name: "notes.txt",
			parentId: "folder-42",
			mimeType: "text/plain",
			data: smallBytes,
			conflictBehavior: "rename",
		});

		expect(uploaded.id).toBe("uploaded-small");
		expect(capturedInit?.method).toBe("PUT");
		expect(capturedUrl?.pathname).toBe("/v1.0/me/drive/items/folder-42:/notes.txt:/content");
		expect(capturedUrl?.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("rename");
		expect(new Headers(capturedInit?.headers).get("Authorization")).toBe("Bearer at-graph");
	});

	it("uploadFile uses createUploadSession and 5 MiB chunked PUTs without Authorization for payloads > 4 MiB", async () => {
		const totalSize = SIMPLE_UPLOAD_LIMIT_BYTES + 1_500_000; // ~5.5 MiB -> 2 chunks (5 MiB + ~0.5 MiB)
		const largeBytes = new Uint8Array(totalSize);
		largeBytes[0] = 0x11;
		largeBytes[UPLOAD_CHUNK_SIZE_BYTES] = 0x22;
		largeBytes[totalSize - 1] = 0x33;

		const calls: Array<{
			url: URL;
			method: string;
			auth: string | null;
			contentRange: string | null;
			bodyLength: number;
		}> = [];

		const adapter = makeAdapter((url, init) => {
			const headers = new Headers(init?.headers);
			const bodyBytes =
				init?.body instanceof Uint8Array
					? init.body.byteLength
					: typeof init?.body === "string"
						? init.body.length
						: 0;
			calls.push({
				url,
				method: init?.method ?? "GET",
				auth: headers.get("Authorization"),
				contentRange: headers.get("Content-Range"),
				bodyLength: bodyBytes,
			});

			if (url.pathname.endsWith(":/createUploadSession")) {
				return new Response(
					JSON.stringify({
						uploadUrl: "https://sn3302.up.1drv.com/up/session-123",
					}),
					{ status: 200 },
				);
			}

			// First chunk returns 202 Accepted, final chunk returns 201 Created with DriveItem
			const range = headers.get("Content-Range") ?? "";
			if (range.startsWith("bytes 0-")) {
				return new Response(
					JSON.stringify({ nextExpectedRanges: [`${UPLOAD_CHUNK_SIZE_BYTES}-`] }),
					{ status: 202 },
				);
			}
			return new Response(
				JSON.stringify({
					id: "uploaded-large",
					name: "archive.zip",
					size: totalSize,
				}),
				{ status: 201 },
			);
		});

		const item = await adapter.uploadFile({
			name: "archive.zip",
			parentId: "root",
			data: largeBytes,
			conflictBehavior: "replace",
		});

		expect(item.id).toBe("uploaded-large");
		expect(calls).toHaveLength(3);

		// 1. createUploadSession
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url.pathname).toBe(
			"/v1.0/me/drive/root:/archive.zip:/createUploadSession",
		);
		expect(calls[0].auth).toBe("Bearer at-graph");

		// 2. Chunk 1 (0 .. 5 MiB - 1)
		expect(calls[1].method).toBe("PUT");
		expect(calls[1].url.href).toBe("https://sn3302.up.1drv.com/up/session-123");
		expect(calls[1].auth).toBeNull();
		expect(calls[1].contentRange).toBe(
			`bytes 0-${UPLOAD_CHUNK_SIZE_BYTES - 1}/${totalSize}`,
		);
		expect(calls[1].bodyLength).toBe(UPLOAD_CHUNK_SIZE_BYTES);

		// 3. Chunk 2 (5 MiB .. totalSize - 1)
		expect(calls[2].method).toBe("PUT");
		expect(calls[2].auth).toBeNull();
		expect(calls[2].contentRange).toBe(
			`bytes ${UPLOAD_CHUNK_SIZE_BYTES}-${totalSize - 1}/${totalSize}`,
		);
		expect(calls[2].bodyLength).toBe(totalSize - UPLOAD_CHUNK_SIZE_BYTES);
	});

	it("createFolder and updateItem send expected Graph payloads", async () => {
		const requests: Array<{ url: URL; method: string; body: unknown }> = [];
		const adapter = makeAdapter((url, init) => {
			requests.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return new Response(
				JSON.stringify({ id: "item-mutated", name: "Updated" }),
				{ status: 200 },
			);
		});

		await adapter.createFolder({
			name: "2026 Archive",
			parentId: "parent-1",
			conflictBehavior: "fail",
		});
		expect(requests[0].method).toBe("POST");
		expect(requests[0].url.pathname).toBe("/v1.0/me/drive/items/parent-1/children");
		expect(requests[0].body).toEqual({
			name: "2026 Archive",
			folder: {},
			"@microsoft.graph.conflictBehavior": "fail",
		});

		await adapter.updateItem({
			itemId: "item-mutated",
			name: "Renamed Archive",
			newParentId: "parent-2",
			conflictBehavior: "rename",
		});
		expect(requests[1].method).toBe("PATCH");
		expect(requests[1].url.pathname).toBe("/v1.0/me/drive/items/item-mutated");
		expect(requests[1].body).toEqual({
			name: "Renamed Archive",
			parentReference: { id: "parent-2" },
			"@microsoft.graph.conflictBehavior": "rename",
		});
	});

	it("deleteItems batches up to 20 items per /$batch call and retries 429 throttled sub-requests using Retry-After", async () => {
		const itemIds = Array.from({ length: 25 }, (_, i) => `item-${i + 1}`);
		const batchPayloads: Array<{ requests: Array<{ id: string; method: string; url: string }> }> =
			[];
		const sleepCalls: number[] = [];

		let firstBatchAttempt = 0;
		const adapter = makeAdapter(
			(url, init) => {
				expect(url.pathname).toBe("/v1.0/$batch");
				const parsed = JSON.parse(String(init?.body)) as {
					requests: Array<{ id: string; method: string; url: string }>;
				};
				batchPayloads.push(parsed);

				// First batch of 20: simulate item-3 being throttled with 429 Retry-After: 4 on attempt 1
				if (parsed.requests.length === 20) {
					firstBatchAttempt += 1;
					return new Response(
						JSON.stringify({
							responses: parsed.requests.map((req) => {
								if (firstBatchAttempt === 1 && req.url.endsWith("/item-3")) {
									return {
										id: req.id,
										status: 429,
										headers: { "Retry-After": "4" },
										body: { error: { code: "activityLimitReached", message: "Throttled" } },
									};
								}
								return { id: req.id, status: 204 };
							}),
						}),
						{ status: 200 },
					);
				}

				// Retry of item-3 (length 1) or second batch of 5 items
				return new Response(
					JSON.stringify({
						responses: parsed.requests.map((req) => ({
							id: req.id,
							status: 204,
						})),
					}),
					{ status: 200 },
				);
			},
			{
				sleepFn: async (ms) => {
					sleepCalls.push(ms);
				},
			},
		);

		const result = await adapter.deleteItems({ itemIds });

		expect(result.failed).toEqual([]);
		expect(result.deletedItemIds).toHaveLength(25);
		expect(new Set(result.deletedItemIds)).toEqual(new Set(itemIds));

		// 3 $batch calls: 20 items -> 1 throttled retry -> 5 remaining items
		expect(batchPayloads).toHaveLength(3);
		expect(batchPayloads[0].requests).toHaveLength(20);
		expect(batchPayloads[1].requests).toEqual([
			{ id: "0", method: "DELETE", url: "/me/drive/items/item-3" },
		]);
		expect(batchPayloads[2].requests).toHaveLength(5);
		expect(sleepCalls).toEqual([4000]);
	});

	it("throws OneDriveApiError with status and Graph code on non-2xx responses", async () => {
		const adapter = makeAdapter(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "itemNotFound", message: "The resource could not be found." },
					}),
					{ status: 404 },
				),
		);

		await expect(adapter.getItemMetadata({ itemId: "missing-id" })).rejects.toMatchObject({
			name: "OneDriveApiError",
			status: 404,
			code: "itemNotFound",
		} satisfies Partial<OneDriveApiError>);
	});
});
