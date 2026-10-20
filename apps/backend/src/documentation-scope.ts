import { one, rows } from './db';
import { loadPortionFigures } from './fact-resolver';
import { buildPackageScope, type PackageScopeView, type ScopePortionInput } from '../../../packages/domain/package-scope';

/**
 * Documentation Package scope, read from the existing production model — no new quantity model: a scope is the package's Quantity
 * Portions, and its current quantity follows the accepted provenance (customer-accepted, else Internal SC, else RP fact; latest each).
 */

/** Zone name parts + latest figures of the given portions. */
export async function scopePortionInputs(c: any, tenantId: string, portionIds: string[]): Promise<ScopePortionInput[]> {
    if (!portionIds.length) return [];
    const portions = await rows(c, 'SELECT p.id,p.label,p.planned_quantity,u.location,u.unit FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.created_at,p.id', [tenantId, portionIds]);
    const figures = await loadPortionFigures(c, tenantId, portionIds);
    return portions.map((p: any) => ({
        id: p.id, label: p.label, location: p.location, unit: p.unit, plannedQuantity: p.plannedQuantity,
        rpFact: figures.get(p.id)?.rpFact ?? null,
        internalSc: figures.get(p.id)?.internalSc ?? null,
        customerAccepted: figures.get(p.id)?.customerAccepted ?? null,
    }));
}

export async function packageScope(c: any, tenantId: string, packageId: string): Promise<PackageScopeView> {
    const links = await rows(c, 'SELECT quantity_portion_id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2', [tenantId, packageId]);
    return buildPackageScope(await scopePortionInputs(c, tenantId, links.map((l: any) => l.quantityPortionId)));
}

export async function packageHasScope(c: any, tenantId: string, packageId: string): Promise<boolean> {
    return !!(await one(c, 'SELECT 1 AS x FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2 LIMIT 1', [tenantId, packageId]));
}

/** ACTIVE (not archived) packages of the same Work (other than `exceptPackageId`) that already claim any of the portions. */
export async function overlappingClaims(c: any, tenantId: string, workId: string, portionIds: string[], exceptPackageId?: string): Promise<{ portionId: string; packageId: string }[]> {
    if (!portionIds.length) return [];
    const found = await rows(c, 'SELECT l.quantity_portion_id,l.documentation_package_id FROM documentation_package_portions l JOIN documentation_packages p ON p.tenant_id=l.tenant_id AND p.id=l.documentation_package_id WHERE l.tenant_id=$1 AND p.object_work_id=$2 AND p.archived_at IS NULL AND l.quantity_portion_id=ANY($3::uuid[]) AND ($4::uuid IS NULL OR l.documentation_package_id<>$4)', [tenantId, workId, portionIds, exceptPackageId ?? null]);
    return found.map((r: any) => ({ portionId: r.quantityPortionId, packageId: r.documentationPackageId }));
}

/** The Work's portions that no ACTIVE package claims — what a NEW package may be created on (a portion released by an archive is eligible again). */
export async function eligiblePortions(c: any, tenantId: string, workId: string) {
    const all = await rows(c, 'SELECT p.id FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id WHERE p.tenant_id=$1 AND u.object_work_id=$2', [tenantId, workId]);
    const claimed = new Set((await rows(c, 'SELECT l.quantity_portion_id FROM documentation_package_portions l JOIN documentation_packages p ON p.tenant_id=l.tenant_id AND p.id=l.documentation_package_id WHERE l.tenant_id=$1 AND p.object_work_id=$2 AND p.archived_at IS NULL', [tenantId, workId])).map((r: any) => r.quantityPortionId));
    const free = all.map((r: any) => r.id).filter((id: string) => !claimed.has(id));
    const inputs = await scopePortionInputs(c, tenantId, free);
    return { totalPortions: all.length, eligible: buildPackageScope(inputs).portions };
}
