import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { executeActionClient, type ClientActionDefinition } from "../lib/actionClient.js";

describe("Agent-UI Action Parity (ADR-100 / #1261)", { timeout: 30_000 }, () => {
  it("executes action with caller: 'ui' and structured return data", async () => {
    interface PatchInput {
      documentId: string;
      content: string;
    }
    interface PatchOutput {
      success: boolean;
      documentId: string;
      caller: string;
      length: number;
    }

    const mockAction: ClientActionDefinition<PatchInput, PatchOutput> = {
      id: "document_patch",
      name: "document_patch",
      description: "Patch document buffer",
      schema: z.object({
        documentId: z.string().uuid(),
        content: z.string().min(1),
      }),
      run: async (input, ctx) => {
        expect(ctx.caller).toBe("ui");
        expect(ctx.requestId).toBeDefined();
        return {
          success: true,
          documentId: input.documentId,
          caller: ctx.caller,
          length: input.content.length,
        };
      },
    };

    const result = await executeActionClient(mockAction, {
      documentId: "11111111-2222-4333-a444-555555555555",
      content: "Hello from human UI editor",
    });

    expect(result.success).toBe(true);
    expect(result.caller).toBe("ui");
    expect(result.length).toBe(26);
  });

  it("enforces strict client-side schema validation before execution", async () => {
    interface EmailInput {
      email: string;
    }

    const mockAction: ClientActionDefinition<EmailInput, { ok: boolean }> = {
      id: "test_action",
      name: "test_action",
      description: "Test action",
      schema: z.object({
        email: z.string().email(),
      }),
      run: vi.fn(),
    };

    // Invalid email input should throw ZodError on the client
    await expect(
      executeActionClient(mockAction, {
        email: "not-an-email",
      }),
    ).rejects.toThrow();

    expect(mockAction.run).not.toHaveBeenCalled();
  });

  it("mirrors agent tool schema for quick capture", async () => {
    interface CaptureInput {
      text: string;
      title?: string;
    }
    interface CaptureOutput {
      id: string;
      text: string;
      title?: string;
      caller: string;
    }

    const captureActionDef: ClientActionDefinition<CaptureInput, CaptureOutput> = {
      id: "capture",
      name: "capture",
      description: "Capture thought into knowledge store",
      schema: z.object({
        text: z.string().min(1),
        title: z.string().optional(),
      }),
      run: async (input, ctx) => {
        return {
          id: "artifact-123",
          text: input.text,
          title: input.title,
          caller: ctx.caller,
        };
      },
    };

    const res = await executeActionClient(captureActionDef, {
      text: "Note captured via UI bar",
      title: "Co-Editing session note",
    });

    expect(res.id).toBe("artifact-123");
    expect(res.caller).toBe("ui");
  });

  it("validates and executes centralized entity CRUD action on client", async () => {
    const { entityCrudActionClient, executeEntityCrud } = await import("../lib/entityActions.js");

    // Client schema enforces valid operation
    await expect(
      executeEntityCrud({
        operation: "invalid_op" as any,
      }),
    ).rejects.toThrow();

    // Custom run handler on client action
    const customEntityAction = {
      ...entityCrudActionClient,
      run: async (input: any, ctx: any) => {
        expect(ctx.caller).toBe("ui");
        return {
          operation: input.operation,
          success: true,
          count: 1,
          entity: { id: input.id, title: "Test Entity" },
        };
      },
    };

    const res = await executeActionClient(customEntityAction, {
      operation: "get",
      id: "11111111-2222-4333-a444-555555555555",
    });

    expect(res.operation).toBe("get");
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
  });

  it("supports single delete and bulk delete with filters on client", async () => {
    const { entityCrudActionClient } = await import("../lib/entityActions.js");

    const executedCalls: any[] = [];
    const customEntityAction = {
      ...entityCrudActionClient,
      run: async (input: any, ctx: any): Promise<import("../lib/entityActions.js").ClientEntityResult> => {
        executedCalls.push({ input, caller: ctx.caller });
        if (input.operation === "delete" && input.id) {
          return {
            operation: "delete",
            success: true,
            count: 1,
            deleted: [{ id: input.id, title: "Deleted Item" }],
          };
        }
        if (input.operation === "bulk_delete" && input.dry_run) {
          return {
            operation: "bulk_delete",
            success: true,
            dryRun: true,
            count: 5,
            sample: [{ id: "id-1", title: "Sample 1" }],
          };
        }
        return {
          operation: input.operation,
          success: true,
          count: 0,
        };
      },
    };

    // Single delete execution
    const deleteRes = await executeActionClient(customEntityAction, {
      operation: "delete",
      id: "11111111-2222-4333-a444-555555555555",
      archive_only: true,
    });

    expect(deleteRes.operation).toBe("delete");
    expect(deleteRes.count).toBe(1);

    // Bulk delete with filters and dry run preview
    const bulkRes = await executeActionClient(customEntityAction, {
      operation: "bulk_delete",
      filter: {
        entity_type: "concept",
        tags: ["temp"],
        created_before: "2026-01-01T00:00:00.000Z",
      },
      dry_run: true,
    });

    expect(bulkRes.operation).toBe("bulk_delete");
    expect(bulkRes.dryRun).toBe(true);
    expect(bulkRes.count).toBe(5);
    expect(executedCalls).toHaveLength(2);
  });
});
