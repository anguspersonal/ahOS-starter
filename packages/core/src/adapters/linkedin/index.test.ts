import { describe, expect, it, vi } from "vitest";
import { createLinkedinAdapter } from "./index.js";

describe("createLinkedinAdapter", () => {
	describe("createPost", () => {
		it("sends POST /rest/posts with versioned headers and returns x-restli-id postUrn", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 201,
					headers: { "x-restli-id": "urn:li:share:7123456789" },
				}),
			);
			const adapter = createLinkedinAdapter(() => "secret-token-xyz", mockFetch as unknown as typeof fetch);

			const result = await adapter.createPost({
				author: "urn:li:person:5uhjZhaVNw",
				text: "Shipped native LinkedIn adapter.",
				visibility: "PUBLIC",
				linkedinVersion: "202601",
			});

			expect(result).toEqual({ postUrn: "urn:li:share:7123456789" });
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe("https://api.linkedin.com/rest/posts");
			expect(init.method).toBe("POST");
			expect(init.headers).toEqual({
				Authorization: "Bearer secret-token-xyz",
				"LinkedIn-Version": "202601",
				"X-Restli-Protocol-Version": "2.0.0",
				"Content-Type": "application/json",
			});
			expect(JSON.parse(init.body)).toEqual({
				author: "urn:li:person:5uhjZhaVNw",
				commentary: "Shipped native LinkedIn adapter.",
				visibility: "PUBLIC",
				distribution: {
					feedDistribution: "MAIN_FEED",
					targetEntities: [],
					thirdPartyDistributionChannels: [],
				},
				lifecycleState: "PUBLISHED",
				isReshareDisabledByAuthor: false,
			});
		});

		it("escapes Little Text Format reserved characters (parentheses, underscores, brackets) so LinkedIn does not truncate commentary", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 201,
					headers: { "x-restli-id": "urn:li:share:7516903255340318720" },
				}),
			);
			const adapter = createLinkedinAdapter(() => "secret-token-xyz", mockFetch as unknown as typeof fetch);

			await adapter.createPost({
				author: "urn:li:person:K6OVd4iWbu",
				text: "46.8% of them (104 PRs) failed qa_bar.yml [round # 1] #AI",
				visibility: "PUBLIC",
				linkedinVersion: "202601",
			});

			const [, init] = mockFetch.mock.calls[0];
			expect(JSON.parse(init.body).commentary).toBe(
				"46.8% of them \\(104 PRs\\) failed qa\\_bar.yml \\[round \\# 1\\] #AI",
			);
		});

		it("surfaces a clear 60-day token expiry error on HTTP 401 without echoing the token", async () => {
			const secretToken = "super-secret-linkedin-token-999";
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ message: "Expired access token" }), { status: 401 }),
			);
			const adapter = createLinkedinAdapter(() => secretToken, mockFetch as unknown as typeof fetch);

			await expect(
				adapter.createPost({
					author: "urn:li:person:5uhjZhaVNw",
					text: "Hello",
					visibility: "PUBLIC",
					linkedinVersion: "202601",
				}),
			).rejects.toThrow(/60-day member access token.*LINKEDIN_ACCESS_TOKEN.*#1631/);

			try {
				await adapter.createPost({
					author: "urn:li:person:5uhjZhaVNw",
					text: "Hello",
					visibility: "PUBLIC",
					linkedinVersion: "202601",
				});
			} catch (err) {
				expect((err as Error).message).not.toContain(secretToken);
			}
		});

		it("includes NONEXISTENT_VERSION guidance on non-2xx responses", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ code: "NONEXISTENT_VERSION", message: "Version 202401 is sunset" }), {
					status: 426,
				}),
			);
			const adapter = createLinkedinAdapter(() => "token", mockFetch as unknown as typeof fetch);

			await expect(
				adapter.createPost({
					author: "urn:li:person:5uhjZhaVNw",
					text: "Hello",
					visibility: "PUBLIC",
					linkedinVersion: "202401",
				}),
			).rejects.toThrow(/HTTP 426.*NONEXISTENT_VERSION.*bump linkedin_version/);
		});

		it("throws when token resolver returns empty or null", async () => {
			const mockFetch = vi.fn();
			const adapter = createLinkedinAdapter(() => null, mockFetch as unknown as typeof fetch);

			await expect(
				adapter.createPost({
					author: "urn:li:person:5uhjZhaVNw",
					text: "Hello",
					visibility: "PUBLIC",
					linkedinVersion: "202601",
				}),
			).rejects.toThrow(/LINKEDIN_ACCESS_TOKEN/);
			expect(mockFetch).not.toHaveBeenCalled();
		});
		it("includes content.media payload when media is provided", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 201,
					headers: { "x-restli-id": "urn:li:share:7123456790" },
				}),
			);
			const adapter = createLinkedinAdapter(() => "secret-token-xyz", mockFetch as unknown as typeof fetch);

			await adapter.createPost({
				author: "urn:li:person:5uhjZhaVNw",
				text: "Post with chart",
				visibility: "PUBLIC",
				linkedinVersion: "202601",
				media: {
					id: "urn:li:image:D4E10AQF12345",
					altText: "QA bar failure rate chart",
				},
			});

			const [, init] = mockFetch.mock.calls[0];
			expect(JSON.parse(init.body).content).toEqual({
				media: {
					id: "urn:li:image:D4E10AQF12345",
					altText: "QA bar failure rate chart",
				},
			});
		});
	});

	describe("uploadImage", () => {
		it("calls initializeUpload then PUTs imageBytes to uploadUrl and returns imageUrn", async () => {
			const mockFetch = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							value: {
								uploadUrl: "https://api.linkedin.com/mediaUpload/sp/123",
								image: "urn:li:image:D4E10AQF12345",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				)
				.mockResolvedValueOnce(new Response(null, { status: 201 }));

			const adapter = createLinkedinAdapter(() => "secret-token-xyz", mockFetch as unknown as typeof fetch);
			const imageBytes = new Uint8Array([137, 80, 78, 71]);

			const result = await adapter.uploadImage({
				owner: "urn:li:person:5uhjZhaVNw",
				imageBytes,
				linkedinVersion: "202601",
			});

			expect(result).toEqual({ imageUrn: "urn:li:image:D4E10AQF12345" });
			expect(mockFetch).toHaveBeenCalledTimes(2);

			const [initUrl, initOpts] = mockFetch.mock.calls[0];
			expect(initUrl).toBe("https://api.linkedin.com/rest/images?action=initializeUpload");
			expect(initOpts.method).toBe("POST");
			expect(initOpts.headers).toEqual({
				Authorization: "Bearer secret-token-xyz",
				"LinkedIn-Version": "202601",
				"X-Restli-Protocol-Version": "2.0.0",
				"Content-Type": "application/json",
			});
			expect(JSON.parse(initOpts.body)).toEqual({
				initializeUploadRequest: {
					owner: "urn:li:person:5uhjZhaVNw",
				},
			});

			const [putUrl, putOpts] = mockFetch.mock.calls[1];
			expect(putUrl).toBe("https://api.linkedin.com/mediaUpload/sp/123");
			expect(putOpts.method).toBe("PUT");
			expect(putOpts.headers).toEqual({
				Authorization: "Bearer secret-token-xyz",
				"Content-Type": "image/png",
			});
			expect(putOpts.body).toBe(imageBytes);
		});
	});

	describe("resolveAuthor", () => {
		it("fetches /v2/userinfo and formats urn:li:person:<sub>", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ sub: "5uhjZhaVNw" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
			const adapter = createLinkedinAdapter(() => "token-abc", mockFetch as unknown as typeof fetch);

			const author = await adapter.resolveAuthor();
			expect(author).toBe("urn:li:person:5uhjZhaVNw");
			expect(mockFetch).toHaveBeenCalledWith("https://api.linkedin.com/v2/userinfo", {
				headers: { Authorization: "Bearer token-abc" },
			});
		});

		it("throws 60-day token error on HTTP 401 from /v2/userinfo", async () => {
			const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
			const adapter = createLinkedinAdapter(() => "secret-tok", mockFetch as unknown as typeof fetch);

			await expect(adapter.resolveAuthor()).rejects.toThrow(/60-day member access token/);
		});

		it("throws if sub claim is missing from /v2/userinfo response", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ name: "Angus" }), { status: 200 }),
			);
			const adapter = createLinkedinAdapter(() => "token-abc", mockFetch as unknown as typeof fetch);

			await expect(adapter.resolveAuthor()).rejects.toThrow(/missing 'sub' claim/);
		});
	});
});
