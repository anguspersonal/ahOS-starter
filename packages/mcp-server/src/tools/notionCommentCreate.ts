import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import {
	createNotionCommentCreateAction,
	type NotionCommentCreateInput,
} from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const notionCommentCreateAction = createNotionCommentCreateAction(notionAdapter);
export const notionCommentCreateTool = toMcpTool(notionCommentCreateAction);
export const notionCommentCreateHandler = notionCommentCreateTool.handler;

// Preserve legacy input schema and type exports for callers inspecting inputSchema
export const notionCommentCreateInput = (notionCommentCreateAction.schema as any).shape;
export type NotionCommentCreateCall = Partial<NotionCommentCreateInput>;
