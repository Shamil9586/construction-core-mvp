import { useNavigate, useParams } from 'react-router-dom';
import { WorkCard } from '../../screens/W01';
import type { W01ActionHandlers } from '../../screens/W01/ExecutionSection';
import type { DocumentationSectionActionHandlers } from '../../screens/W01/DocumentationSection';
import { buildW01ViewModel } from '../../view-models/w01';
import { useRefetchSnapshot, useSnapshot } from '../../data/SnapshotContext';
import * as executionUnitsApi from '../../data/executionUnitsApi';
import * as documentationApi from '../../data/documentationApi';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAccessDocumentation, canManageDocumentation } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath, packagePath } from '../routePaths';
import { RouteError, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/object/:objectId/work/:workId` — both params come from the URL. A work
 * must belong to the object named in its own URL segment, not merely exist
 * somewhere in the snapshot, so a work id copied under the wrong object id
 * is treated the same as an unknown one rather than silently rendered.
 */
export function WorkRoute() {
  const { objectId, workId } = useParams<{ objectId: string; workId: string }>();
  const state = useSnapshot();
  const refetch = useRefetchSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  const work = state.snapshot.works.find(
    (candidate) => candidate.id === workId && candidate.objectId === objectId,
  );
  if (!object || !work) return <RouteNotFound label="Работа не найдена" />;

  const viewModel = buildW01ViewModel(
    work,
    object,
    state.snapshot.inspections ?? [],
    state.snapshot.executionUnits ?? [],
    state.snapshot.portions ?? [],
    state.snapshot.documentationPackages ?? [],
    state.snapshot.documentationPackagePortions ?? [],
  );

  // F8.1 (Phase 4) — no session (the mock/demo runtime, `App.tsx`'s
  // `MOCK_RUNTIME`) means no real backend to mutate through, exactly like
  // that runtime is already read-only everywhere else; `WorkCard` renders
  // status only when `actions` is left undefined. Each handler refetches on
  // success only — a rejected mutation leaves the snapshot exactly as it
  // was, and the calling form shows the backend's own error inline.
  const actions: W01ActionHandlers | undefined = session
    ? {
        onRecordFact: async (portionId, quantity, version, comment) => {
          await executionUnitsApi.recordPortionFact(portionId, quantity, version, comment);
          refetch();
        },
        onCreatePortion: async (executionUnitId, label, plannedQuantity) => {
          await executionUnitsApi.createQuantityPortion(executionUnitId, label, plannedQuantity);
          refetch();
        },
        onRequestInternalSc: async (portionId, version) => {
          await executionUnitsApi.requestInternalScInspection(portionId, version);
          refetch();
        },
        onRegisterInternalScDecision: async (inspectionId, version, decision, comment, photo, quantity) => {
          const attachment = await executionUnitsApi.uploadInspectionPhotoAttachment(
            photo.fileName,
            photo.mimeType,
            photo.base64,
          );
          await executionUnitsApi.attachInspectionPhoto(inspectionId, attachment.id);
          await (decision === 'accept'
            ? executionUnitsApi.acceptInspection(inspectionId, version, comment, quantity)
            : executionUnitsApi.rejectInspection(inspectionId, version, comment));
          refetch();
        },
      }
    : undefined;

  // F8.2.1 Decision 1/3 — the same `documentationApi` functions and the same
  // package detail destination P01's own actions use (`PtoRoute.tsx`), never
  // a second, screen-local copy; gated by `canManageDocumentation`, unlike
  // `actions` above, which any session gets regardless of role.
  const documentationActions: DocumentationSectionActionHandlers | undefined =
    session && canManageDocumentation(session.user.role)
      ? {
          onCreatePackage: async () => {
            const pkg = await documentationApi.createDocumentationPackage(work.id, session.user.id);
            refetch();
            navigate(packagePath(pkg.id));
          },
          onOpenPackage: (packageId) => {
            navigate(packagePath(packageId));
          },
        }
      : undefined;

  // F8.2.1 — no session (mock/demo runtime) stays visible, unchanged from
  // F8.2; a confirmed excluded role (SDO) is the only case this hides.
  const documentationVisible = session === null || canAccessDocumentation(session.user.role);

  return (
    <WorkCard
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onSelectObject={(id) => navigate(objectPath(id))}
      actions={actions}
      documentationActions={documentationActions}
      documentationVisible={documentationVisible}
    />
  );
}
