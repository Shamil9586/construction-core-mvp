import { useSearchParams } from 'react-router-dom';
import { PtoWorkspace } from '../../screens/P01';
import { buildP01ViewModel } from '../../view-models/p01';
import { useSnapshot } from '../../data/SnapshotContext';
import { AppSidebar } from '../AppSidebar';
import { RouteError, RouteLoading } from '../RouteStatus';

/**
 * `/pto` — P01, PTO Workspace. The object filter lives in the URL
 * (`?objectId=`), the same treatment `objectId`/`workId` route params get
 * elsewhere (the navigation contract: real state belongs in the URL, not a
 * component-local value lost on refresh or unshareable in a link) — a plain
 * `useState` would not survive either.
 *
 * `documentationPackages`/`documentationPackagePortions` are `undefined` for
 * a role with no F8.2 access (SDO) — read as empty arrays here, the same
 * "nothing to show" state an empty result set already renders, since a role
 * without this route in its own navigation should not see a special error
 * for data it was never going to have.
 */
export function PtoRoute() {
  const state = useSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const viewModel = buildP01ViewModel(
    state.snapshot.documentationPackages ?? [],
    state.snapshot.objects,
    state.snapshot.works,
    state.snapshot.documentationPackagePortions ?? [],
  );

  const selectedObjectId = searchParams.get('objectId');

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
    />
  );
}
