import { useNavigate } from 'react-router-dom';
import { SdoWorkspace } from '../../screens/SDO';
import { buildSdoWorkspaceViewModel } from '../../view-models/sdoWorkspace';
import { useSnapshot } from '../../data/SnapshotContext';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAccessSdoWorkspace } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { sdoCasePath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading } from '../RouteStatus';

/**
 * `/sdo` — the SDO workspace's own route container. SDO/ADMIN only
 * (`canAccessSdoWorkspace`); every other role gets the same
 * "workspace belongs to another department" message `PtoRoute.tsx` already
 * shows for PTO's own workspace, mirrored here (Decision-parity with F8.2.1
 * Corrective F8.2.1-02).
 */
export function SdoRoute() {
  const state = useSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  if (session && !canAccessSdoWorkspace(session.user.role)) {
    return <RouteForbidden label="Раздел «СДО» — рабочая область СДО. Состояние дела по работе доступно на странице работы." />;
  }

  const viewModel = buildSdoWorkspaceViewModel(
    state.snapshot.sdoPackageReadiness ?? [],
    state.snapshot.sdoClosingCases ?? [],
  );

  return (
    <SdoWorkspace
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onOpenCase={(caseId) => navigate(sdoCasePath(caseId))}
    />
  );
}
