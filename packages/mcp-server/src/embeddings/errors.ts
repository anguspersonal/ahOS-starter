// Classification of embedding-provider failures (#427, follow-up to #486; moved to @ahkms/core in #1615).
export {
	classifyEmbeddingError,
	isDegradableEmbeddingError,
	isRetryableEmbeddingError,
	retryAfterMs,
	type EmbeddingErrorKind,
} from "@ahkms/core";
