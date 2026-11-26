import { TAB_PATHS, type ActiveTab } from "./router.js";

export interface ScreenEntitySelection {
  id: string;
  title: string;
  entity_type?: string;
}

export interface ScreenEdgeSelection {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
}

export interface ScreenGraphFilters {
  query: string;
  entity_types: string[];
  hierarchy_level: number | null;
  show_archived: boolean;
  include_me: boolean;
  scope_tier: string;
  detail_strategy: string;
  lod_mode: string;
  isolated: boolean;
}

export interface GraphScreenState {
  view: string;
  live: boolean;
  selected_entity: ScreenEntitySelection | null;
  selected_edge: ScreenEdgeSelection | null;
  filters: ScreenGraphFilters;
}

export type InboxDomainFilter = "all" | "work" | "personal";

export interface InboxScreenState {
  domain: InboxDomainFilter;
  cut_line: number;
  intent_filter: string | null;
  route_filter?: string | null;
  curated_count: number;
  swept_count: number;
  drawer_open: boolean;
  attention_budget?: number;
  needs_attention_count?: number;
  over_budget_count?: number;
  over_budget?: boolean;
  counts_by_route?: Partial<Record<string, number>>;
}

export interface ScreenState {
  tab: ActiveTab;
  path: string;
  graph: GraphScreenState | null;
  inbox?: InboxScreenState | null;
  captured_at: string;
}

let currentTab: ActiveTab | null = null;
let currentGraph: GraphScreenState | null = null;
let currentInbox: InboxScreenState | null = null;
let pendingEntityId: string | null = null;

export type GraphEntitySelectionListener = (entityId: string) => boolean | void;
const entitySelectionListeners = new Set<GraphEntitySelectionListener>();

export function setScreenTab(tab: ActiveTab): void {
  currentTab = tab;
}

export function setGraphScreen(graph: GraphScreenState | null): void {
  currentGraph = graph;
}

export function setInboxScreen(inbox: InboxScreenState | null): void {
  currentInbox = inbox;
}

export function getInboxScreen(): InboxScreenState | null {
  return currentInbox;
}

export function getPendingEntitySelection(): string | null {
  return pendingEntityId;
}

export function setPendingEntitySelection(entityId: string | null): void {
  pendingEntityId = entityId;
}

export function consumePendingEntitySelection(): string | null {
  const id = pendingEntityId;
  pendingEntityId = null;
  return id;
}

/**
 * Registers a listener for graph entity selection requests.
 * If a pending `entity_id` selection is already queued in `screenState`, the
 * listener is invoked immediately; if the listener returns `false` (e.g. graph
 * nodes are still loading), `pendingEntityId` remains queued until satisfied.
 */
export function registerGraphEntitySelectionListener(
  listener: GraphEntitySelectionListener,
): () => void {
  entitySelectionListeners.add(listener);
  if (pendingEntityId !== null) {
    const id = pendingEntityId;
    const handled = listener(id);
    if (handled !== false) {
      pendingEntityId = null;
    }
  }
  return () => {
    entitySelectionListeners.delete(listener);
  };
}

/**
 * Requests selecting `entityId` in the graph. Stores `entityId` as pending in
 * `screenState` and immediately notifies any mounted graph selection listener.
 */
export function requestGraphEntitySelection(entityId: string): boolean {
  pendingEntityId = entityId;
  if (entitySelectionListeners.size === 0) {
    return false;
  }
  let applied = false;
  for (const listener of entitySelectionListeners) {
    const res = listener(entityId);
    if (res !== false) {
      applied = true;
    }
  }
  if (applied) {
    pendingEntityId = null;
  }
  return applied;
}

export function getScreenState(): ScreenState | null {
  if (currentTab === null) {
    return null;
  }
  return {
    tab: currentTab,
    path: TAB_PATHS[currentTab] ?? `/${currentTab}`,
    graph: currentGraph,
    ...(currentInbox !== null ? { inbox: currentInbox } : {}),
    captured_at: new Date().toISOString(),
  };
}

export function resetScreenStateForTesting(): void {
  currentTab = null;
  currentGraph = null;
  currentInbox = null;
  pendingEntityId = null;
  entitySelectionListeners.clear();
}

