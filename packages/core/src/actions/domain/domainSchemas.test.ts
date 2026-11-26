import { describe, it, expect } from "vitest";
import {
	DOMAINS,
	DOMAIN_DESCRIPTION,
	ENTITY_TYPES,
	createSchema,
	entityCrudSchema,
	sanitizeEntityRow,
	decisionReviewSchema,
	taskCrudSchema,
} from "../../index.js";

describe("Domain Schemas & Action Contracts (@ahkms/core)", () => {
	describe("Domains Boundary (ADR-051, ADR-054)", () => {
		it("exports the canonical flat domains array", () => {
			expect(DOMAINS).toEqual(["work", "angus"]);
		});

		it("exports the canonical domain description string", () => {
			expect(DOMAIN_DESCRIPTION).toContain("work");
			expect(DOMAIN_DESCRIPTION).toContain("angus");
		});
	});

	describe("Entity CRUD Schema & Sanitization (ADR-100)", () => {
		it("validates a valid create operation", () => {
			const parsed = entityCrudSchema.parse({
				operation: "create",
				entities: [
					{
						title: "Test System Entity",
						entity_type: "project",
						description: "A test system description",
					},
				],
			});
			expect(parsed.operation).toBe("create");
			expect(parsed.entities).toHaveLength(1);
			expect(parsed.entities?.[0].title).toBe("Test System Entity");
		});

		it("accepts 'decision' in createSchema and exposes the 14 canonical ENTITY_TYPES (#2003)", () => {
			expect(ENTITY_TYPES).toHaveLength(14);
			expect(ENTITY_TYPES).toContain("decision");

			const parsed = createSchema.parse({
				entities: [{ title: "Use ADR-113 boundary", entity_type: "decision" }],
			});
			expect(parsed.entities[0].entity_type).toBe("decision");
		});

		it("rejects invalid entity_type in createSchema with a Zod enum error listing the 14 allowed values (#2003)", () => {
			const result = createSchema.safeParse({
				entities: [{ title: "Bad", entity_type: "invalid_type" }],
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const message = result.error.message;
				for (const allowedType of ENTITY_TYPES) {
					expect(message).toContain(allowedType);
				}
			}
		});

		it("validates a query operation with filters", () => {
			const parsed = entityCrudSchema.parse({
				operation: "query",
				query: "Work",
				domain: "work",
				include_properties: true,
				limit: 10,
			});
			expect(parsed.operation).toBe("query");
			expect(parsed.query).toBe("Work");
			expect(parsed.domain).toBe("work");
			expect(parsed.include_properties).toBe(true);
			expect(parsed.limit).toBe(10);
		});

		it("validates an update operation with patch", () => {
			const parsed = entityCrudSchema.parse({
				operation: "update",
				id: "11111111-2222-4333-8444-555555555555",
				patch: {
					title: "Updated Title",
					description: "New description",
				},
			});
			expect(parsed.operation).toBe("update");
			expect(parsed.id).toBe("11111111-2222-4333-8444-555555555555");
			expect(parsed.patch?.title).toBe("Updated Title");
		});

		it("rejects invalid operation names", () => {
			expect(() =>
				entityCrudSchema.parse({
					operation: "invalid_op",
				}),
			).toThrow();
		});

		it("sanitizeEntityRow strips heavy vector embeddings and truncates descriptions", () => {
			const rawRow = {
				id: "test-uuid",
				title: "Node with Vectors",
				description: "Z".repeat(700),
				embedding: Array(1536).fill(0.123),
				search_vector: "'node':1 'vector':2",
				properties: {
					category: "test",
					long_field: "W".repeat(400),
				},
			};

			const cleaned = sanitizeEntityRow(rawRow);
			expect(cleaned.id).toBe("test-uuid");
			expect(cleaned.title).toBe("Node with Vectors");
			expect(cleaned.embedding).toBeUndefined();
			expect(cleaned.search_vector).toBeUndefined();
			expect((cleaned.description as string).endsWith("... [truncated]")).toBe(true);
			expect((cleaned.description as string).length).toBeLessThan(520);

			const props = cleaned.properties as Record<string, unknown>;
			expect(props.category).toBe("test");
			expect((props.long_field as string).endsWith("... [truncated]")).toBe(true);
			expect((props.long_field as string).length).toBeLessThan(320);
		});
	});

	describe("Governance Decision Review Schema (ADR-100)", () => {
		it("validates list_pending operation", () => {
			const parsed = decisionReviewSchema.parse({
				operation: "list_pending",
				stage: "extract",
				blocking_only: true,
				limit: 25,
			});
			expect(parsed.operation).toBe("list_pending");
			expect(parsed.stage).toBe("extract");
			expect(parsed.blocking_only).toBe(true);
		});

		it("validates approve and reject operations", () => {
			const approve = decisionReviewSchema.parse({
				operation: "approve",
				id: "22222222-3333-4444-8555-666666666666",
				resolution_notes: "Approved after human inspection",
			});
			expect(approve.operation).toBe("approve");
			expect(approve.resolution_notes).toBe("Approved after human inspection");

			const reject = decisionReviewSchema.parse({
				operation: "reject",
				id: "22222222-3333-4444-8555-666666666666",
				resolution_notes: "Rejected due to invalid ground truth",
			});
			expect(reject.operation).toBe("reject");
		});

		it("validates modify_and_approve with payload patch", () => {
			const parsed = decisionReviewSchema.parse({
				operation: "modify_and_approve",
				id: "22222222-3333-4444-8555-666666666666",
				resolution_data: { confidence_override: 0.95 },
			});
			expect(parsed.operation).toBe("modify_and_approve");
			expect(parsed.resolution_data).toEqual({ confidence_override: 0.95 });
		});
	});

	describe("Task CRUD Schema (ADR-100)", () => {
		it("validates task creation", () => {
			const parsed = taskCrudSchema.parse({
				operation: "create",
				title: "Complete Strangler Fig Migration",
				priority: "high",
				status: "in_progress",
				tags: ["architecture", "refactor"],
			});
			expect(parsed.operation).toBe("create");
			expect(parsed.title).toBe("Complete Strangler Fig Migration");
			expect(parsed.priority).toBe("high");
			expect(parsed.status).toBe("in_progress");
		});

		it("validates task query and completion", () => {
			const query = taskCrudSchema.parse({
				operation: "query",
				query: "Strangler",
				status: "todo",
			});
			expect(query.operation).toBe("query");
			expect(query.query).toBe("Strangler");

			const complete = taskCrudSchema.parse({
				operation: "complete",
				id: "33333333-4444-4555-8666-777777777777",
			});
			expect(complete.operation).toBe("complete");
			expect(complete.id).toBe("33333333-4444-4555-8666-777777777777");
		});
	});
});
