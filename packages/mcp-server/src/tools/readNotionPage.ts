import { toMcpTool } from "../actions/adapters/mcp.js";
import { domainToken } from "../notionDomain.js";
import { NotionClientAdapter } from "@ahkms/core/adapters";
import {
	createNotionPageGetAction,
	propertyPlain,
} from "@ahkms/core/actions";
import type { Domain } from "../domains.js";

export { propertyPlain };

export const notionAdapter = new NotionClientAdapter((workspace) =>
	domainToken(workspace as Domain),
);

export const readNotionPageAction = createNotionPageGetAction(notionAdapter);
export const readNotionPageTool = toMcpTool(readNotionPageAction);
export const readNotionPageHandler = readNotionPageTool.handler;

// Preserve legacy input schema export for callers inspecting inputSchema
export const readNotionPageInput = (readNotionPageAction.schema as any).shape;
