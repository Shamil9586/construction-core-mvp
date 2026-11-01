export interface FinishSystemStage {
  id: string; occurrenceKey: string; position: number; workTypeId: string; workTypeName: string | null;
  required: boolean; measureScope: 'MAIN' | 'LOCAL'; measureUnit: string;
  proposedHoldHours: string | null; proposedHoldStatus: string; overrideKind: 'INHERITED' | 'OVERRIDDEN' | 'ADDED_LOCAL';
  overrideReason: string | null; sourceTemplateVersionId: string | null; sourceTemplateStageId: string | null;
}
export interface FinishSystemVersionSummary { id: string; versionNumber: number; state: 'PUBLISHED' | 'DRAFT'; contentHash: string | null; publishedAt: string | null; createdAt: string; sourceTemplateVersionId: string | null; }
export interface FinishSystemVersion extends FinishSystemVersionSummary { stages: FinishSystemStage[]; exclusions: { templateStageId: string; sourceTemplateVersionId: string; reason: string }[]; }
export interface FinishSystemRead { id: string; code: string; name: string; lifecycle: 'ACTIVE' | 'RETIRED'; version: string; createdAt: string; updatedAt: string; versions: FinishSystemVersionSummary[]; currentVersion: FinishSystemVersion | null; }
export interface FinishSystemPage { items: FinishSystemRead[]; nextCursor: string | null; }
