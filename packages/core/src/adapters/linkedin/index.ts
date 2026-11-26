import type {
	LinkedinCreatePostParams,
	LinkedinPort,
	LinkedinUploadImageParams,
} from "../../ports/linkedin.js";

export type LinkedinTokenResolver = () => Promise<string | null | undefined> | string | null | undefined;

const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";
const LINKEDIN_IMAGES_INIT_URL = "https://api.linkedin.com/rest/images?action=initializeUpload";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const TOKEN_EXPIRED_ERROR =
	"LinkedIn API returned HTTP 401 (Unauthorized): the 60-day member access token in LINKEDIN_ACCESS_TOKEN is expired or revoked. Mint a fresh token via the LinkedIn Developer Portal OAuth 2.0 Token Generator (scopes: openid, profile, w_member_social) and update LINKEDIN_ACCESS_TOKEN on Railway (#1631).";

const LITTLE_TEXT_RESERVED_REGEX = /[\\|{}@[\]()<>*_~]/g;

/**
 * Escapes reserved characters for LinkedIn's Little Text Format (`commentary` in `/rest/posts`).
 * Unescaped parentheses or markup delimiters cause LinkedIn's parser to silently truncate the post.
 * Preserves `#hashtag` tokens when `#` is immediately followed by letters or numbers.
 */
export function escapeLinkedinLittleText(text: string): string {
	return text
		.replace(LITTLE_TEXT_RESERVED_REGEX, (ch) => `\\${ch}`)
		.replace(/#(?![\p{L}\p{N}_])/gu, "\\#");
}

/**
 * Native LinkedIn Posts API adapter (ADR-101 §1, §4; #1632).
 * Receives a token resolver function; never reads process.env directly and never echoes the token.
 */
export class NativeLinkedinAdapter implements LinkedinPort {
	constructor(
		private readonly tokenResolver: LinkedinTokenResolver,
		private readonly fetchFn: typeof fetch = fetch,
	) {}

	private async resolveToken(): Promise<string> {
		const token = await this.tokenResolver();
		if (!token || typeof token !== "string" || token.trim().length === 0) {
			throw new Error(
				"Missing credential for 'linkedin': set LINKEDIN_ACCESS_TOKEN (required for posting to LinkedIn).",
			);
		}
		return token.trim();
	}

	async uploadImage(params: LinkedinUploadImageParams): Promise<{ imageUrn: string }> {
		const token = await this.resolveToken();
		const initRes = await this.fetchFn(LINKEDIN_IMAGES_INIT_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"LinkedIn-Version": params.linkedinVersion,
				"X-Restli-Protocol-Version": "2.0.0",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				initializeUploadRequest: {
					owner: params.owner,
				},
			}),
		});

		if (initRes.status === 401) {
			throw new Error(TOKEN_EXPIRED_ERROR);
		}

		if (!initRes.ok) {
			const detail = (await initRes.text().catch(() => "")).slice(0, 300);
			throw new Error(`LinkedIn image initializeUpload failed: HTTP ${initRes.status} - ${detail}`);
		}

		const initBody = (await initRes.json()) as {
			value?: { uploadUrl?: unknown; image?: unknown };
		};
		const uploadUrl = initBody.value?.uploadUrl;
		const imageUrn = initBody.value?.image;
		if (typeof uploadUrl !== "string" || !uploadUrl || typeof imageUrn !== "string" || !imageUrn) {
			throw new Error(
				"LinkedIn image initializeUpload response missing value.uploadUrl or value.image.",
			);
		}

		const putRes = await this.fetchFn(uploadUrl, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": params.contentType ?? "image/png",
			},
			body: params.imageBytes as unknown as BodyInit,
		});

		if (putRes.status === 401) {
			throw new Error(TOKEN_EXPIRED_ERROR);
		}

		if (!putRes.ok) {
			const detail = (await putRes.text().catch(() => "")).slice(0, 300);
			throw new Error(`LinkedIn image binary upload failed: HTTP ${putRes.status} - ${detail}`);
		}

		return { imageUrn };
	}

	async createPost(params: LinkedinCreatePostParams): Promise<{ postUrn: string }> {
		const token = await this.resolveToken();
		const payload: Record<string, unknown> = {
			author: params.author,
			commentary: escapeLinkedinLittleText(params.text),
			visibility: params.visibility,
			distribution: {
				feedDistribution: "MAIN_FEED",
				targetEntities: [],
				thirdPartyDistributionChannels: [],
			},
			lifecycleState: "PUBLISHED",
			isReshareDisabledByAuthor: false,
		};
		if (params.media) {
			payload.content = {
				media: {
					id: params.media.id,
					...(params.media.altText ? { altText: params.media.altText } : {}),
				},
			};
		}

		const res = await this.fetchFn(LINKEDIN_POSTS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"LinkedIn-Version": params.linkedinVersion,
				"X-Restli-Protocol-Version": "2.0.0",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (res.status === 401) {
			throw new Error(TOKEN_EXPIRED_ERROR);
		}

		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			throw new Error(
				`LinkedIn post failed: HTTP ${res.status} - ${detail}. If this is a version error (NONEXISTENT_VERSION), bump linkedin_version in the integration config; LinkedIn sunsets API versions roughly yearly.`,
			);
		}

		const postUrn = res.headers.get("x-restli-id") ?? "(id not returned)";
		return { postUrn };
	}

	async resolveAuthor(): Promise<string> {
		const token = await this.resolveToken();
		const res = await this.fetchFn(LINKEDIN_USERINFO_URL, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (res.status === 401) {
			throw new Error(TOKEN_EXPIRED_ERROR);
		}

		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 200);
			throw new Error(`LinkedIn /v2/userinfo failed: HTTP ${res.status} - ${detail}`);
		}

		const body = (await res.json()) as { sub?: unknown };
		if (typeof body.sub !== "string" || !body.sub) {
			throw new Error(
				"LinkedIn /v2/userinfo response missing 'sub' claim; ensure the token has the 'openid' scope or set config.author explicitly via integration_set.",
			);
		}

		return `urn:li:person:${body.sub}`;
	}
}

export function createLinkedinAdapter(
	tokenResolver: LinkedinTokenResolver,
	fetchFn: typeof fetch = fetch,
): LinkedinPort {
	return new NativeLinkedinAdapter(tokenResolver, fetchFn);
}
