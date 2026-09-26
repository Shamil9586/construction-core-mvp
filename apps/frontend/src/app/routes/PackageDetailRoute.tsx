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
 * F8.2.1 Corrective Patch (F8.2.1-02) — package management is part of the
 * PTO Workspace (`canManageDocumentation`, the same gate `PtoRoute.tsx`
 * uses), not a general internal destination: a role that can read
 * documentation but not manage it (RP, SC, TD, DoC, CEO) gets the same
 * "this is PTO's workspace" message `PtoRoute.tsx` shows, never the
 * package's read-only detail — the package may well exist, but this route
 * belongs to PTO, not to every role with documentation access. A role
 * excluded from documentation entirely (SDO) still gets the original
 * "no access" message.
 *
 * `actions` is built only for `canManageDocumentation(session.user.role)`
 * (PTO, and ADMIN — see that predicate's own comment) — reachable now only
 * by the same role the guard above already let through, kept as its own,
 * independent gate rather than implied by having passed it.
 */
export function PackageDetailRoute() {
  const { packageId } = useParams<{ packageId: string }>();
  const state = useSnapshot();
  const refetch = useRefetchSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  if (session && !canManageDocumentation(session.user.role)) {
    return (
      <RouteForbidden
        label={
          canAccessDocumentation(session.user.role)
            ? 'Раздел «ПТО» — рабочая область ПТО. Статус исполнительной документации по работе доступен на странице работы.'
            : 'У вас нет доступа к исполнительной документации.'
        }
      />
    );
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
    state.snapshot.sdoPackageReadiness ?? [],
    state.snapshot.documentationCustomerAcceptances ?? [],
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
          // F8.3-R01 corrective: registering customer acceptance and handing
          // off to SDO are PTO-only actions — the backend now refuses ADMIN
          // outright even though ADMIN otherwise passes canManageDocumentation
          // (its blanket DOCUMENTATION_MANAGE grant). Omitted for any other
          // role reaching this branch (ADMIN), so PackageDetail renders these
          // two controls read-only instead of offering a control the backend
          // would 403.
          ...(session.user.role === 'PTO'
            ? {
                onRegisterCustomerAcceptance: async (acceptedDate: string, reference: string | undefined, comment: string | undefined) => {
                  await documentationApi.registerDocumentationCustomerAcceptance(pkg.id, pkg.version, acceptedDate, reference, comment);
                  refetch();
                },
                onHandoffToSdo: async (comment: string | undefined) => {
                  await documentationApi.handoffDocumentationPackageToSdo(pkg.id, pkg.version, comment);
                  refetch();
                },
                // F8.3-17: "Вернуть на корректировку" — PTO's own,
                // pre-handoff-only route back to CORRECTING. The backend
                // itself rejects this once any SDO Case exists for the
                // package, and refuses it outright for any role but PTO
                // (ADMIN included), matching the same PTO-only carve-out
                // as onRegisterCustomerAcceptance/onHandoffToSdo above.
                onReturnToCorrection: async (comment: string | undefined) => {
                  await documentationApi.returnDocumentationPackageToCorrection(pkg.id, pkg.version, comment);
                  refetch();
                },
              }
            : {}),
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
