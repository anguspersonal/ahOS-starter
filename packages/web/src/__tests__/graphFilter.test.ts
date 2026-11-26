import { describe, it, expect, afterEach } from "vitest";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import { registerGraphFilterListener } from "../lib/graphActions.js";

describe("graph_filter action", () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  });

  it("rejects when no listener is registered", async () => {
    await expect(
      defaultClientActionRegistry.execute("graph_filter", { query: "x" }),
    ).rejects.toThrow(/no active graph view/i);
  });

  it("rejects when a listener throws", async () => {
    unsubscribe = registerGraphFilterListener(() => {
      throw new Error("Canvas render error");
    });

    await expect(
      defaultClientActionRegistry.execute("graph_filter", { query: "x" }),
    ).rejects.toThrow("Canvas render error");
  });

  it("rejects when passed unknown keys like tags or hot_only", async () => {
    unsubscribe = registerGraphFilterListener(() => {});

    await expect(
      defaultClientActionRegistry.execute("graph_filter", { tags: ["a"] } as any),
    ).rejects.toThrow();

    await expect(
      defaultClientActionRegistry.execute("graph_filter", { hot_only: true } as any),
    ).rejects.toThrow();
  });
});
