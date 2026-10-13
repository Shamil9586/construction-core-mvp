import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ObjectOverview } from '../../screens/O01';
import type { PtoTeamLoad } from '../../screens/O01/PtoTeamSection';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canViewObjectPtoTeam } from '../../auth/internalRoles';
import { getObjectPtoTeam } from '../../data/functionTeamsApi';
import { buildO01ViewModel } from '../../view-models/o01';
import { buildO01ScheduleView } from '../../view-models/schedule';
import { useSnapshot } from '../../data/SnapshotContext';
import { useObjectSchedule } from '../useSchedule';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, schedulePath, workPath } from '../routePaths';
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
  const { session } = useCoreRuntime();
  const role = session?.user.role;
  const [ptoTeam, setPtoTeam] = useState<PtoTeamLoad>({ status: 'Loading' });
  const showPtoTeam = role !== undefined && canViewObjectPtoTeam(role);
  // GPR-1 — the Object's production-schedule conclusion. Asked for only with a real session (the demo runtime has no backend to ask);
  // a role or object that cannot read the schedule gets `Hidden` and the card keeps its original statement.
  const { load: scheduleLoad } = useObjectSchedule(objectId, session !== null);

  // PBX-3A: the PTO block is fetched only for roles the backend lets read it (PTO_TEAM_READ).
  useEffect(() => {
    if (!showPtoTeam || !objectId) return;
    let cancelled = false;
    setPtoTeam({ status: 'Loading' });
    getObjectPtoTeam(objectId).then(
      (team) => { if (!cancelled) setPtoTeam({ status: 'Loaded', team }); },
      (error: unknown) => { if (!cancelled) setPtoTeam({ status: 'Error', message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
  }, [showPtoTeam, objectId]);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  const viewModel = buildO01ViewModel(object, state.snapshot.works);

  return (
    <ObjectOverview
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      ptoTeam={showPtoTeam ? ptoTeam : undefined}
      schedule={buildO01ScheduleView(scheduleLoad)}
      onOpenSchedule={() => navigate(schedulePath(object.id))}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onSelectWork={(workId) => navigate(workPath(object.id, workId))}
    />
  );
}
