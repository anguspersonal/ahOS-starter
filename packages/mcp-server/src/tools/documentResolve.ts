import type { z } from "zod";
import {
	createDocumentResolveAction,
	DOCUMENT_RESOLVE_DESCRIPTION,
	documentResolveInput,
	documentResolveSchema,
	formatDocumentResolveMcp,
	matchTrackedDocument,
	titleSearchTerms,
	type DocumentResolveInput,
	type DocumentResolvePorts,
	type DocumentResolveResult,
} from "@ahkms/core";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";

export {
	createDocumentResolveAction,
	DOCUMENT_RESOLVE_DESCRIPTION,
	documentResolveInput,
	documentResolveSchema,
	formatDocumentResolveMcp,
	matchTrackedDocument,
	titleSearchTerms,
	type DocumentResolveInput,
	type DocumentResolvePorts,
	type DocumentResolveResult,
};

export async function documentResolveHandler(
	args: z.infer<typeof documentResolveSchema>,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const action = serverRegistry().get("document_resolve")!;
	return toMcpTool(action).handler(args);
}
