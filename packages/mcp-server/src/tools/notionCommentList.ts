import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import {
	createNotionCommentListAction,
	type NotionCommentListInput,
} from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const notionCommentListAction = createNotionCommentListAction(notionAdapter);
export const notionCommentListTool = toMcpTool(notionCommentListAction);
export const notionCommentListHandler = notionCommentListTool.handler;

// Preserve legacy input schema and type exports for callers inspecting inputSchema
export const notionCommentListInput = (notionCommentListAction.schema as any).shape;
export type NotionCommentListCall = Partial<NotionCommentListInput>;
