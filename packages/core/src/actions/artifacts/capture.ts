import { defineAction } from "../defineAction.js";
import {
	captureSchema,
	type CaptureInput,
} from "../domain/capture.js";
import type { CapturePort, CaptureResult } from "../../ports/artifacts.js";

export function formatCaptureMcp(result: CaptureResult): string {
	return `Captured artifact ${result.id}\nTitle: ${result.title}\nTags: ${result.tags.length ? result.tags.join(", ") : "(none)"}\nChannel: ${result.source_channel}\nStored at: ${result.storage_bucket}/${result.storage_path}${result.captured_at_declared ? `\nFiled under: ${result.captured_at} (declared)` : ""}${result.deduplicated ? `\nDeduplicated: true (matched an existing artifact, nothing new was written)` : ""}`;
}

export function createCaptureAction(port: CapturePort | Pick<CapturePort, "capture">) {
	return defineAction({
		id: "capture",
		description:
			"Dump a note/content into the knowledge store. Stores the body and creates an artifact. captured_at defaults to now; a caller may declare a different day for its OWN artifact via the optional captured_at, but only for an allowlisted content_subtype ('daily_log' today - the Daily Log twin, #562) and never in the future. Both bounds are refusals, not silent fallbacks (#414).",
		schema: captureSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input: CaptureInput, ctx) => port.capture(input, ctx.userId),
		formatMcp: formatCaptureMcp,
	});
}
