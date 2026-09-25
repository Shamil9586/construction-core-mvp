import { useNavigate, useParams } from 'react-router-dom';
import { PackageDetail } from '../../screens/PackageDetail';
import type { PackageDetailActionHandlers } from '../../screens/PackageDetail';
import { buildPackageDetailViewModel } from '../../view-models/documentationPackage';
import { useRefetchSnapshot, useSnapshot } from '../../data/SnapshotContext';
import * as documentationApi from '../../data/documentationApi';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAccessDocumentation, canManageDocumentation } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath, workPath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/pto/package/:packageId` — the package detail screen's route container.
 * Reachable from both P01 and W01 (Decision 1), so this is the one place
 * that resolves a package id into `PackageDetailViewModel` and wires its
 * actions — neither entry point builds its own copy.
 *
 * F8.2.1 Decision 3 — `actions` is built only for
 * `canManageDocumentation(session.user.role)` (PTO, and ADMIN — see that
 * predicate's own comment), otherwise `undefined`, which `PackageDetail`
 * already renders as fully read-only (no forms, no status button).
 */
export function PackageDetailRoute() {
  const { packageId } = useParams<{ packageId: string }>();
  const state = useSnapshot();
  const refetch = useRefetchSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  // F8.2.1 — same guard as PtoRoute.tsx: a confirmed-excluded role (SDO)
  // gets an explicit access-denied state, not "package not found" — the
  // package may well exist, this session simply cannot see it.
  if (session && !canAccessDocumentation(session.user.role)) {
    return <RouteForbidden label="У вас нет доступа к исполнительной документации." />;
  }

  const pkg = (state.snapshot.documentationPackages ?? []).find((candidate) => candidate.id === packageId);
  if (!pkg) return <RouteNotFound label="Пакет исполнительной документации не найден" />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === pkg.objectId);
  const work = state.snapshot.works.find((candidate) => candidate.id === pkg.objectWorkId);

  const viewModel = buildPackageDetailViewModel(
    pkg,
    object,
    work,
    state.snapshot.executionUnits ?? [],
    state.snapshot.documentationPackagePortions ?? [],
    state.snapshot.portions ?? [],
    state.snapshot.documentationDocuments ?? [],
    state.snapshot.documentationVersions ?? [],
    state.snapshot.documentationStatusHistory ?? [],
  );

  const actions: PackageDetailActionHandlers | undefined =
    session && canManageDocumentation(session.user.role)
      ? {
          onAdvanceStatus: async (nextStatus, comment) => {
            await documentationApi.changeDocumentationPackageStatus(pkg.id, nextStatus, pkg.version, comment || undefined);
            refetch();
          },
          onLinkPortion: async (quantityPortionId) => {
            await documentationApi.linkDocumentationPackagePortion(pkg.id, quantityPortionId);
            refetch();
          },
          onCreateDocument: async (type) => {
            await documentationApi.createDocumentationDocument(pkg.id, type);
            refetch();
          },
          onCreateVersion: async (documentId, storageProvider, storageReference, comment) => {
            await documentationApi.createDocumentationVersion(documentId, storageProvider, storageReference, comment);
            refetch();
          },
        }
      : undefined;

  return (
    <PackageDetail
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onSelectObject={(id) => navigate(objectPath(id))}
      onSelectWork={(objectId, objectWorkId) => navigate(workPath(objectId, objectWorkId))}
      actions={actions}
    />
  );
}
