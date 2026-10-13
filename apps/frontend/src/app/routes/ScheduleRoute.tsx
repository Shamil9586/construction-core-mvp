import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ProductionSchedule } from '../../screens/GPR';
import type { GprActions } from '../../screens/GPR/actions';
import { buildGprViewModel } from '../../view-models/schedule';
import { useSnapshot } from '../../data/SnapshotContext';
import * as scheduleApi from '../../data/scheduleApi';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { useObjectSchedule } from '../useSchedule';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath, workPath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/object/:objectId/schedule` — GPR-1, «График производства работ» of ONE object. `objectId` comes only from the URL; the schedule is
 * fetched for exactly that object, on demand (it does not ride the company-wide snapshot, so no other object's plan is ever in memory here).
 *
 * Every write refetches the schedule on success and only then — a rejected mutation leaves the screen exactly as it was and the calling form
 * shows the backend's own message. No session (the demo runtime) means no backend to ask: the route says so and offers nothing to edit.
 */
export function ScheduleRoute() {
  const { objectId } = useParams<{ objectId: string }>();
  const state = useSnapshot();
  const navigate = useNavigate();
  const { session } = useCoreRuntime();
  const hasSession = session !== null;
  const { load, reload } = useObjectSchedule(objectId, hasSession);

  const actions = useMemo<GprActions | undefined>(() => {
    if (!hasSession || !objectId) return undefined;
    const then = async (call: Promise<unknown>) => {
      await call;
      reload();
    };
    return {
      onCreateDraft: () => then(scheduleApi.createScheduleDraft(objectId)),
      onAddEntry: (input) => then(scheduleApi.addScheduleEntry(objectId, input)),
      onEditEntry: (entryId, input) => then(scheduleApi.editScheduleEntry(objectId, entryId, input)),
      onRemoveEntry: (entryId, version) => then(scheduleApi.removeScheduleEntry(objectId, entryId, version)),
      onDiscardDraft: (version) => then(scheduleApi.discardScheduleDraft(objectId, version)),
      onApprove: (input) => then(scheduleApi.approveScheduleDraft(objectId, input)),
      onRecordReason: (input) => then(scheduleApi.recordDelayReason(objectId, input)),
      onResolveReason: (reasonId, version, comment) => then(scheduleApi.resolveDelayReason(objectId, reasonId, version, comment)),
      loadResponsibleOptions: () => scheduleApi.listResponsibleOptions(objectId),
    };
  }, [hasSession, objectId, reload]);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  if (load.status === 'Loading') return <RouteLoading />;
  if (load.status === 'Error') return <RouteError message={load.message} />;
  if (load.status === 'Hidden') {
    return <RouteForbidden label={hasSession ? 'График производства работ недоступен для вашей роли или для этого объекта' : 'График производства работ доступен при подключении к серверу'} />;
  }

  return (
    <ProductionSchedule
      viewModel={buildGprViewModel(load.value)}
      sidebar={<AppSidebar />}
      actions={actions}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onNavigateObject={() => navigate(objectPath(object.id))}
      onSelectWork={(workId) => navigate(workPath(object.id, workId))}
    />
  );
}
