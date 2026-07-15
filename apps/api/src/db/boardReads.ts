export interface BoardSheetManifestItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  version: number;
}

export interface BoardSheetManifest {
  version: number;
  sheets: BoardSheetManifestItem[];
}

export interface BoardSheetPayloadItem {
  id: string;
  name: string;
  sort_order: number;
  is_default: number;
  content_version: number;
}

export interface BoardSheetPayload {
  sheet: BoardSheetPayloadItem;
  tables: unknown[];
  notes: unknown[];
  axisItems: unknown[];
  cellStates: unknown[];
  completions: unknown[];
  periodFingerprint: string;
}

export interface BoardBootstrapPayload {
  userId: string;
  settings: unknown;
  manifest: BoardSheetManifest;
  activeSheet: BoardSheetPayload;
}

export interface BoardVersionSummary {
  manifestVersion: number;
  sheets: BoardSheetManifestItem[];
  periodFingerprint: "";
}
