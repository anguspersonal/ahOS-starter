import { defineAction } from "../defineAction.js";
import { bulkDeleteSchema } from "../domain/entities.js";
import type { EntitiesPort } from "../../ports/entities.js";
import { formatEntitiesDeleteMcp } from "./format.js";

export function createEntityBulkDeleteAction(port: EntitiesPort) {
	return defineAction({
		id: "entity_bulk_delete",
		name: "entity_bulk_delete",
		description:
			"Delete or archive multiple entities by ids or filter criteria, with optional dry_run preview. Parks for the owner's approval when archive_only is false and more than 50 rows match.",
		domain: "kg",
		schema: bulkDeleteSchema,
		needsApproval: (input, ctx) =>
			input.archive_only === false && !input.dry_run
				? (port.needsHardDeleteApproval?.(input, ctx.userId) ?? false)
				: false,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (args, ctx) => port.entityBulkDelete(args, ctx),
		formatMcp: formatEntitiesDeleteMcp,
	});
}
