import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken, getStateDocPageId } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import {
	createNotionBlockDeleteAction,
	type NotionBlockDeleteInput,
} from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter(
	(workspace) => domainToken(workspace as Domain),
	{
		getStateDocPageId: (workspace) => getStateDocPageId(workspace as Domain),
	},
);

export const notionBlockDeleteAction = createNotionBlockDeleteAction(notionAdapter);
export const notionBlockDeleteTool = toMcpTool(notionBlockDeleteAction);
export const notionBlockDeleteHandler = notionBlockDeleteTool.handler;

// Preserve legacy input schema and type exports for callers inspecting inputSchema
export const notionBlockDeleteInput = (notionBlockDeleteAction.schema as any).shape;
export type NotionBlockDeleteCall = Partial<NotionBlockDeleteInput>;
