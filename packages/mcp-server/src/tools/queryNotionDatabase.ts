import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import { createNotionDatabaseQueryAction } from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const queryNotionDatabaseAction = createNotionDatabaseQueryAction(notionAdapter);
export const queryNotionDatabaseTool = toMcpTool(queryNotionDatabaseAction);
export const queryNotionDatabaseHandler = queryNotionDatabaseTool.handler;

// Preserve legacy input schema export for callers inspecting inputSchema
export const queryNotionDatabaseInput = (queryNotionDatabaseAction.schema as any).shape;
