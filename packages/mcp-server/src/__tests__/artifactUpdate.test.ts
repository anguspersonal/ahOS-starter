import { afterEach, describe, expect, it, vi } from "vitest";
import { artifactUpdateInput } from "@ahkms/core";
import { supabase } from "../supabase.js";
import * as embeddings from "../embeddings.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { z } from "zod";

const artifactUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("artifact_update")!).handler(args);

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env
const ART_ID = "11111111-2222-3333-4444-555555555555";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/** A query builder whose eq() chains and whose select().single() resolves the result. */
function builder(result: unknown, hooks?: { eq?: (...a: unknown[]) => void }) {
	const b: any = {
		eq: (...args: unknown[]) => {
			hooks?.eq?.(...args);
			return b;
		},
		select: () => ({ single: () => Promise.resolve(result) }),
	};
	return b;
}

describe("artifactUpdateHandler — archive/restore path", () => {
	it("restores a soft-deleted artifact on archived:false, clearing the archive stamps", async () => {
		let payload: Record<string, unknown> | undefined;
		const b = builder({ data: { id: ART_ID, archived: false }, error: null });
		(supabase as any).from = vi.fn(() => ({
			update: (p: Record<string, unknown>) => {
				payload = p;
				return b;
			},
		}));

		const result = await artifactUpdateHandler({ id: ART_ID, patch: { archived: false } } as any);

		expect(payload).toMatchObject({ archived: false, archived_at: null, archived_reason: null });
		expect(result.content[0].text).toContain("restored");
	});

	it("stamps archived_at when archiving via update (archived:true) and none supplied", async () => {
		let payload: Record<string, unknown> | undefined;
		const b = builder({ data: { id: ART_ID, archived: true }, error: null });
		(supabase as any).from = vi.fn(() => ({
			update: (p: Record<string, unknown>) => {
				payload = p;
				return b;
			},
		}));

		const result = await artifactUpdateHandler({ id: ART_ID, patch: { archived: true } } as any);

		expect(payload?.archived).toBe(true);
		expect(typeof payload?.archived_at).toBe("string");
		expect(result.content[0].text).toContain("archived");
	});

	it("does not touch archive stamps for an ordinary field update", async () => {
		let payload: Record<string, unknown> | undefined;
		const b = builder({ data: { id: ART_ID, archived: false }, error: null });
		(supabase as any).from = vi.fn(() => ({
			update: (p: Record<string, unknown>) => {
				payload = p;
				return b;
			},
		}));

		await artifactUpdateHandler({ id: ART_ID, patch: { title: "New title" } } as any);

		expect(payload).toEqual({ title: "New title" });
		expect(payload).not.toHaveProperty("archived_at");
	});

	it("scopes the update by user_id (RLS-equivalent guard)", async () => {
		const eq = vi.fn();
		const b = builder({ data: { id: ART_ID, archived: false }, error: null }, { eq });
		(supabase as any).from = vi.fn(() => ({ update: () => b }));

		await artifactUpdateHandler({ id: ART_ID, patch: { archived: false } } as any);

		expect(eq).toHaveBeenCalledWith("user_id", TEST_USER);
	});

	it("accepts plain_text in patch schema and refreshes embeddings when updated", async () => {
		const validId = "11111111-2222-4333-8444-555555555555";
		let payload: Record<string, unknown> | undefined;
		const embedSpy = vi.spyOn(embeddings, "embedAndStore").mockResolvedValue("embedded");
		const b = builder({
			data: {
				id: validId,
				title: "Man and Van Collective",
				description: "Business card",
				plain_text: "Updated body with https://www.manandvancollective.com/",
				archived: false,
			},
			error: null,
		});
		(supabase as any).from = vi.fn(() => ({
			update: (p: Record<string, unknown>) => {
				payload = p;
				return b;
			},
		}));

		const parsed = z.object(artifactUpdateInput).parse({
			id: validId,
			patch: { plain_text: "Updated body with https://www.manandvancollective.com/" },
		});
		await artifactUpdateHandler(parsed);

		expect(payload).toEqual({ plain_text: "Updated body with https://www.manandvancollective.com/" });
		expect(embedSpy).toHaveBeenCalledWith("artifacts", validId, {
			title: "Man and Van Collective",
			description: "Business card",
			plain_text: "Updated body with https://www.manandvancollective.com/",
		});
	});

	it("syncs storage blob, file_size, and content_fingerprint when plain_text is patched on a text/markdown artifact", async () => {
		const validId = "11111111-2222-4333-8444-555555555555";
		const updatedBody = "# Enriched Note\n\nDecoded URL: https://www.manandvancollective.com/";
		const payloads: Record<string, unknown>[] = [];
		const uploadMock = vi.fn().mockResolvedValue({ data: { path: "u/2026/10/note.md" }, error: null });
		const origStorage = (supabase as any).storage;
		(supabase as any).storage = {
			from: vi.fn(() => ({ upload: uploadMock })),
		};
		vi.spyOn(embeddings, "embedAndStore").mockResolvedValue("embedded");

		const b = builder({
			data: {
				id: validId,
				title: "Enriched Note",
				description: "Note",
				plain_text: updatedBody,
				storage_bucket: "artifacts",
				storage_path: "u/2026/10/note.md",
				file_type: "text/markdown",
				archived: false,
			},
			error: null,
		});
		(supabase as any).from = vi.fn(() => ({
			update: (p: Record<string, unknown>) => {
				payloads.push(p);
				return b;
			},
		}));

		try {
			await artifactUpdateHandler({
				id: validId,
				patch: { plain_text: updatedBody },
			} as any);

			expect(uploadMock).toHaveBeenCalledTimes(1);
			expect(uploadMock.mock.calls[0][0]).toBe("u/2026/10/note.md");
			expect(Buffer.from(uploadMock.mock.calls[0][1]).toString("utf8")).toBe(updatedBody);
			expect(uploadMock.mock.calls[0][2]).toEqual({ contentType: "text/markdown", upsert: true });
			expect(payloads).toHaveLength(2);
			expect(payloads[1]).toMatchObject({
				file_size: Buffer.byteLength(updatedBody, "utf8"),
				content_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
		} finally {
			(supabase as any).storage = origStorage;
		}
	});
});
