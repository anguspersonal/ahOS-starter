import { z } from "zod";
import { embedAndStore } from "../../domain/embeddings.js";
import {
	detectOfficeOpenXmlKind,
	extractOfficeOpenXmlText,
	type OfficeOpenXmlKind,
} from "../../domain/extract/office.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import type { EmbeddingPort, EmbeddingStorePort } from "../../ports/embeddings.js";
import {
	EXTRACTION_PROMPT,
	type SupportedImageMediaType,
	type TextExtractionPort,
} from "../../ports/extraction.js";
import {
	bucketCandidates,
	downloadFromAnyBucket,
	type StoragePort,
} from "../../ports/storage.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const extractTextInput = {
	artifact_id: z
		.string()
		.uuid()
		.describe("Artifact whose stored file should have its text extracted."),
};

export const extractTextSchema = z.object(extractTextInput);

export type ArtifactExtractTextInput = z.infer<typeof extractTextSchema>;

export type ArtifactExtractTextResult =
	| {
			status: "not_found";
			artifact_id: string;
			text: string;
	  }
	| {
			status: "unsupported";
			artifact_id: string;
			file_type: string | null;
			text: string;
	  }
	| {
			status: "stored_text";
			artifact_id: string;
			chars: number;
			text: string;
	  }
	| {
			status: "extracted_office";
			artifact_id: string;
			office_kind: OfficeOpenXmlKind;
			chars: number;
			text: string;
	  }
	| {
			status: "extracted_model";
			artifact_id: string;
			kind: "pdf" | "image";
			model: string;
			truncated: boolean;
			chars: number;
			text: string;
	  };

export interface ArtifactExtractTextPorts {
	artifacts: Pick<ArtifactRepository, "getById"> &
		Partial<Pick<ArtifactRepository, "saveExtractedText" | "patch">>;
	storage: Pick<StoragePort, "download">;
	extraction: TextExtractionPort;
	embeddings?: EmbeddingPort | (() => EmbeddingPort | null) | null;
	embeddingStore?: EmbeddingStorePort;
	embedArtifact?: (
		id: string,
		fields: {
			title?: string;
			description?: string;
			plain_text?: string;
		},
	) => Promise<unknown>;
	onEmbedError?: (err: unknown) => void;
}

const IMAGE_MEDIA_TYPES: Record<string, SupportedImageMediaType> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

const SUPPORTED_IMAGE_MIMES = new Set<SupportedImageMediaType>([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

export type ClassifiedArtifactKind =
	| { kind: "pdf" }
	| { kind: "image"; mediaType: SupportedImageMediaType }
	| { kind: "text" }
	| { kind: "office"; officeKind: OfficeOpenXmlKind }
	| { kind: "unknown" };

export function classifyArtifactForExtraction(
	fileType: string | null,
	path: string,
): ClassifiedArtifactKind {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const ft = (fileType ?? "").toLowerCase();

	if (ft === "application/pdf" || ext === "pdf") return { kind: "pdf" };
	const officeKind = detectOfficeOpenXmlKind(fileType, path);
	if (officeKind) return { kind: "office", officeKind };
	const ftAsImage =
		ft.startsWith("image/") && SUPPORTED_IMAGE_MIMES.has(ft as SupportedImageMediaType)
			? (ft as SupportedImageMediaType)
			: undefined;
	const extAsImage = IMAGE_MEDIA_TYPES[ext];
	const imageMime = ftAsImage ?? extAsImage;
	if (imageMime) return { kind: "image", mediaType: imageMime };
	if (ft.startsWith("text/") || ["txt", "md", "markdown"].includes(ext)) {
		return { kind: "text" };
	}
	return { kind: "unknown" };
}

export function formatArtifactExtractTextMcp(result: ArtifactExtractTextResult): string {
	return result.text;
}

export function createArtifactExtractTextAction(
	ports: ArtifactExtractTextPorts,
): ActionDefinition<typeof extractTextSchema, ArtifactExtractTextResult> {
	return defineAction({
		id: "artifact_extract_text",
		domain: "artifacts",
		description:
			"Extract text from a captured PDF or image artifact into its searchable content. Run after capturing a file so it shows up in knowledge_search.",
		schema: extractTextSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		formatMcp: formatArtifactExtractTextMcp,
		run: async (args): Promise<ArtifactExtractTextResult> => {
			const artifact = await ports.artifacts.getById(args.artifact_id);
			if (!artifact) {
				return {
					status: "not_found",
					artifact_id: args.artifact_id,
					text: `No artifact ${args.artifact_id}.`,
				};
			}

			const classified = classifyArtifactForExtraction(
				artifact.file_type,
				artifact.storage_path,
			);

			if (classified.kind === "unknown") {
				return {
					status: "unsupported",
					artifact_id: artifact.id,
					file_type: artifact.file_type,
					text: `Unsupported file type for extraction: ${artifact.file_type ?? "?"}.`,
				};
			}

			const buckets = bucketCandidates(artifact.storage_bucket, artifact.storage_url);
			const bytes = await downloadFromAnyBucket(ports.storage, buckets, artifact.storage_path);

			const persistAndEmbed = async (extractedText: string): Promise<void> => {
				let description = artifact.description ?? null;
				if (!description && ports.extraction.summarize) {
					const { summary } = await ports.extraction.summarize(
						extractedText,
						artifact.title,
					);
					if (summary) {
						description = summary;
					}
				}

				if (ports.artifacts.saveExtractedText) {
					await ports.artifacts.saveExtractedText(artifact.id, {
						extracted_content: extractedText,
						plain_text: extractedText,
						description,
						processing_status: "completed",
					});
				} else if (ports.artifacts.patch) {
					await ports.artifacts.patch(artifact.id, {
						extracted_content: extractedText,
						plain_text: extractedText,
						description,
						processing_status: "completed",
					});
				} else {
					throw new Error("ArtifactRepository must provide saveExtractedText or patch");
				}

				if (ports.embedArtifact) {
					try {
						await ports.embedArtifact(artifact.id, {
							title: artifact.title ?? undefined,
							description: description ?? undefined,
							plain_text: extractedText,
						});
					} catch (err) {
						ports.onEmbedError?.(err);
					}
					return;
				}

				if (ports.embeddings && ports.embeddingStore) {
					const embeddingPort =
						typeof ports.embeddings === "function"
							? ports.embeddings()
							: ports.embeddings;
					if (embeddingPort) {
						await embedAndStore(
							embeddingPort,
							ports.embeddingStore,
							"artifacts",
							artifact.id,
							{
								title: artifact.title ?? undefined,
								description: description ?? undefined,
								plain_text: extractedText,
							},
							{ onError: ports.onEmbedError },
						);
					}
				}
			};

			if (classified.kind === "text") {
				const extractedText = new TextDecoder("utf-8").decode(bytes);
				await persistAndEmbed(extractedText);
				return {
					status: "stored_text",
					artifact_id: artifact.id,
					chars: extractedText.length,
					text: `Stored ${extractedText.length} chars from text file (no extraction needed).`,
				};
			}

			if (classified.kind === "office") {
				const extractedText = await extractOfficeOpenXmlText(bytes, classified.officeKind);
				await persistAndEmbed(extractedText);
				return {
					status: "extracted_office",
					artifact_id: artifact.id,
					office_kind: classified.officeKind,
					chars: extractedText.length,
					text: `Extracted ${extractedText.length} chars from ${classified.officeKind} document.`,
				};
			}

			const mimeType =
				classified.kind === "pdf" ? "application/pdf" : classified.mediaType;
			const { text: extractedText, model, truncated } = await ports.extraction.extract({
				bytes,
				mediaType: mimeType,
				prompt: EXTRACTION_PROMPT,
			});

			await persistAndEmbed(extractedText);

			return {
				status: "extracted_model",
				artifact_id: artifact.id,
				kind: classified.kind,
				model,
				truncated,
				chars: extractedText.length,
				text: `Extracted ${extractedText.length} chars from ${classified.kind} (model: ${model}).${truncated ? " ⚠️ Output hit max_tokens : document may be truncated." : ""}`,
			};
		},
	});
}
