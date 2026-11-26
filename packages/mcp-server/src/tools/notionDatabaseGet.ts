import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import { createNotionDatabaseGetAction } from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const notionDatabaseGetAction = createNotionDatabaseGetAction(notionAdapter);
export const notionDatabaseGetTool = toMcpTool(notionDatabaseGetAction);
export const notionDatabaseGetHandler = notionDatabaseGetTool.handler;

// Preserve legacy input schema and type exports for callers inspecting inputSchema
export const notionDatabaseGetInput = (notionDatabaseGetAction.schema as any).shape;
export type NotionDatabaseGetCall = any;
