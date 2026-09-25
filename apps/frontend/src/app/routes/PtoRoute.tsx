import { useNavigate, useSearchParams } from 'react-router-dom';
import { PtoWorkspace } from '../../screens/P01';
import type { P01ActionHandlers } from '../../screens/P01';
import { buildP01ViewModel } from '../../view-models/p01';
import { useRefetchSnapshot, useSnapshot } from '../../data/SnapshotContext';
import * as documentationApi from '../../data/documentationApi';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAccessDocumentation, canManageDocumentation } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { packagePath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading } from '../RouteStatus';

/**
 * `/pto` — P01, PTO Operations. The object filter lives in the URL
 * (`?objectId=`), the same treatment `objectId`/`workId` route params get
 * elsewhere (the navigation contract: real state belongs in the URL, not a
 * component-local value lost on refresh or unshareable in a link) — a plain
 * `useState` would not survive either.
 *
 * `documentationPackages`/`documentationAttentionQueue` are `undefined` for a
 * role with no F8.2/F8.2.1 access (SDO) — read as empty arrays here, the same
 * "nothing to show" state an empty result set already renders, since a role
 * without this route in its own navigation should not see a special error for
 * data it was never going to have.
 *
 * F8.2.1 Decision 3 — only PTO creates or manages packages: `actions` is
 * built only when `canManageDocumentation(session.user.role)`, otherwise
 * `undefined`, which `PtoWorkspace` already renders as a fully read-only
 * table (see its own module comment). Creating a package posts through `documentationApi`
 * (Decision 1: the same module W01's own create/open action, Step 4c, calls)
 * then refetches and navigates straight to the new package's detail route —
 * `refetch()` is fire-and-forget by existing convention (`WorkRoute.tsx`), so
 * the detail route may briefly render its own `Loading` state while the new
 * package lands in the snapshot, exactly like any other post-mutation
 * navigation in this app already can.
 */
export function PtoRoute() {
  const state = useSnapshot();
  const refetch = useRefetchSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  // F8.2.1 — SDO's snapshot never carries documentation data at all
  // (`canAccessDocumentation`); without this guard the table would render
  // every work as if nothing needed attention, a real, misleading claim,
  // not merely an absent one. No session (mock/demo runtime) is unaffected.
  if (session && !canAccessDocumentation(session.user.role)) {
    return <RouteForbidden label="У вас нет доступа к разделу «ПТО»." />;
  }

  const viewModel = buildP01ViewModel(
    state.snapshot.works,
    state.snapshot.objects,
    state.snapshot.documentationPackages ?? [],
    state.snapshot.documentationAttentionQueue ?? [],
  );

  const selectedObjectId = searchParams.get('objectId');

  const actions: P01ActionHandlers | undefined =
    session && canManageDocumentation(session.user.role)
      ? {
          onCreatePackage: async (objectWorkId) => {
            const pkg = await documentationApi.createDocumentationPackage(objectWorkId, session.user.id);
            refetch();
            navigate(packagePath(pkg.id));
          },
          onOpenPackage: (packageId) => {
            navigate(packagePath(packageId));
          },
        }
      : undefined;

  return (
    <PtoWorkspace
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      selectedObjectId={selectedObjectId}
      onSelectObjectFilter={(objectId) => {
        const next = new URLSearchParams(searchParams);
        if (objectId === null) next.delete('objectId');
        else next.set('objectId', objectId);
        setSearchParams(next, { replace: true });
      }}
      actions={actions}
    />
  );
}
