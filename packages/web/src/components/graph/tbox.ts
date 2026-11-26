
/**
 * Pseudo entity-type identifier for T-Box entities.
 * Treated in the UI "as if it's an entity type", while derived dynamically
 * from the entity's `properties` JSON.
 */
export const TBOX_TYPE = "t-box";

/**
 * Visual styling and iconography for the T-box pill.
 */
export const TBOX_BADGE = {
  bg: "bg-purple-950/80",
  text: "text-purple-300",
  border: "border-purple-600/50",
  icon: "🏛️",
  label: "T-box",
} as const;

/**
 * Format an entity type key for display in chips, badges, and dropdowns.
 * Displays "T-box" for "t-box" or "tbox", while preserving standard types.
 */
export function formatTypeLabel(type: string): string {
  const lower = type.toLowerCase();
  if (lower === "t-box" || lower === "tbox" || lower === "t_box") {
    return "T-box";
  }
  return type;
}

/**
 * Checks whether an entity belongs to the T-Box (Terminological / Schema Box)
 * based on its `properties` JSON (per ADR-036 §1, ADR-037 §1).
 *
 * In the ahOS ontology architecture:
 *   - TBox (Terminological Box): schema, classes, concepts, vocabulary term definitions,
 *     and governing principles.
 *   - ABox (Assertional Box): concrete instances and individual assertions.
 *
 * Supported property indicators:
 *   1. `properties.in_box` / `inBox` / `box` equal to "TBox" (case-insensitive)
 *   2. `properties.tbox` / `is_tbox` / `is_t_box` / `t_box` / `T-box` / `t-box` equal to true or "TBox"
 *   3. `properties.level` equal to "ontology" or "meta" (ADR-036 §1: meta/ontology correlate with T-Box)
 *   4. `properties.type` equal to "ahos_concept_term" (vocabulary term nodes grounding schema terms)
 *   5. `properties.applies_to` equal to "entity_type" or "edge_type" (term definitions)
 */
export function isTBoxEntity(
  node: {
    entity_type?: string | null;
    tags?: string[] | null;
    properties?: Record<string, unknown> | null;
  } | null | undefined
): boolean {
  if (!node) return false;

  // 1. Entity type check (e.g. if an entity is explicitly typed as term / schema / namespace / ontology)
  if (typeof node.entity_type === "string") {
    const et = node.entity_type.toLowerCase();
    if (et === "term" || et === "schema" || et === "namespace" || et === "ontology") {
      return true;
    }
  }

  // 2. Tags check (e.g. ["tbox", "ontology", "schema", "taxonomy", "namespace"])
  if (Array.isArray(node.tags)) {
    const tboxTags = new Set([
      "tbox",
      "t-box",
      "t_box",
      "ontology",
      "meta",
      "schema",
      "vocabulary",
      "taxonomy",
      "namespace",
    ]);
    if (node.tags.some((t) => typeof t === "string" && tboxTags.has(t.toLowerCase()))) {
      return true;
    }
  }

  if (!node.properties || typeof node.properties !== "object") {
    return false;
  }

  const p = node.properties as Record<string, unknown>;

  // 3. in_box / inBox / box / box_type (case-insensitive, handling tbox, t-box, t_box)
  const boxVal = p.in_box ?? p.inBox ?? p.box ?? p.box_type;
  if (typeof boxVal === "string") {
    const cleaned = boxVal.toLowerCase().replace(/[-_]/g, "");
    if (cleaned === "tbox") {
      return true;
    }
  }

  // 4. Boolean flags (tbox, is_tbox, is_t_box, t_box, "T-box", "t-box")
  if (
    p.tbox === true ||
    p.is_tbox === true ||
    p.is_t_box === true ||
    p.t_box === true ||
    p["T-box"] === true ||
    p["t-box"] === true
  ) {
    return true;
  }

  // 5. String flags for t_box
  const tBoxStr = p.t_box ?? p["T-box"] ?? p["t-box"];
  if (typeof tBoxStr === "string") {
    const cleaned = tBoxStr.toLowerCase().replace(/[-_]/g, "");
    if (cleaned === "tbox") {
      return true;
    }
  }

  // 6. Level / Layer indicator (ontology / meta / schema per ADR-036 §1)
  const lvl = p.level ?? p.layer;
  if (typeof lvl === "string") {
    const lower = lvl.toLowerCase();
    if (
      lower === "ontology" ||
      lower === "meta" ||
      lower === "schema" ||
      lower === "tbox" ||
      lower === "t-box"
    ) {
      return true;
    }
  }

  // 7. Canonical namespace ontology rows (ADR-037 §2, Migration 078)
  if (
    p.type === "ahos_namespace" ||
    (typeof p.prefix === "string" && typeof p.namespace_iri === "string")
  ) {
    return true;
  }

  // 8. Vocabulary term nodes grounding schema terms (ADR-036 §1, Migration 081)
  if (
    p.type === "ahos_concept_term" ||
    p.type === "term" ||
    p.type === "ontology_term" ||
    p.type === "concept_scheme" ||
    p.applies_to === "entity_type" ||
    p.applies_to === "edge_type" ||
    p.applies_to === "kind"
  ) {
    return true;
  }

  // 9. Vocabulary grounding term identifiers (term + local_name / iri / namespace)
  if (typeof p.term === "string" && (typeof p.local_name === "string" || typeof p.iri === "string")) {
    return true;
  }

  return false;
}
