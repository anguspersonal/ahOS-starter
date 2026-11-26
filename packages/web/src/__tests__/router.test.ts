import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getTabFromPathname,
  navigateToTab,
  TAB_PATHS,
} from "../lib/router.js";

describe("Web Router & Tab Path Persistence", () => {
  let mockWindow: {
    location: {
      pathname: string;
      search: string;
      hash: string;
      origin: string;
      href: string;
    };
    history: {
      pushState: ReturnType<typeof vi.fn>;
      replaceState: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    mockWindow = {
      location: {
        pathname: "/",
        search: "",
        hash: "",
        origin: "http://localhost:5173",
        href: "http://localhost:5173/",
      },
      history: {
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    };
    vi.stubGlobal("window", mockWindow);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps canonical paths to tab identifiers", () => {
    expect(TAB_PATHS.documents).toBe("/living-docs");
    expect(TAB_PATHS.decisions).toBe("/decisions");
    expect(TAB_PATHS.approvals).toBe("/approvals");
    expect(TAB_PATHS.fresh).toBe("/fresh");
    expect(TAB_PATHS.dashboard).toBe("/dashboard");
    expect(TAB_PATHS.chat).toBe("/chat");
    expect(TAB_PATHS["visual-meaning"]).toBe("/visual-meaning");
    expect(TAB_PATHS.graph).toBe("/graph");
    expect(TAB_PATHS["job-hunt"]).toBe("/job-hunt");
  });

  it("resolves exact tab from canonical pathname", () => {
    expect(getTabFromPathname("/living-docs")).toBe("documents");
    expect(getTabFromPathname("/visual-meaning")).toBe("visual-meaning");
    expect(getTabFromPathname("/decisions")).toBe("decisions");
    expect(getTabFromPathname("/approvals")).toBe("approvals");
    expect(getTabFromPathname("/fresh")).toBe("fresh");
    expect(getTabFromPathname("/dashboard")).toBe("dashboard");
    expect(getTabFromPathname("/chat")).toBe("chat");
    expect(getTabFromPathname("/graph")).toBe("graph");
    expect(getTabFromPathname("/job-hunt")).toBe("job-hunt");
  });

  it("resolves supported path aliases", () => {
    expect(getTabFromPathname("/documents")).toBe("documents");
    expect(getTabFromPathname("/decision-backlog")).toBe("decisions");
    expect(getTabFromPathname("/knowledge-graph")).toBe("graph");
    expect(getTabFromPathname("/entities-graph")).toBe("graph");
    expect(getTabFromPathname("/jobhunt")).toBe("job-hunt");
    expect(getTabFromPathname("/")).toBe("documents");
  });

  it("normalizes trailing slashes properly", () => {
    expect(getTabFromPathname("/living-docs/")).toBe("documents");
    expect(getTabFromPathname("/visual-meaning/")).toBe("visual-meaning");
    expect(getTabFromPathname("/job-hunt/")).toBe("job-hunt");
    expect(getTabFromPathname("/fresh///")).toBe("fresh");
  });

  it("falls back to 'documents' for unknown paths", () => {
    expect(getTabFromPathname("/unknown-path")).toBe("documents");
    expect(getTabFromPathname("")).toBe("documents");
  });

  it("reads from window.location.pathname when no argument is provided", () => {
    mockWindow.location.pathname = "/visual-meaning";
    expect(getTabFromPathname()).toBe("visual-meaning");

    mockWindow.location.pathname = "/living-docs";
    expect(getTabFromPathname()).toBe("documents");
  });

  it("calls history.pushState when navigating to a new tab", () => {
    mockWindow.location.pathname = "/living-docs";

    navigateToTab("visual-meaning");
    expect(mockWindow.history.pushState).toHaveBeenCalledWith(null, "", "/visual-meaning");
  });

  it("calls history.replaceState when replace flag is true", () => {
    mockWindow.location.pathname = "/";

    navigateToTab("visual-meaning", true);
    expect(mockWindow.history.replaceState).toHaveBeenCalledWith(null, "", "/visual-meaning");
  });

  it("does not push redundant state if already on the same path", () => {
    mockWindow.location.pathname = "/visual-meaning";

    navigateToTab("visual-meaning");
    expect(mockWindow.history.pushState).not.toHaveBeenCalled();
  });
});
