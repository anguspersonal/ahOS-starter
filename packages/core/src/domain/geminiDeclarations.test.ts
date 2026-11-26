import { describe, expect, it } from "vitest";
import { z } from "zod";
import actionManifest from "../../action-manifest.json" with { type: "json" };
import {
  cleanJsonSchema,
  jsonSchemaToGeminiDeclaration,
  zodToGeminiDeclaration,
} from "./geminiDeclarations.js";

function assertNoLowercaseType(obj: unknown) {
  if (!obj || typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;
  if ("type" in record && typeof record.type === "string") {
    expect(record.type).toBe(record.type.toUpperCase());
    expect(["STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"]).toContain(
      record.type,
    );
  }
  for (const val of Object.values(record)) {
    assertNoLowercaseType(val);
  }
}

describe("geminiDeclarations", () => {
  describe("zodToGeminiDeclaration & jsonSchemaToGeminiDeclaration", () => {
    it("converts basic primitive types and uppercase types", () => {
      const schema = z.object({
        str: z.string().describe("A string field"),
        num: z.number().describe("A number field"),
        int: z.number().int().describe("An integer field"),
        bool: z.boolean().describe("A boolean field"),
      });

      const decl = zodToGeminiDeclaration(
        "test_primitives",
        "Test primitive types",
        schema,
      );

      expect(decl.name).toBe("test_primitives");
      expect(decl.description).toBe("Test primitive types");
      expect(decl.parameters.type).toBe("OBJECT");
      expect(decl.parameters.properties).toEqual({
        str: { type: "STRING", description: "A string field" },
        num: { type: "NUMBER", description: "A number field" },
        int: { type: "INTEGER", description: "An integer field" },
        bool: { type: "BOOLEAN", description: "A boolean field" },
      });
      expect(decl.parameters.required).toEqual(["str", "num", "int", "bool"]);
      assertNoLowercaseType(decl);
    });

    it("handles enums and arrays recursively", () => {
      const schema = z.object({
        status: z.enum(["active", "pending", "archived"]).describe("Status value"),
        tags: z.array(z.string()).describe("List of tags"),
      });

      const decl = zodToGeminiDeclaration(
        "test_enum_array",
        "Test enum and array",
        schema,
      );

      expect(decl.parameters.properties.status).toEqual({
        type: "STRING",
        description: "Status value",
        enum: ["active", "pending", "archived"],
      });
      expect(decl.parameters.properties.tags).toEqual({
        type: "ARRAY",
        description: "List of tags",
        items: {
          type: "STRING",
        },
      });
      assertNoLowercaseType(decl);
    });

    it("recursively handles nested objects and arrays", () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            city: z.string(),
            zip: z.number().int(),
          }),
        }),
        items: z.array(
          z.object({
            id: z.string().uuid(),
            score: z.number(),
          }),
        ),
      });

      const decl = zodToGeminiDeclaration(
        "test_nested",
        "Test nested structure",
        schema,
      );

      expect(decl.parameters.type).toBe("OBJECT");
      const userProp = decl.parameters.properties.user as any;
      expect(userProp.type).toBe("OBJECT");
      expect(userProp.properties.name.type).toBe("STRING");
      expect(userProp.properties.address.type).toBe("OBJECT");
      expect(userProp.properties.address.properties.city.type).toBe("STRING");
      expect(userProp.properties.address.properties.zip.type).toBe("INTEGER");

      const itemsProp = decl.parameters.properties.items as any;
      expect(itemsProp.type).toBe("ARRAY");
      expect(itemsProp.items.type).toBe("OBJECT");
      expect(itemsProp.items.properties.id.type).toBe("STRING");
      expect(itemsProp.items.properties.score.type).toBe("NUMBER");

      assertNoLowercaseType(decl);
    });

    it("strips unsupported keywords such as default, additionalProperties, pattern, format", () => {
      const schema = z.object({
        email: z.string().email().default("test@example.com"),
        id: z.string().uuid(),
        extra: z.record(z.string(), z.unknown()),
      });

      const decl = zodToGeminiDeclaration(
        "test_stripping",
        "Test keyword stripping",
        schema,
      );

      const emailProp = decl.parameters.properties.email as any;
      expect(emailProp.type).toBe("STRING");
      expect(emailProp.default).toBeUndefined();
      expect(emailProp.format).toBeUndefined();

      const idProp = decl.parameters.properties.id as any;
      expect(idProp.type).toBe("STRING");
      expect(idProp.format).toBeUndefined();
      expect(idProp.pattern).toBeUndefined();

      const extraProp = decl.parameters.properties.extra as any;
      expect(extraProp.type).toBe("OBJECT");
      expect(extraProp.additionalProperties).toBeUndefined();

      // Because email has default, it should NOT be in required with io: input
      expect(decl.parameters.required).toEqual(["id", "extra"]);
    });

    it("strips exclusiveMinimum and exclusiveMaximum emitted by positive/negative numbers", () => {
      const schema = z.object({
        issue_number: z.number().int().positive().describe("GitHub issue number"),
        neg_val: z.number().negative().optional(),
      });

      const decl = zodToGeminiDeclaration(
        "test_exclusive_bounds",
        "Test exclusive numeric bounds",
        schema,
      );

      expect(decl.parameters.properties.issue_number).toEqual({
        type: "INTEGER",
        description: "GitHub issue number",
      });
      expect(decl.parameters.properties.neg_val).toEqual({
        type: "NUMBER",
      });
      expect(decl.parameters.required).toEqual(["issue_number"]);
      assertNoLowercaseType(decl);
    });

    it("flattens anyOf / oneOf unions across object, scalar+array, and primitive union shapes", () => {
      const objectUnion = cleanJsonSchema({
        anyOf: [
          {
            type: "object",
            properties: {
              collection: { type: "string" },
              op: { type: "string", enum: ["patch"] },
              id: { type: "string" },
              value: { type: "object" },
            },
            required: ["collection", "op", "id", "value"],
          },
          {
            type: "object",
            properties: {
              collection: { type: "string" },
              op: { type: "string", enum: ["upsert"] },
              value: { type: "object" },
            },
            required: ["collection", "op", "value"],
          },
          {
            type: "object",
            properties: {
              collection: { type: "string" },
              op: { type: "string", enum: ["remove"] },
              id: { type: "string" },
            },
            required: ["collection", "op", "id"],
          },
        ],
      });

      expect(objectUnion).toEqual({
        type: "OBJECT",
        properties: {
          collection: { type: "STRING" },
          op: { type: "STRING", enum: ["patch", "upsert", "remove"] },
          id: { type: "STRING" },
          value: { type: "OBJECT", properties: {} },
        },
        required: ["collection", "op"],
      });

      const scalarOrArrayUnion = cleanJsonSchema({
        description: "Single kind or array of kinds",
        anyOf: [
          { type: "string", enum: ["skill", "agent", "command"] },
          {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: ["skill", "agent", "command"] },
          },
        ],
      });

      expect(scalarOrArrayUnion).toEqual({
        type: "ARRAY",
        description: "Single kind or array of kinds",
        items: {
          type: "STRING",
          enum: ["skill", "agent", "command"],
        },
      });

      const primitiveUnion = cleanJsonSchema({
        description: "Cell value",
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "string", nullable: true, enum: [null] },
        ],
      });

      expect(primitiveUnion).toEqual({
        type: "STRING",
        description: "Cell value",
      });
    });

    it("maps unconstrained {} schemas (e.g. z.array(z.unknown())) to STRING", () => {
      const schema = z.object({
        parameters: z.array(z.unknown()).optional().describe("Arguments"),
      });
      const decl = zodToGeminiDeclaration("run_fn", "Run a function", schema);
      expect(decl.parameters.properties.parameters).toEqual({
        type: "ARRAY",
        description: "Arguments",
        items: { type: "STRING" },
      });
    });

    it("throws an error on unsupported keywords such as allOf", () => {
      expect(() => {
        cleanJsonSchema({
          allOf: [{ type: "string" }],
        });
      }).toThrow(/allOf/i);
    });

    it("converts every expose.ui_agent: true action in action-manifest.json without throwing", () => {
      const actions = actionManifest.actions as Record<
        string,
        {
          description: string;
          expose: { ui_agent: boolean };
          input_schema: Record<string, unknown>;
        }
      >;
      const uiAgentEntries = Object.entries(actions).filter(
        ([, entry]) => entry.expose.ui_agent === true,
      );
      expect(uiAgentEntries.length).toBeGreaterThan(0);

      for (const [id, entry] of uiAgentEntries) {
        const decl = jsonSchemaToGeminiDeclaration(
          id,
          entry.description,
          entry.input_schema,
        );
        expect(decl.name).toBe(id);
        expect(decl.description).toBe(entry.description);
        expect(decl.parameters.type).toBe("OBJECT");
        assertNoLowercaseType(decl);
      }
    });

    it("does not mark optional field with default inside nested object as required (relationship_crud filter shape)", () => {
      const filterSchema = z.object({
        entity_id: z.string().uuid().optional(),
        direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both"),
        relationship_type: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      });

      const relationshipCrudLikeSchema = z.object({
        operation: z.enum(["create", "get", "query", "update", "delete"]),
        id: z.string().uuid().optional(),
        filter: filterSchema.optional(),
      });

      const decl = zodToGeminiDeclaration(
        "relationship_crud",
        "CRUD on relationships",
        relationshipCrudLikeSchema,
      );

      expect(decl.parameters.required).toEqual(["operation"]);

      const filterProp = decl.parameters.properties.filter as any;
      expect(filterProp.type).toBe("OBJECT");
      const filterRequired = filterProp.required ?? [];
      expect(filterRequired).not.toContain("direction");
      expect(filterRequired).not.toContain("limit");
      expect(filterRequired).toEqual([]);
    });

    it("verifies ADR-105 R8 amendment parity: zodToGeminiDeclaration matches jsonSchemaToGeminiDeclaration(z.toJSONSchema(...))", () => {
      const relationshipRoleEnum = z.enum(["parent", "child", "sibling", "custom"]);
      const relationshipCrudSchema = z.object({
        operation: z.enum(["create", "get", "query", "update", "delete"]),
        id: z.string().uuid().optional(),
        from_entity_id: z.string().uuid().optional(),
        to_entity_id: z.string().uuid().optional(),
        relationship_type: z.string().min(1).optional(),
        role: relationshipRoleEnum.optional(),
        confidence_score: z.number().min(0).max(1).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        filter: z
          .object({
            entity_id: z.string().uuid().optional(),
            direction: z.enum(["outgoing", "incoming", "both"]).optional().default("both"),
            relationship_type: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional().default(50),
          })
          .optional(),
      });

      const name = "relationship_crud";
      const desc = "Perform CRUD operations on entity relationship edges";

      const fromZod = zodToGeminiDeclaration(name, desc, relationshipCrudSchema);
      const jsonSchema = z.toJSONSchema(relationshipCrudSchema, {
        target: "openapi-3.0",
        io: "input",
      });
      const fromJsonSchema = jsonSchemaToGeminiDeclaration(name, desc, jsonSchema);

      expect(fromZod).toEqual(fromJsonSchema);
    });

    it("throws on unknown or missing type or non-object schemas", () => {
      expect(() => cleanJsonSchema(null)).toThrow(/must be an object/i);
      expect(() => cleanJsonSchema("string")).toThrow(/must be an object/i);
      expect(() => cleanJsonSchema({})).toThrow(/unknown or missing type/i);
      expect(() => cleanJsonSchema({ type: "unknown_type" })).toThrow(
        /unknown or missing type/i,
      );
      expect(() =>
        jsonSchemaToGeminiDeclaration("test", "test", { type: "string" }),
      ).toThrow(/parameters must have type OBJECT/i);
      expect(() => jsonSchemaToGeminiDeclaration("", "test", { type: "object" })).toThrow(
        /valid string "name"/i,
      );
      expect(() => jsonSchemaToGeminiDeclaration("test", "", { type: "object" })).toThrow(
        /valid string "description"/i,
      );
    });
  });
});
