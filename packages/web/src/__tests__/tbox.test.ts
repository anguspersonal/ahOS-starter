import { describe, expect, it } from "vitest";
import { isTBoxEntity, formatTypeLabel, TBOX_TYPE, TBOX_BADGE } from "../components/graph/tbox.js";

describe("T-box Entity Detection & Formatting (in properties)", () => {
  it("detects T-box from in_box, inBox, or box property", () => {
    expect(isTBoxEntity({ properties: { in_box: "TBox" } })).toBe(true);
    expect(isTBoxEntity({ properties: { in_box: "tbox" } })).toBe(true);
    expect(isTBoxEntity({ properties: { inBox: "TBox" } })).toBe(true);
    expect(isTBoxEntity({ properties: { box: "tbox" } })).toBe(true);
    expect(isTBoxEntity({ properties: { in_box: "ABox" } })).toBe(false);
  });

  it("detects T-box from boolean flags in properties", () => {
    expect(isTBoxEntity({ properties: { tbox: true } })).toBe(true);
    expect(isTBoxEntity({ properties: { is_tbox: true } })).toBe(true);
    expect(isTBoxEntity({ properties: { is_t_box: true } })).toBe(true);
    expect(isTBoxEntity({ properties: { t_box: true } })).toBe(true);
    expect(isTBoxEntity({ properties: { "T-box": true } })).toBe(true);
    expect(isTBoxEntity({ properties: { "t-box": true } })).toBe(true);
    expect(isTBoxEntity({ properties: { tbox: false } })).toBe(false);
  });

  it("detects T-box from ontology or meta level in properties (ADR-036 §1)", () => {
    expect(isTBoxEntity({ properties: { level: "ontology" } })).toBe(true);
    expect(isTBoxEntity({ properties: { level: "meta" } })).toBe(true);
    expect(isTBoxEntity({ properties: { level: "instance" } })).toBe(false);
  });

  it("detects T-box from vocabulary term properties (ADR-036 / ADR-037)", () => {
    expect(isTBoxEntity({ properties: { type: "ahos_concept_term" } })).toBe(true);
    expect(isTBoxEntity({ properties: { applies_to: "entity_type" } })).toBe(true);
    expect(isTBoxEntity({ properties: { applies_to: "edge_type" } })).toBe(true);
    expect(isTBoxEntity({ properties: { applies_to: "kind" } })).toBe(true);
  });

  it("detects T-box from ontology namespace rows (ADR-037 §2)", () => {
    expect(isTBoxEntity({ properties: { type: "ahos_namespace" } })).toBe(true);
    expect(
      isTBoxEntity({
        properties: {
          prefix: "ahos",
          namespace_iri: "https://example.com/ahos-ontology#",
        },
      })
    ).toBe(true);
  });

  it("detects T-box from tags or entity_type", () => {
    expect(isTBoxEntity({ entity_type: "term", properties: {} })).toBe(true);
    expect(isTBoxEntity({ entity_type: "namespace", properties: {} })).toBe(true);
    expect(isTBoxEntity({ entity_type: "schema", properties: {} })).toBe(true);
    expect(isTBoxEntity({ tags: ["tbox"], properties: {} })).toBe(true);
    expect(isTBoxEntity({ tags: ["ontology"], properties: {} })).toBe(true);
  });

  it("returns false for non-T-box entities or missing properties", () => {
    expect(isTBoxEntity(null)).toBe(false);
    expect(isTBoxEntity(undefined)).toBe(false);
    expect(isTBoxEntity({})).toBe(false);
    expect(isTBoxEntity({ properties: null })).toBe(false);
    expect(isTBoxEntity({ properties: { zoom_level: 1, group: "Strategy" } })).toBe(false);
  });

  it("formats type label for display", () => {
    expect(formatTypeLabel("t-box")).toBe("T-box");
    expect(formatTypeLabel("tbox")).toBe("T-box");
    expect(formatTypeLabel("T-box")).toBe("T-box");
    expect(formatTypeLabel("project")).toBe("project");
    expect(formatTypeLabel("concept")).toBe("concept");
  });

  it("exports TBOX_TYPE and TBOX_BADGE constants", () => {
    expect(TBOX_TYPE).toBe("t-box");
    expect(TBOX_BADGE.icon).toBe("🏛️");
    expect(TBOX_BADGE.label).toBe("T-box");
    expect(TBOX_BADGE.text).toContain("purple");
  });

  it("identifies T-box nodes correctly within FALLBACK_NODES dataset", async () => {
    const { FALLBACK_NODES } = await import("../components/graph/graphData.js");
    const tboxNodes = FALLBACK_NODES.filter(isTBoxEntity);
    expect(tboxNodes.length).toBeGreaterThanOrEqual(4);

    const tboxIds = tboxNodes.map((n) => n.id);
    expect(tboxIds).toContain("e-adr100");
    expect(tboxIds).toContain("e-foaf-graph");
    expect(tboxIds).toContain("e-term-arrangement");
    expect(tboxIds).toContain("e-ns-ahos");

    // Standard non-T-box instances should not match
    const personNode = FALLBACK_NODES.find((n) => n.id === "e-angus");
    expect(isTBoxEntity(personNode)).toBe(false);

    const projectNode = FALLBACK_NODES.find((n) => n.id === "e-ahos-core");
    expect(isTBoxEntity(projectNode)).toBe(false);
  });

  it("filters correctly when 't-box' pseudo-type is selected", async () => {
    const { FALLBACK_NODES } = await import("../components/graph/graphData.js");
    const selectedTypes = new Set(["t-box"]);

    const filtered = FALLBACK_NODES.filter((node) => {
      const matchesBaseType = selectedTypes.has(node.entity_type);
      const matchesTBox = (selectedTypes.has("t-box") || selectedTypes.has("T-box")) && isTBoxEntity(node);
      return matchesBaseType || matchesTBox;
    });

    expect(filtered.length).toBeGreaterThanOrEqual(4);
    for (const n of filtered) {
      expect(isTBoxEntity(n)).toBe(true);
    }
  });
});
