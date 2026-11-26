import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import type { LinkedinPort, LinkedinVisibility } from "../../ports/linkedin.js";
import type { GenericSupabaseClient } from "../github/issueCreate.js";

const DEFAULT_LINKEDIN_VERSION = "202601";

function decodeBase64Image(raw: string): Uint8Array {
	const stripped = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, "").trim();
	const binary = atob(stripped);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export const linkedinPostInputSchema = z.object({
	text: z
		.string()
		.min(1)
		.max(3000)
		.describe("The post body (commentary). LinkedIn allows up to 3000 characters."),
	visibility: z
		.enum(["PUBLIC", "CONNECTIONS"])
		.optional()
		.describe("Override the visibility configured for this integration, for this post only."),
	image_base64: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional base64-encoded image bytes (with or without a data:image/...;base64, prefix) to upload via LinkedIn Images API and attach to the post.",
		),
	image_content_type: z
		.enum(["image/png", "image/jpeg", "image/gif"])
		.optional()
		.describe("Optional MIME type for image_base64 (defaults to image/png)."),
	image_alt_text: z
		.string()
		.max(4086)
		.optional()
		.describe("Optional accessibility alt text for the attached image (up to 4086 characters)."),
});

export type LinkedinPostInput = z.infer<typeof linkedinPostInputSchema>;

export const linkedinPostOutputSchema = z.object({
	postUrn: z.string(),
	author: z.string(),
	visibility: z.enum(["PUBLIC", "CONNECTIONS"]),
	imageUrn: z.string().optional(),
});

export type LinkedinPostOutput = z.infer<typeof linkedinPostOutputSchema>;

export interface LinkedinIntegrationConfig {
	author?: string;
	visibility?: LinkedinVisibility;
	linkedin_version?: string;
}

export interface LinkedinPostActionDependencies {
	port: LinkedinPort;
	supabase: GenericSupabaseClient;
	getUserId?: () => string;
}

export async function executeLinkedinPost(
	input: LinkedinPostInput,
	context: ActionContext,
	deps: LinkedinPostActionDependencies,
): Promise<LinkedinPostOutput> {
	const userId = context.userId ?? deps.getUserId?.();
	if (!userId) {
		throw new Error("Missing user context: userId is required to verify LinkedIn integration permissions.");
	}

	const { data, error } = await deps.supabase
		.from("user_integrations")
		.select("config, enabled, routing")
		.eq("user_id", userId)
		.eq("provider", "linkedin")
		.maybeSingle();

	if (error) {
		throw new Error(`Failed to load LinkedIn integration config: ${error.message}`);
	}

	if (!data || data.enabled === false) {
		throw new Error(
			"No LinkedIn integration configured (or it is disabled) in user_integrations. Use integration_set to configure provider 'linkedin'.",
		);
	}

	const rawConfig =
		data.config && typeof data.config === "object" && !Array.isArray(data.config)
			? (data.config as Record<string, unknown>)
			: {};
	const config = rawConfig as LinkedinIntegrationConfig;

	const visibility: LinkedinVisibility =
		input.visibility ??
		(config.visibility === "CONNECTIONS" || config.visibility === "PUBLIC"
			? config.visibility
			: "PUBLIC");
	const linkedinVersion =
		typeof config.linkedin_version === "string" && /^\d{6}$/.test(config.linkedin_version)
			? config.linkedin_version
			: DEFAULT_LINKEDIN_VERSION;

	let author =
		typeof config.author === "string" && /^urn:li:(person|organization):.+/.test(config.author)
			? config.author
			: undefined;
	const usedCachedAuthor = Boolean(author);

	if (!author) {
		author = await deps.port.resolveAuthor();
		// Best-effort cache of the resolved author URN back into user_integrations.config.
		try {
			await deps.supabase
				.from("user_integrations")
				.update({ config: { ...rawConfig, author } })
				.eq("user_id", userId)
				.eq("provider", "linkedin");
		} catch {
			// A failed cache write must not block posting.
		}
	}

	const imageBytes = input.image_base64 ? decodeBase64Image(input.image_base64) : undefined;
	let imageUrn: string | undefined;
	let postUrn!: string;

	const publishWithAuthor = async (currentAuthor: string) => {
		if (imageBytes) {
			const uploaded = await deps.port.uploadImage({
				owner: currentAuthor,
				imageBytes,
				contentType: input.image_content_type,
				linkedinVersion,
			});
			imageUrn = uploaded.imageUrn;
		}

		({ postUrn } = await deps.port.createPost({
			author: currentAuthor,
			text: input.text,
			visibility,
			linkedinVersion,
			...(imageUrn
				? {
						media: {
							id: imageUrn,
							...(input.image_alt_text ? { altText: input.image_alt_text } : {}),
						},
					}
				: {}),
		}));
	};

	try {
		await publishWithAuthor(author);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!usedCachedAuthor || !/HTTP 403\b/.test(message)) {
			throw err;
		}
		const freshAuthor = await deps.port.resolveAuthor();
		if (freshAuthor === author) {
			throw err;
		}
		author = freshAuthor;
		try {
			await deps.supabase
				.from("user_integrations")
				.update({ config: { ...rawConfig, author } })
				.eq("user_id", userId)
				.eq("provider", "linkedin");
		} catch {
			// A failed cache write must not block posting.
		}
		await publishWithAuthor(author);
	}

	return {
		postUrn,
		author,
		visibility,
		...(imageUrn ? { imageUrn } : {}),
	};
}

export function createLinkedinPostAction(
	portOrDeps: LinkedinPort | LinkedinPostActionDependencies,
	options?: { supabase: GenericSupabaseClient; getUserId?: () => string },
): ActionDefinition<typeof linkedinPostInputSchema, LinkedinPostOutput> {
	const deps: LinkedinPostActionDependencies =
		"port" in portOrDeps
			? portOrDeps
			: {
					port: portOrDeps,
					supabase: options!.supabase,
					getUserId: options?.getUserId,
				};

	return defineAction({
		id: "linkedin_post",
		name: "linkedin_post",
		description:
			"Publish a LinkedIn member post. Uses the native LinkedIn Posts API (routing='native' on the user_integrations 'linkedin' row, authenticated via LINKEDIN_ACCESS_TOKEN). Posts are public-by-config; pass visibility to override per call. Parks for the owner's approval on every agent call.",
		domain: "integrations",
		needsApproval: true,
		schema: linkedinPostInputSchema,
		outputSchema: linkedinPostOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp(result) {
			return `Posted to LinkedIn. Post: ${result.postUrn}`;
		},
		async run(input, context) {
			return executeLinkedinPost(input, context, deps);
		},
	});
}
