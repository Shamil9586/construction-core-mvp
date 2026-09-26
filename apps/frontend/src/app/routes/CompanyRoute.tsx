import { useNavigate } from 'react-router-dom';
import { CompanyControlCenter } from '../../screens/C01';
import { buildC01ViewModel } from '../../view-models/c01';
import { useSnapshot } from '../../data/SnapshotContext';
import { AppSidebar } from '../AppSidebar';
import { objectPath } from '../routePaths';
import { RouteError, RouteLoading } from '../RouteStatus';

/**
 * `/company` — reads the snapshot off the data boundary, runs it through the
 * existing C01 adapter unchanged (`buildC01ViewModel`, F4), and hands the
 * result to the screen. `onSelectObject` is the routing side of C01's own
 * contract — C01 itself still just calls a callback with an id, same as in
 * the preview; only what that callback does (navigate) is new.
 */
export function CompanyRoute() {
  const state = useSnapshot();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const viewModel = buildC01ViewModel(state.snapshot.objects, state.snapshot.works);

  return (
    <CompanyControlCenter
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onSelectObject={(objectId) => navigate(objectPath(objectId))}
    />
  );
}
