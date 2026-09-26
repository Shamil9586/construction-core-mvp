import { useNavigate, useParams } from 'react-router-dom';
import { ObjectOverview } from '../../screens/O01';
import { buildO01ViewModel } from '../../view-models/o01';
import { useSnapshot } from '../../data/SnapshotContext';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, workPath } from '../routePaths';
import { RouteError, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/object/:objectId` — `objectId` comes only from the URL param, never a
 * hardcoded id; a param that matches nothing in the snapshot is a real,
 * distinct outcome (`RouteNotFound`), not a crash or a silently empty screen.
 */
export function ObjectRoute() {
  const { objectId } = useParams<{ objectId: string }>();
  const state = useSnapshot();
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  const viewModel = buildO01ViewModel(object, state.snapshot.works);

  return (
    <ObjectOverview
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onSelectWork={(workId) => navigate(workPath(object.id, workId))}
    />
  );
}
