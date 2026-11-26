import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateGate, executeAction, isPendingApproval, PendingApprovalError, setActionApprovalStore, setDefaultAuditSink, stderrAuditSink, type ApprovalRequest } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { LEGACY_GATES } from "../actions/legacyGates.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entityBulkDeleteAction = serverRegistry().get("entity_bulk_delete")!;
const entityCrudAction = serverRegistry().get("entity_crud")!;
const entitiesDeleteHandler = (args: Record<string, unknown>, extra?: unknown) =>
	toMcpTool(serverRegistry().get("entity_delete")!).handler(args, extra as any);

const origFrom = supabase.from;
const makeId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const makeIds = (n: number) => Array.from({ length: n }, (_, i) => makeId(i + 1));
const mockRow = (id: string, title = `Row ${id}`) => ({
	id, entity_type: "concept", title, name: title, description: null, archived: false, archived_at: null,
	properties: {}, tags: [], source_url: null, user_id: "test-user-id", team_id: null,
	created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

function createMockSupabase(rowData: any = []) {
	const deleteSpy = vi.fn();
	const updateSpy = vi.fn();
	const fromMock = vi.fn((table: string) => {
		if (table === "entities" || table === "people") {
			const b: any = {
				_m: false,
				select: vi.fn(() => (b._m ? Promise.resolve({ data: rowData, error: null }) : b)),
				update: vi.fn((...a: unknown[]) => { updateSpy(...a); b._m = true; return b; }),
				delete: vi.fn((...a: unknown[]) => { deleteSpy(...a); b._m = true; return b; }),
				eq: vi.fn(() => b), in: vi.fn(() => b), is: vi.fn(() => b), lt: vi.fn(() => b), contains: vi.fn(() => b), order: vi.fn(() => b),
				limit: vi.fn(() => Promise.resolve({ data: rowData, error: null })),
				maybeSingle: vi.fn(() => Promise.resolve({ data: rowData[0] ?? null, error: null })),
			};
			return b;
		}
		const c: any = {
			select: vi.fn(() => c), update: vi.fn(() => c), delete: vi.fn(() => c), eq: vi.fn(() => c), in: vi.fn(() => c),
			limit: vi.fn(() => Promise.resolve({ data: [], error: null })), maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
			then: (f: any) => Promise.resolve({ data: [], error: null }).then(f),
		};
		return c;
	});
	return { fromMock, deleteSpy, updateSpy };
}

describe("entity and person hard-delete gates (#1427)", () => {
	let parkCalls: ApprovalRequest[] = [];
	const ctx = { caller: "mcp" as const, userId: "test-user-id" };

	beforeEach(() => {
		process.env.KMS_USER_ID = "test-user-id";
		parkCalls = [];
		let seq = 0;
		setActionApprovalStore({ park: vi.fn(async (req: ApprovalRequest) => { parkCalls.push(req); return { decisionId: `dec-${++seq}` }; }) });
		setDefaultAuditSink(() => {});
	});

	afterEach(() => {
		(supabase as any).from = origFrom;
		setActionApprovalStore(undefined);
		setDefaultAuditSink(stderrAuditSink);
		vi.restoreAllMocks();
	});

	it("4. entity_bulk_delete with archive_only: false parks > 50 ids or filter rows (even with stray confirm: true) and allows 50 ids", async () => {
		const rows51 = makeIds(51).map((id) => mockRow(id));
		const { fromMock, deleteSpy } = createMockSupabase(rows51);
		(supabase as any).from = fromMock;
		await expect(executeAction(entityBulkDeleteAction, { ids: makeIds(51), archive_only: false }, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(1);
		expect(deleteSpy).not.toHaveBeenCalled();
		await expect(executeAction(entityBulkDeleteAction, { ids: makeIds(51), archive_only: false, confirm: true } as any, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(2);
		expect(deleteSpy).not.toHaveBeenCalled();
		(supabase as any).from = createMockSupabase(makeIds(50).map((id) => mockRow(id))).fromMock;
		expect((await executeAction(entityBulkDeleteAction, { ids: makeIds(50), archive_only: false }, { context: ctx })).count).toBe(50);
		expect(parkCalls).toHaveLength(2);
		(supabase as any).from = createMockSupabase(rows51).fromMock;
		await expect(executeAction(entityBulkDeleteAction, { filter: { entity_type: "concept" }, archive_only: false }, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(3);
	});

	it("5. does not park archive-default deletes or dry_run: true previews", async () => {
		const rows51 = makeIds(51).map((id) => mockRow(id));
		const { fromMock, updateSpy } = createMockSupabase(rows51);
		(supabase as any).from = fromMock;
		const archived = await executeAction(entityBulkDeleteAction, { ids: makeIds(51) }, { context: ctx });
		expect(archived).toMatchObject({ count: 51, archiveOnly: true });
		expect(updateSpy).toHaveBeenCalled();
		const preview = await executeAction(entityBulkDeleteAction, { ids: makeIds(51), archive_only: false, dry_run: true }, { context: ctx });
		expect(preview).toMatchObject({ dryRun: true, count: 51 });
		expect(parkCalls).toHaveLength(0);
	});

	it("6. entity_crud gates delete with id + 50 ids and bulk_delete > 50, and does not gate single delete or query with 60 ids", async () => {
		(supabase as any).from = createMockSupabase(makeIds(51).map((id) => mockRow(id))).fromMock;
		await expect(executeAction(entityCrudAction, { operation: "delete", id: makeId(999), ids: makeIds(50), archive_only: false }, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(1);
		await expect(executeAction(entityCrudAction, { operation: "bulk_delete", ids: makeIds(51), archive_only: false }, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(2);
		(supabase as any).from = createMockSupabase([mockRow(makeId(1))]).fromMock;
		expect((await executeAction(entityCrudAction, { operation: "delete", id: makeId(1), archive_only: false }, { context: ctx })).operation).toBe("delete");
		const queryMock = createMockSupabase([]);
		(supabase as any).from = queryMock.fromMock;
		expect((await executeAction(entityCrudAction, { operation: "query", ids: makeIds(60) }, { context: ctx })).operation).toBe("query");
		expect(parkCalls).toHaveLength(2);
		expect(queryMock.fromMock).toHaveBeenCalledTimes(1);
	});

	it("7. callers on 51-id hard delete: ui is not parked; ui_agent, worker, and internal without approval park", async () => {
		(supabase as any).from = createMockSupabase(makeIds(51).map((id) => mockRow(id))).fromMock;
		expect((await executeAction(entityBulkDeleteAction, { ids: makeIds(51), archive_only: false }, { context: { caller: "ui", userId: "test-user-id" } })).count).toBe(51);
		expect(parkCalls).toHaveLength(0);
		for (const caller of ["ui_agent", "worker", "internal"] as const) {
			await expect(executeAction(entityBulkDeleteAction, { ids: makeIds(51), archive_only: false }, { context: { caller, userId: "test-user-id" } })).rejects.toBeInstanceOf(PendingApprovalError);
		}
		expect(parkCalls).toHaveLength(3);
	});

	it("8. entitiesDeleteHandler forwards extra so 51-id hard delete parks with clientId", async () => {
		const res = await entitiesDeleteHandler({ ids: makeIds(51), archive_only: false }, { authInfo: { token: "t", clientId: "c1", scopes: [] } });
		expect(JSON.parse(res.content[0].text.split("\n")[0])).toEqual({ status: "pending_approval", decision_id: "dec-1", action_id: "entity_delete" });
		expect(parkCalls[0]?.clientId).toBe("c1");
	});

	it("9. person_delete action needsApproval gates > 50 ids or filter rows when archive_only is false", async () => {
		const personDeleteAction = serverRegistry().get("person_delete")!;
		const checkPersonGate = async (input: unknown) => {
			try { await evaluateGate({ actionId: "person_delete", needsApproval: personDeleteAction.needsApproval, input, ctx: { caller: "mcp", requestId: "req-1", userId: "test-user-id" } }); return false; }
			catch (err) { if (isPendingApproval(err)) return true; throw err; }
		};
		expect(await checkPersonGate({ ids: makeIds(51), archive_only: false })).toBe(true);
		expect(await checkPersonGate({ ids: makeIds(50), archive_only: false })).toBe(false);
		expect(await checkPersonGate({ ids: makeIds(51) })).toBe(false);
		(supabase as any).from = createMockSupabase(makeIds(51).map((id) => mockRow(id))).fromMock;
		expect(await checkPersonGate({ filter: { include_archived: true, limit: 100 }, archive_only: false })).toBe(true);
	});

	it("10. parks when Supabase errors while resolving a filter", async () => {
		(supabase as any).from = vi.fn(() => ({ select: () => ({ order: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "db down" } }) }) }) }) }) }));
		await expect(executeAction(entityBulkDeleteAction, { filter: { entity_type: "concept" }, archive_only: false }, { context: ctx })).rejects.toBeInstanceOf(PendingApprovalError);
		expect(parkCalls).toHaveLength(1);
	});
});
