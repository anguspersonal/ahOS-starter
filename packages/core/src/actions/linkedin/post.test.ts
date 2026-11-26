import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore, type ApprovalRequest } from "../gate.js";
import { createLinkedinPostAction } from "./post.js";
import type { LinkedinPort } from "../../ports/linkedin.js";

function makeMockPort(overrides: Partial<LinkedinPort> = {}): LinkedinPort {
	return {
		createPost: vi.fn().mockResolvedValue({ postUrn: "urn:li:share:987654321" }),
		uploadImage: vi.fn().mockResolvedValue({ imageUrn: "urn:li:image:D4E10AQF12345" }),
		resolveAuthor: vi.fn().mockResolvedValue("urn:li:person:resolved123"),
		...overrides,
	};
}

function makeMockSupabase(options: {
	row?: { config?: Record<string, unknown>; enabled?: boolean; routing?: string } | null;
	selectError?: { message: string } | null;
	updateThrows?: boolean;
}) {
	const updateEqProvider = options.updateThrows
		? vi.fn().mockRejectedValue(new Error("DB write failed"))
		: vi.fn().mockResolvedValue({ error: null });
	const updateEqUser = vi.fn().mockReturnValue({ eq: updateEqProvider });
	const updateFn = vi.fn().mockReturnValue({ eq: updateEqUser });

	const maybeSingle = vi.fn().mockResolvedValue({
		data: options.row ?? null,
		error: options.selectError ?? null,
	});
	const selectEqProvider = vi.fn().mockReturnValue({ maybeSingle });
	const selectEqUser = vi.fn().mockReturnValue({ eq: selectEqProvider });
	const selectFn = vi.fn().mockReturnValue({ eq: selectEqUser });

	return {
		client: {
			from: vi.fn().mockReturnValue({
				select: selectFn,
				update: updateFn,
			}),
		},
		updateFn,
	};
}

describe("linkedin_post action", () => {
	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("preserves the exact MCP contract (id, JSON Schema, annotations, needsApproval, and updated description)", () => {
		const port = makeMockPort();
		const { client } = makeMockSupabase({ row: null });
		const action = createLinkedinPostAction({ port, supabase: client });

		expect(action.id).toBe("linkedin_post");
		expect(action.needsApproval).toBe(true);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				text: {
					type: "string",
					minLength: 1,
					maxLength: 3000,
					description: "The post body (commentary). LinkedIn allows up to 3000 characters.",
				},
				visibility: {
					type: "string",
					enum: ["PUBLIC", "CONNECTIONS"],
					description:
						"Override the visibility configured for this integration, for this post only.",
				},
				image_base64: {
					type: "string",
					minLength: 1,
					description:
						"Optional base64-encoded image bytes (with or without a data:image/...;base64, prefix) to upload via LinkedIn Images API and attach to the post.",
				},
				image_content_type: {
					type: "string",
					enum: ["image/png", "image/jpeg", "image/gif"],
					description: "Optional MIME type for image_base64 (defaults to image/png).",
				},
				image_alt_text: {
					type: "string",
					maxLength: 4086,
					description:
						"Optional accessibility alt text for the attached image (up to 4086 characters).",
				},
			},
			required: ["text"],
			additionalProperties: false,
		});
		expect(action.description).toBe(
			"Publish a LinkedIn member post. Uses the native LinkedIn Posts API (routing='native' on the user_integrations 'linkedin' row, authenticated via LINKEDIN_ACCESS_TOKEN). Posts are public-by-config; pass visibility to override per call. Parks for the owner's approval on every agent call.",
		);
	});

	it("parks agent calls via executeAction without calling createPost", async () => {
		const port = makeMockPort();
		const { client } = makeMockSupabase({ row: { enabled: true, routing: "native", config: { author: "urn:li:person:5uhjZhaVNw" } } });
		const action = createLinkedinPostAction({ port, supabase: client });

		const parked: ApprovalRequest[] = [];
		setActionApprovalStore({
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
		});

		await expect(
			executeAction(action, { text: "Agent LinkedIn post" }, { context: { caller: "mcp", userId: "user-1" } }),
		).rejects.toThrow(PendingApprovalError);
		expect(port.createPost).not.toHaveBeenCalled();
		expect(parked).toHaveLength(1);
		expect(parked[0]?.actionId).toBe("linkedin_post");
	});

	it("publishes a post using configured author, visibility, and linkedin_version", async () => {
		const port = makeMockPort();
		const { client, updateFn } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: {
					author: "urn:li:person:5uhjZhaVNw",
					visibility: "PUBLIC",
					linkedin_version: "202601",
				},
			},
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		const result = await action.run(
			{ text: "Hello LinkedIn from ahOS!" },
			{ userId: "user-1", caller: "ui", requestId: "req-1" },
		);

		expect(result).toEqual({
			postUrn: "urn:li:share:987654321",
			author: "urn:li:person:5uhjZhaVNw",
			visibility: "PUBLIC",
		});
		expect(port.resolveAuthor).not.toHaveBeenCalled();
		expect(updateFn).not.toHaveBeenCalled();
		expect(port.createPost).toHaveBeenCalledWith({
			author: "urn:li:person:5uhjZhaVNw",
			text: "Hello LinkedIn from ahOS!",
			visibility: "PUBLIC",
			linkedinVersion: "202601",
		});
		expect(action.formatMcp?.(result)).toBe("Posted to LinkedIn. Post: urn:li:share:987654321");
	});

	it("auto-resolves and caches author via resolveAuthor() when config.author is absent, and does not block if cache write fails", async () => {
		const port = makeMockPort({
			resolveAuthor: vi.fn().mockResolvedValue("urn:li:person:5uhjZhaVNw"),
		});
		const { client, updateFn } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: { visibility: "CONNECTIONS" },
			},
			updateThrows: true,
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		const result = await action.run(
			{ text: "First post without cached author" },
			{ userId: "user-1", caller: "ui", requestId: "req-2" },
		);

		expect(port.resolveAuthor).toHaveBeenCalledTimes(1);
		expect(updateFn).toHaveBeenCalledWith({
			config: { visibility: "CONNECTIONS", author: "urn:li:person:5uhjZhaVNw" },
		});
		expect(port.createPost).toHaveBeenCalledWith({
			author: "urn:li:person:5uhjZhaVNw",
			text: "First post without cached author",
			visibility: "CONNECTIONS",
			linkedinVersion: "202601",
		});
		expect(result.author).toBe("urn:li:person:5uhjZhaVNw");
		expect(result.visibility).toBe("CONNECTIONS");
	});

	it("allows per-post visibility override over integration default", async () => {
		const port = makeMockPort();
		const { client } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: {
					author: "urn:li:person:5uhjZhaVNw",
					visibility: "PUBLIC",
				},
			},
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		const result = await action.run(
			{ text: "Connections-only note", visibility: "CONNECTIONS" },
			{ userId: "user-1", caller: "ui", requestId: "req-3" },
		);

		expect(result.visibility).toBe("CONNECTIONS");
		expect(port.createPost).toHaveBeenCalledWith(
			expect.objectContaining({ visibility: "CONNECTIONS" }),
		);
	});

	it("rejects when user_integrations row is missing or disabled", async () => {
		const port = makeMockPort();
		const { client } = makeMockSupabase({ row: { enabled: false, config: {} } });

		const action = createLinkedinPostAction({ port, supabase: client });
		await expect(
			action.run({ text: "Blocked post" }, { userId: "user-1", caller: "ui", requestId: "req-4" }),
		).rejects.toThrow(/No LinkedIn integration configured \(or it is disabled\)/);
		expect(port.createPost).not.toHaveBeenCalled();
	});

	it("validates text length between 1 and 3000 characters", () => {
		const port = makeMockPort();
		const { client } = makeMockSupabase({ row: null });
		const action = createLinkedinPostAction({ port, supabase: client });

		expect(action.schema.safeParse({ text: "" }).success).toBe(false);
		expect(action.schema.safeParse({ text: "a".repeat(3001) }).success).toBe(false);
		expect(action.schema.safeParse({ text: "a".repeat(3000) }).success).toBe(true);
	});

	it("re-resolves cached author, updates user_integrations.config, and retries once on HTTP 403 when resolveAuthor returns a different URN", async () => {
		const createPost = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("LinkedIn createPost failed (HTTP 403): ACCESS_DENIED: Invalid author URN"),
			)
			.mockResolvedValueOnce({ postUrn: "urn:li:share:healed999" });
		const resolveAuthor = vi.fn().mockResolvedValue("urn:li:person:freshAuthor456");
		const port = makeMockPort({ createPost, resolveAuthor });
		const { client, updateFn } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: {
					author: "urn:li:person:staleAuthor123",
					visibility: "PUBLIC",
					linkedin_version: "202601",
				},
			},
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		const result = await action.run(
			{ text: "Self-healed post" },
			{ userId: "user-1", caller: "ui", requestId: "req-5" },
		);

		expect(resolveAuthor).toHaveBeenCalledTimes(1);
		expect(updateFn).toHaveBeenCalledWith({
			config: {
				author: "urn:li:person:freshAuthor456",
				visibility: "PUBLIC",
				linkedin_version: "202601",
			},
		});
		expect(createPost).toHaveBeenCalledTimes(2);
		expect(createPost).toHaveBeenNthCalledWith(1, {
			author: "urn:li:person:staleAuthor123",
			text: "Self-healed post",
			visibility: "PUBLIC",
			linkedinVersion: "202601",
		});
		expect(createPost).toHaveBeenNthCalledWith(2, {
			author: "urn:li:person:freshAuthor456",
			text: "Self-healed post",
			visibility: "PUBLIC",
			linkedinVersion: "202601",
		});
		expect(result).toEqual({
			postUrn: "urn:li:share:healed999",
			author: "urn:li:person:freshAuthor456",
			visibility: "PUBLIC",
		});
	});

	it("rethrows the original HTTP 403 without retrying createPost when resolveAuthor returns the same URN", async () => {
		const createPost = vi
			.fn()
			.mockRejectedValue(
				new Error("LinkedIn createPost failed (HTTP 403): Not enough permissions to access: partnerApiPostsExternal.CREATE"),
			);
		const resolveAuthor = vi.fn().mockResolvedValue("urn:li:person:sameAuthor123");
		const port = makeMockPort({ createPost, resolveAuthor });
		const { client, updateFn } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: {
					author: "urn:li:person:sameAuthor123",
					visibility: "PUBLIC",
				},
			},
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		await expect(
			action.run(
				{ text: "Scope error post" },
				{ userId: "user-1", caller: "ui", requestId: "req-6" },
			),
		).rejects.toThrow(/HTTP 403/);

		expect(resolveAuthor).toHaveBeenCalledTimes(1);
		expect(updateFn).not.toHaveBeenCalled();
		expect(createPost).toHaveBeenCalledTimes(1);
	});

	it("uploads image_base64 (stripping data URI prefix) and passes media to createPost", async () => {
		const port = makeMockPort({
			uploadImage: vi.fn().mockResolvedValue({ imageUrn: "urn:li:image:D4E10AQF999" }),
		});
		const { client } = makeMockSupabase({
			row: {
				enabled: true,
				routing: "native",
				config: {
					author: "urn:li:person:K6OVd4iWbu",
					visibility: "PUBLIC",
					linkedin_version: "202601",
				},
			},
		});

		const action = createLinkedinPostAction({ port, supabase: client });
		const result = await action.run(
			{
				text: "Post with chart",
				image_base64: "data:image/png;base64,iVBORw==",
				image_content_type: "image/png",
				image_alt_text: "QA bar failure rate chart",
			},
			{ userId: "user-1", caller: "ui", requestId: "req-img" },
		);

		expect(port.uploadImage).toHaveBeenCalledWith({
			owner: "urn:li:person:K6OVd4iWbu",
			imageBytes: new Uint8Array([137, 80, 78, 71]),
			contentType: "image/png",
			linkedinVersion: "202601",
		});
		expect(port.createPost).toHaveBeenCalledWith({
			author: "urn:li:person:K6OVd4iWbu",
			text: "Post with chart",
			visibility: "PUBLIC",
			linkedinVersion: "202601",
			media: {
				id: "urn:li:image:D4E10AQF999",
				altText: "QA bar failure rate chart",
			},
		});
		expect(result).toEqual({
			postUrn: "urn:li:share:987654321",
			author: "urn:li:person:K6OVd4iWbu",
			visibility: "PUBLIC",
			imageUrn: "urn:li:image:D4E10AQF999",
		});
	});
});
