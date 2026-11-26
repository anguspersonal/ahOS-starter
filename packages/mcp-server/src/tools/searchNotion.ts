import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import { createNotionSearchAction } from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const searchNotionAction = createNotionSearchAction(notionAdapter);
export const searchNotionTool = toMcpTool(searchNotionAction);
export const searchNotionHandler = searchNotionTool.handler;

// Preserve legacy input schema export for callers inspecting inputSchema
export const searchNotionInput = (searchNotionAction.schema as any).shape;
