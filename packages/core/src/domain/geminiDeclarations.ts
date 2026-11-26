import { z } from "zod";

/**
 * Supported Gemini schema data types.
 */
export type GeminiType =
  | "STRING"
  | "NUMBER"
  | "INTEGER"
  | "BOOLEAN"
  | "ARRAY"
  | "OBJECT";

/**
 * Gemini-compatible schema representation for function declaration parameters.
 */
export interface GeminiSchema {
  type: GeminiType | string;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  enum?: string[];
  [key: string]: unknown;
}

/**
 * Gemini tool function declaration shape.
 */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema & {
    type: "OBJECT";
    properties: Record<string, unknown>;
  };
}

const ALLOWED_KEYS = new Set([
  "type",
  "description",
  "enum",
  "items",
  "properties",
  "required",
]);

const DROP_KEYS = new Set([
  "$schema",
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "default",
  "nullable",
]);

const UNION_KEYS = new Set(["anyOf", "oneOf"]);

const TYPE_MAP: Record<string, GeminiType> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
};

function isNullBranch(branch: Record<string, unknown>): boolean {
  if (typeof branch.type === "string" && branch.type.toLowerCase() === "null") {
    return true;
  }
  if (
    branch.nullable === true &&
    Array.isArray(branch.enum) &&
    branch.enum.length === 1 &&
    branch.enum[0] === null
  ) {
    return true;
  }
  return false;
}

function flattenUnionSchema(schema: Record<string, unknown>): GeminiSchema {
  const rawBranches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    throw new Error(`Union keyword ("anyOf"/"oneOf") must be a non-empty array`);
  }

  for (const b of rawBranches) {
    if (!b || typeof b !== "object" || Array.isArray(b)) {
      throw new Error(`Union branch must be an object, received: ${typeof b}`);
    }
  }

  const nonNullBranches = (rawBranches as Record<string, unknown>[]).filter(
    (b) => !isNullBranch(b),
  );
  const description =
    schema.description !== undefined ? String(schema.description) : undefined;

  if (
    nonNullBranches.length > 0 &&
    nonNullBranches.every(
      (b) => typeof b.type === "string" && TYPE_MAP[b.type] === "OBJECT",
    )
  ) {
    const cleanedBranches = nonNullBranches.map((b) => cleanJsonSchema(b));
    const mergedProperties: Record<string, GeminiSchema> = {};

    for (const branch of cleanedBranches) {
      for (const [propKey, propSchema] of Object.entries(branch.properties ?? {})) {
        const existing = mergedProperties[propKey];
        if (!existing) {
          mergedProperties[propKey] = { ...propSchema };
        } else if (existing.enum && propSchema.enum) {
          mergedProperties[propKey] = {
            ...existing,
            enum: Array.from(new Set([...existing.enum, ...propSchema.enum])),
          };
        } else if (existing.enum || propSchema.enum) {
          const { enum: _dropped, ...rest } = existing;
          mergedProperties[propKey] = rest;
        }
      }
    }

    const firstRequired = cleanedBranches[0].required ?? [];
    const otherRequiredSets = cleanedBranches
      .slice(1)
      .map((b) => new Set(b.required ?? []));
    const requiredIntersection = firstRequired.filter((key) =>
      otherRequiredSets.every((set) => set.has(key)),
    );

    const result: GeminiSchema = {
      type: "OBJECT",
      ...(description !== undefined ? { description } : {}),
      properties: mergedProperties,
    };
    if (requiredIntersection.length > 0) {
      result.required = requiredIntersection;
    }
    return result;
  }

  const arrayBranch = nonNullBranches.find(
    (b) => typeof b.type === "string" && TYPE_MAP[b.type] === "ARRAY",
  );
  const hasScalarBranch = nonNullBranches.some((b) => {
    const mapped = typeof b.type === "string" ? TYPE_MAP[b.type] : undefined;
    return (
      mapped === "STRING" ||
      mapped === "NUMBER" ||
      mapped === "INTEGER" ||
      mapped === "BOOLEAN"
    );
  });

  if (arrayBranch && hasScalarBranch) {
    const cleanedArray = cleanJsonSchema(arrayBranch);
    if (description !== undefined && cleanedArray.description === undefined) {
      cleanedArray.description = description;
    }
    return cleanedArray;
  }

  for (const branch of nonNullBranches) {
    cleanJsonSchema(branch);
  }

  return {
    type: "STRING",
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Clean and convert a JSON Schema into a Gemini-compatible Schema format.
 * - Uppercases `type` (e.g. "string" -> "STRING")
 * - Filters down to allowed keys: type, description, enum, items, properties, required
 * - Drops unsupported keys: $schema, additionalProperties, pattern, format, minLength, maxLength, minItems, maxItems, minimum, maximum, exclusiveMinimum, exclusiveMaximum, default, nullable
 * - Flattens anyOf / oneOf unions into a single Gemini-compatible schema
 * - Throws on unsupported schema constructs (e.g. allOf) or unknown/missing types
 * - Recursively cleans nested schemas in properties and items
 */
export function cleanJsonSchema(raw: unknown): GeminiSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Schema must be an object, received: ${typeof raw}`);
  }

  const schema = raw as Record<string, unknown>;

  // Check for disallowed/unexpected keywords first
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYS.has(key) && !DROP_KEYS.has(key) && !UNION_KEYS.has(key)) {
      throw new Error(
        `Unsupported schema keyword: "${key}" (Gemini function declarations do not support unions or complex schema combinations)`,
      );
    }
  }

  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    return flattenUnionSchema(schema);
  }

  if (!schema.type || typeof schema.type !== "string" || !TYPE_MAP[schema.type]) {
    throw new Error(
      `Unknown or missing type: "${String(schema.type)}" in schema`,
    );
  }

  const cleanType = TYPE_MAP[schema.type];
  const result: GeminiSchema = {
    type: cleanType,
  };

  if (schema.description !== undefined) {
    result.description = String(schema.description);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      throw new Error(`"enum" must be an array`);
    }
    result.enum = schema.enum.map(String);
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      throw new Error(`"required" must be an array of property names`);
    }
    if (schema.required.length > 0) {
      result.required = schema.required.map(String);
    }
  }

  if (cleanType === "OBJECT") {
    result.properties = {};
    if (schema.properties !== undefined) {
      if (
        typeof schema.properties !== "object" ||
        schema.properties === null ||
        Array.isArray(schema.properties)
      ) {
        throw new Error(`"properties" must be an object`);
      }
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = cleanJsonSchema(value);
      }
    }
  } else if (cleanType === "ARRAY") {
    if (schema.items === undefined) {
      throw new Error(`Array schema is missing "items" definition`);
    }
    if (
      typeof schema.items === "object" &&
      schema.items !== null &&
      !Array.isArray(schema.items) &&
      (schema.items as Record<string, unknown>).type === undefined &&
      (schema.items as Record<string, unknown>).anyOf === undefined &&
      (schema.items as Record<string, unknown>).oneOf === undefined &&
      Object.keys(schema.items as Record<string, unknown>).every(
        (k) => k === "description" || DROP_KEYS.has(k),
      )
    ) {
      result.items = { type: "STRING" };
      if ((schema.items as Record<string, unknown>).description !== undefined) {
        result.items.description = String(
          (schema.items as Record<string, unknown>).description,
        );
      }
    } else {
      result.items = cleanJsonSchema(schema.items);
    }
  }

  return result;
}

/**
 * Converts a JSON Schema object into a GeminiFunctionDeclaration.
 */
export function jsonSchemaToGeminiDeclaration(
  name: string,
  description: string,
  jsonSchema: unknown,
): GeminiFunctionDeclaration {
  if (!name || typeof name !== "string") {
    throw new Error(`Function declaration must have a valid string "name"`);
  }
  if (!description || typeof description !== "string") {
    throw new Error(`Function declaration must have a valid string "description"`);
  }

  const cleaned = cleanJsonSchema(jsonSchema);
  if (cleaned.type !== "OBJECT") {
    throw new Error(
      `Gemini function parameters must have type OBJECT, received: ${cleaned.type}`,
    );
  }

  const parameters: GeminiSchema & {
    type: "OBJECT";
    properties: Record<string, unknown>;
  } = {
    type: "OBJECT",
    properties: cleaned.properties ?? {},
  };

  if (cleaned.required && cleaned.required.length > 0) {
    parameters.required = cleaned.required;
  }

  if (cleaned.description) {
    parameters.description = cleaned.description;
  }

  return {
    name,
    description,
    parameters,
  };
}

/**
 * Converts a Zod schema into a GeminiFunctionDeclaration.
 * Emits OpenAPI 3.0 JSON schema with input IO semantics (optional fields with defaults are not required),
 * then cleans and structures into Gemini's expected format.
 */
export function zodToGeminiDeclaration(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
): GeminiFunctionDeclaration {
  const jsonSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" });
  return jsonSchemaToGeminiDeclaration(name, description, jsonSchema);
}
