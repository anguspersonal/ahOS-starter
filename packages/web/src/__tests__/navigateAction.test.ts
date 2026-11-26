import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/supabase.js", () => ({
  supabase: {},
}));

import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import {
  getTabFromPathname,
  registerTabChangeListener,
  type ActiveTab,
} from "../lib/router.js";
import {
  getPendingEntitySelection,
  getScreenState,
  registerGraphEntitySelectionListener,
  resetScreenStateForTesting,
  setScreenTab,
} from "../lib/screenState.js";
import {
  executeNavigate,
  registerSettingsNavigationRoutes,
  type NavigateInput,
  type NavigateOutput,
} from "../lib/navigateAction.js";

describe("navigate client action (#1453)", () => {
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
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetScreenStateForTesting();
    mockWindow = {
      location: {
        pathname: "/chat",
        search: "",
        hash: "",
        origin: "http://localhost:5173",
        href: "http://localhost:5173/chat",
      },
      history: {
        pushState: vi.fn((_state, _title, url) => {
          if (typeof url === "string") {
            mockWindow.location.pathname = url;
          }
        }),
        replaceState: vi.fn((_state, _title, url) => {
          if (typeof url === "string") {
            mockWindow.location.pathname = url;
          }
        }),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("window", mockWindow);
  });

  afterEach(() => {
    resetScreenStateForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Case 1: calling navigate({ tab: 'graph' }) when a tab listener is registered updates the active tab and browser history and returns { success: true }", async () => {
    let activeTab: ActiveTab = "chat";
    setScreenTab("chat");

    const unsubscribe = registerTabChangeListener((tab) => {
      activeTab = tab;
      setScreenTab(tab);
    });

    try {
      const result = await defaultClientActionRegistry.execute<
        NavigateInput,
        NavigateOutput
      >("navigate", { tab: "graph" });

      expect(result.success).toBe(true);
      expect(result.tab).toBe("graph");
      expect(result.path).toBe("/graph");
      expect(activeTab).toBe("graph");
      expect(mockWindow.history.pushState).toHaveBeenCalledWith(null, "", "/graph");
      expect(getScreenState()?.tab).toBe("graph");
    } finally {
      unsubscribe();
    }
  });

  it("Case 2: calling navigate({ tab: 'graph', entity_id: '<uuid>' }) from the Chat tab switches to the Graph tab, stores the pending selection in screenState, and applies the selection when EntityGraphCanvas mounts and registers its selection listener", async () => {
    let activeTab: ActiveTab = "chat";
    setScreenTab("chat");

    const unsubscribeTab = registerTabChangeListener((tab) => {
      activeTab = tab;
      setScreenTab(tab);
    });

    const targetEntityId = "11111111-2222-4333-a444-555555555555";

    try {
      const result = await executeNavigate({
        tab: "graph",
        entity_id: targetEntityId,
      });

      expect(result.success).toBe(true);
      expect(result.tab).toBe("graph");
      expect(result.entity_id).toBe(targetEntityId);
      expect(activeTab).toBe("graph");
      expect(mockWindow.history.pushState).toHaveBeenCalledWith(null, "", "/graph");

      // Pending selection is held in screenState before EntityGraphCanvas mounts
      expect(getPendingEntitySelection()).toBe(targetEntityId);

      // Simulate EntityGraphCanvas mounting first while nodes are still empty (returns false)
      let selectedEntityId: string | null = null;
      const unsubscribeFirstMount = registerGraphEntitySelectionListener(() => {
        return false;
      });
      expect(getPendingEntitySelection()).toBe(targetEntityId);
      unsubscribeFirstMount();

      // Simulate EntityGraphCanvas registering its selection listener once nodes are ready
      const unsubscribeSelection = registerGraphEntitySelectionListener((entityId) => {
        selectedEntityId = entityId;
        return true;
      });

      expect(selectedEntityId).toBe(targetEntityId);
      expect(getPendingEntitySelection()).toBeNull();

      unsubscribeSelection();
    } finally {
      unsubscribeTab();
    }
  });

  it("Case 3: calling navigate when no workspace tab listener is mounted returns { success: false } with a clear error message", async () => {
    const result = await defaultClientActionRegistry.execute<
      NavigateInput,
      NavigateOutput
    >("navigate", { tab: "graph" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active workspace tab listener/i);
    expect(result.message).toMatch(/cannot navigate/i);
    expect(mockWindow.history.pushState).not.toHaveBeenCalled();
  });

  it("Case 4: navigates to settings and dos_config tabs and resolves /settings and /dos-config pathnames (#1985)", async () => {
    registerSettingsNavigationRoutes();
    expect(getTabFromPathname("/settings") as string).toBe("settings");
    expect(getTabFromPathname("/dos-config") as string).toBe("settings");
    expect(getTabFromPathname("/dos_config") as string).toBe("settings");

    let activeTab: string = "chat";
    setScreenTab("chat");

    const unsubscribe = registerTabChangeListener((tab) => {
      activeTab = tab;
      setScreenTab(tab);
    });

    try {
      const settingsResult = await executeNavigate({ tab: "settings" });
      expect(settingsResult.success).toBe(true);
      expect(settingsResult.tab).toBe("settings");
      expect(settingsResult.path).toBe("/settings");
      expect(activeTab).toBe("settings");
      expect(mockWindow.history.pushState).toHaveBeenCalledWith(
        null,
        "",
        "/settings",
      );
      expect(getScreenState()?.path).toBe("/settings");

      const dosConfigResult = await executeNavigate({ tab: "dos_config" });
      expect(dosConfigResult.success).toBe(true);
      expect(dosConfigResult.tab).toBe("dos_config");
      expect(dosConfigResult.path).toBe("/settings");
      expect(activeTab).toBe("dos_config");
    } finally {
      unsubscribe();
    }
  });

  it("Case 5: navigates to job-hunt tab and updates history and screenState to /job-hunt (#2439)", async () => {
    let activeTab: ActiveTab = "chat";
    setScreenTab("chat");

    const unsubscribe = registerTabChangeListener((tab) => {
      activeTab = tab;
      setScreenTab(tab);
    });

    try {
      const result = await executeNavigate({ tab: "job-hunt" });
      expect(result.success).toBe(true);
      expect(result.tab).toBe("job-hunt");
      expect(result.path).toBe("/job-hunt");
      expect(activeTab).toBe("job-hunt");
      expect(mockWindow.history.pushState).toHaveBeenCalledWith(null, "", "/job-hunt");
      expect(getScreenState()?.tab).toBe("job-hunt");
      expect(getScreenState()?.path).toBe("/job-hunt");
    } finally {
      unsubscribe();
    }
  });
});
