import type { ViewDefinition } from "../types.js";
import { repoCurrentViewData } from "./repoCurrentViewData.js";
import { repoVisionViewData } from "./repoVisionViewData.js";
import { infraCurrentViewData } from "./infraCurrentViewData.js";
import { infraVisionViewData } from "./infraVisionViewData.js";
import { dbCurrentViewData } from "./dbCurrentViewData.js";
import { dbVisionViewData } from "./dbVisionViewData.js";
import { gitDiagramViewData } from "./gitDiagramViewData.js";

export const ARCHITECTURE_VIEWS: Record<string, ViewDefinition> = {
  "repo-current": repoCurrentViewData,
  "repo-vision": repoVisionViewData,
  "infra-current": infraCurrentViewData,
  "infra-vision": infraVisionViewData,
  "db-current": dbCurrentViewData,
  "db-vision": dbVisionViewData,
  gitdiagram: gitDiagramViewData,
};

export const VIEW_ORDER = [
  "repo-current",
  "infra-current",
  "db-current",
  "gitdiagram",
  "repo-vision",
  "infra-vision",
  "db-vision",
] as const;

export type ViewId = (typeof VIEW_ORDER)[number];

export {
  repoCurrentViewData,
  repoVisionViewData,
  infraCurrentViewData,
  infraVisionViewData,
  dbCurrentViewData,
  dbVisionViewData,
  gitDiagramViewData,
};
