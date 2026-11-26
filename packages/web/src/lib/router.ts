import { useState, useEffect } from "react";

export type ActiveTab =
  | "documents"
  | "inbox"
  | "decisions"
  | "approvals"
  | "ledger"
  | "fresh"
  | "dashboard"
  | "chat"
  | "visual-meaning"
  | "graph"
  | "job-hunt";

/**
 * Canonical URL path for each workspace tab.
 */
export const TAB_PATHS: Record<ActiveTab, string> = {
  documents: "/living-docs",
  inbox: "/inbox",
  decisions: "/decisions",
  approvals: "/approvals",
  ledger: "/ledger",
  fresh: "/fresh",
  dashboard: "/dashboard",
  chat: "/chat",
  "visual-meaning": "/visual-meaning",
  graph: "/graph",
  "job-hunt": "/job-hunt",
};

/**
 * Mapping from URL pathnames to tab identifiers, including aliases.
 */
export const PATH_TO_TAB: Record<string, ActiveTab> = {
  "/": "documents",
  "/living-docs": "documents",
  "/documents": "documents",
  "/inbox": "inbox",
  "/priority-inbox": "inbox",
  "/decisions": "decisions",
  "/decision-backlog": "decisions",
  "/approvals": "approvals",
  "/ledger": "ledger",
  "/fresh": "fresh",
  "/dashboard": "dashboard",
  "/chat": "chat",
  "/visual-meaning": "visual-meaning",
  "/graph": "graph",
  "/knowledge-graph": "graph",
  "/entities-graph": "graph",
  "/job-hunt": "job-hunt",
  "/jobhunt": "job-hunt",
};

/**
 * Resolves the active tab from a given pathname or window.location.pathname.
 */
export function getTabFromPathname(pathname?: string): ActiveTab {
  if (typeof window === "undefined" && !pathname) {
    return "documents";
  }
  const raw = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const normalized = raw.replace(/\/+$/, "") || "/";
  return PATH_TO_TAB[normalized] || "documents";
}

export type TabChangeListener = (tab: ActiveTab) => void;
const tabListeners = new Set<TabChangeListener>();

/**
 * Registers a listener notified when the active workspace tab changes programmatically.
 */
export function registerTabChangeListener(listener: TabChangeListener): () => void {
  tabListeners.add(listener);
  return () => {
    tabListeners.delete(listener);
  };
}

/**
 * Returns whether at least one workspace tab listener is currently mounted.
 */
export function hasTabChangeListeners(): boolean {
  return tabListeners.size > 0;
}

/**
 * Pushes or replaces history state, updates URL bar, and notifies active tab listeners.
 */
export function navigateToTab(
  tab: ActiveTab,
  replace = false,
  options: { notifyListeners?: boolean } = {},
): void {
  if (typeof window !== "undefined") {
    const targetPath = TAB_PATHS[tab];
    if (window.location.pathname !== targetPath) {
      if (replace) {
        window.history.replaceState(null, "", targetPath);
      } else {
        window.history.pushState(null, "", targetPath);
      }
    }
  }
  if (options.notifyListeners ?? true) {
    for (const listener of tabListeners) {
      listener(tab);
    }
  }
}

/**
 * React hook that binds active tab state with the browser's URL path and history.
 * Ensures reloads persist the current tab and supports back/forward navigation.
 */
export function useActiveTab(): [ActiveTab, (tab: ActiveTab) => void] {
  const [activeTab, setActiveTabState] = useState<ActiveTab>(() => getTabFromPathname());

  useEffect(() => {
    // If the user visits "/" initially, normalize URL bar to "/living-docs" without adding history entry
    if (typeof window !== "undefined" && window.location.pathname === "/") {
      window.history.replaceState(null, "", TAB_PATHS.documents);
    }

    const handlePopState = () => {
      const tab = getTabFromPathname();
      setActiveTabState(tab);
    };

    const unsubscribeTab = registerTabChangeListener((tab) => {
      setActiveTabState(tab);
    });

    if (typeof window !== "undefined") {
      window.addEventListener("popstate", handlePopState);
    }
    return () => {
      unsubscribeTab();
      if (typeof window !== "undefined") {
        window.removeEventListener("popstate", handlePopState);
      }
    };
  }, []);

  const setActiveTab = (tab: ActiveTab) => {
    setActiveTabState(tab);
    navigateToTab(tab, false, { notifyListeners: false });
  };

  return [activeTab, setActiveTab];
}

