import { useNavigate, useParams } from 'react-router-dom';
import { WorkCard } from '../../screens/W01';
import { buildW01ViewModel } from '../../view-models/w01';
import { useSnapshot } from '../../data/SnapshotContext';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath } from '../routePaths';
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
  const navigate = useNavigate();

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  const work = state.snapshot.works.find(
    (candidate) => candidate.id === workId && candidate.objectId === objectId,
  );
  if (!object || !work) return <RouteNotFound label="Работа не найдена" />;

  const viewModel = buildW01ViewModel(work, object, state.snapshot.inspections ?? []);

  return (
    <WorkCard
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onSelectObject={(id) => navigate(objectPath(id))}
    />
  );
}
