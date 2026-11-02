/** R05 S4 wire contract. Decimal quantities stay strings. */
export interface GenerationSelection {
  systemVersionId: string;
  areaScopeIds: string[];
  includeOptional?: string[];
  localQuantities?: { occurrenceKey: string; areaScopeId: string; quantity: string }[];
  grouping?: 'PER_OCCURRENCE' | 'PER_AREA';
}

export interface GenerationPreview {
  previewFingerprint: string;
  scopeVersion: string;
  systemVersionId: string;
  sourceVersions: { systemVersion: string };
  grouping: 'PER_OCCURRENCE' | 'PER_AREA';
  proposedWorks: {
    key: string; name: string; workTypeId: string; unit: string; quantity: string;
    occurrenceKey: string; areaScopeIds: string[]; areaQuantities: { areaScopeId: string; quantity: string }[];
  }[];
  existingWorks: {
    workId: string; occurrenceKey: string; areaScopeId: string; name: string;
    unit: string; quantity: string; workPlannedQuantity: string;
  }[];
  items: { occurrenceKey: string; areaScopeId: string; status: 'PROPOSED' | 'EXISTING' | 'BLOCKED'; quantity: string | null; unit: string }[];
  blockers: { error: string; rule: string | null; path: string; occurrenceKey: string | null; areaScopeId: string | null }[];
  missingInputs: { kind: string; occurrenceKey: string; areaScopeId: string | null; quantity?: string; unit?: string }[];
  warnings: { code: string; path: string }[];
  canConfirm: boolean;
}
export interface GenerationPreviewResponse { preview: GenerationPreview; appliedVersions: { aggregate: string; scope: string }; resultIds: string[]; warnings: { code: string; path?: string }[] }
export interface GenerationConfirmResult { resultIds: string[]; appliedVersions: { aggregate: string; scope: string }; warnings: { code: string; path?: string }[] }
