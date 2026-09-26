import { useNavigate, useParams } from 'react-router-dom';
import { SdoCaseDetail } from '../../screens/SdoCaseDetail';
import type { SdoCaseDetailActionHandlers } from '../../screens/SdoCaseDetail';
import { buildSdoCaseDetailViewModel } from '../../view-models/sdoCaseDetail';
import { useRefetchSnapshot, useSnapshot } from '../../data/SnapshotContext';
import * as sdoClosingApi from '../../data/sdoClosingApi';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAccessSdoWorkspace } from '../../auth/internalRoles';
import { useActiveSdoUsers } from '../useActiveSdoUsers';
import { AppSidebar } from '../AppSidebar';
import { objectPath, workPath, sdoPath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/sdo/case/:caseId` — SDO Case detail's own route container. SDO/ADMIN
 * only, same gate as `SdoRoute.tsx` (the workspace and its own case detail
 * share one audience — unlike F8.2's access/manage split, there is no
 * broader "read-only via this route" role here; every other role reads SDO
 * Case state through W01 instead, never this screen).
 */
export function SdoCaseDetailRoute() {
  const { caseId } = useParams<{ caseId: string }>();
  const state = useSnapshot();
  const refetch = useRefetchSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();
  // Fetched unconditionally, before any early return, per the Rules of Hooks.
  const sdoUsers = useActiveSdoUsers(session?.user.role);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  if (session && !canAccessSdoWorkspace(session.user.role)) {
    return <RouteForbidden label="Раздел «СДО» — рабочая область СДО. Состояние дела по работе доступно на странице работы." />;
  }

  const sdoCase = (state.snapshot.sdoClosingCases ?? []).find((candidate) => candidate.id === caseId);
  if (!sdoCase) return <RouteNotFound label="Дело СДО не найдено" />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === sdoCase.objectId);
  const work = state.snapshot.works.find((candidate) => candidate.id === sdoCase.objectWorkId);

  const viewModel = buildSdoCaseDetailViewModel(
    sdoCase,
    object,
    work,
    state.snapshot.executionUnits ?? [],
    state.snapshot.portions ?? [],
    state.snapshot.sdoClosingPortionAllocations ?? [],
    state.snapshot.sdoClosingStatusHistory ?? [],
    state.snapshot.sdoClosingHandoffHistory ?? [],
    state.snapshot.sdoClosingAmountHistory ?? [],
  );

  const actions: SdoCaseDetailActionHandlers | undefined =
    session && canAccessSdoWorkspace(session.user.role)
      ? {
          onChangeStatus: async (status, reason) => {
            await sdoClosingApi.changeSdoClosingStatus(sdoCase.id, status, sdoCase.version, reason);
            refetch();
          },
          onSetAmount: async (amount) => {
            await sdoClosingApi.setSdoClosingAmount(sdoCase.id, sdoCase.version, amount);
            refetch();
          },
          onAddAllocation: async (quantityPortionId, amount) => {
            await sdoClosingApi.addSdoClosingPortionAllocation(sdoCase.id, quantityPortionId, amount);
            refetch();
          },
          onAssignResponsible: async (responsibleUserId) => {
            await sdoClosingApi.assignSdoResponsible(sdoCase.id, sdoCase.version, responsibleUserId);
            refetch();
          },
          onReturnToPto: async (comment) => {
            await sdoClosingApi.returnSdoCaseToPto(sdoCase.id, sdoCase.version, comment);
            refetch();
          },
          sdoUsers,
        }
      : undefined;

  return (
    <SdoCaseDetail
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onNavigateHome={() => navigate(sdoPath())}
      onSelectObject={(id) => navigate(objectPath(id))}
      onSelectWork={(objectId, objectWorkId) => navigate(workPath(objectId, objectWorkId))}
      actions={actions}
    />
  );
}
