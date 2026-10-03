/**
 * ID-AUTO-1 — AOSR generation contract.
 *
 * This module deliberately contains no DOCX library and no database access.
 * It is the stable boundary between Construction Core's linked domain data
 * and a renderer. The renderer must consume this normalized snapshot rather
 * than copy an Excel layout or re-query unrelated tables.
 */

export interface AosrParticipant {
  role: 'CUSTOMER' | 'GENERAL_CONTRACTOR' | 'CONTRACTOR' | 'CONSTRUCTION_CONTROL' | 'DESIGNER';
  organizationName: string;
  representativeName: string;
  representativePosition?: string | null;
  authorityDocument?: string | null;
}

export interface AosrMaterialEvidence {
  materialName: string;
  manufacturer?: string | null;
  certificateNumber?: string | null;
  certificateDate?: string | null;
  passportNumber?: string | null;
  storageReference?: string | null;
}

export interface AosrProjectReference {
  kind: 'PROJECT' | 'WORKING_DOCUMENTATION' | 'SP' | 'OTHER';
  designation: string;
  title?: string | null;
}

export interface AosrQuantityPortionSource {
  id: string;
  label: string;
  unit: string;
  rpFactQuantity: string | null;
  internalScConfirmedQuantity: string | null;
}

export interface AosrExecutionUnitSource {
  id: string;
  location?: string | null;
  executionConditions?: string | null;
  layers: string[];
  portions: AosrQuantityPortionSource[];
}

export interface AosrSourceSnapshot {
  packageId: string;
  objectId: string;
  objectWorkId: string;
  documentNumber: string;
  documentDate: string;
  objectName: string;
  objectAddress?: string | null;
  workName: string;
  contractorName: string;
  responsiblePtoName: string;
  participants: AosrParticipant[];
  materials: AosrMaterialEvidence[];
  references: AosrProjectReference[];
  executionUnits: AosrExecutionUnitSource[];
}

export interface AosrDraftModel extends AosrSourceSnapshot {
  coveredLocations: string[];
  coveredPortions: Array<{
    id: string;
    label: string;
    unit: string;
    quantity: string;
  }>;
}

/**
 * AOSR quantity is based on the linked Quantity Portion's accepted Internal SC
 * quantity. RP_FACT remains visible in the source snapshot but is never silently
 * substituted for an absent Internal SC confirmation.
 */
export function buildAosrDraftModel(source: AosrSourceSnapshot): AosrDraftModel {
  const coveredPortions = source.executionUnits.flatMap(unit =>
    unit.portions.flatMap(portion =>
      portion.internalScConfirmedQuantity === null
        ? []
        : [{
            id: portion.id,
            label: portion.label,
            unit: portion.unit,
            quantity: portion.internalScConfirmedQuantity,
          }],
    ),
  );

  const coveredLocations = Array.from(new Set(
    source.executionUnits
      .map(unit => unit.location?.trim())
      .filter((value): value is string => Boolean(value)),
  ));

  return {
    ...source,
    coveredLocations,
    coveredPortions,
  };
}
