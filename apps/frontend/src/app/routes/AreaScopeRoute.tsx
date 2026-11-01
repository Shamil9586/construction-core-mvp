import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AreaScopes } from '../../screens/AreaScope';
import type { AreaScopeScreenState } from '../../screens/AreaScope';
import { canViewAreaScopes } from '../../auth/internalRoles';
import { useSnapshot } from '../../data/SnapshotContext';
import { buildAreaTree } from '../../view-models/areaScope';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';
import { useAreaScopeCreate, useAreaScopes } from '../useAreaScopes';

/**
 * `/object/:objectId/finish/areas` — «Зоны объекта» (GPR-2 R05 S2): the AreaScope tree of ONE object.
 *
 * `objectId` comes only from the URL and is the only object this route reads or writes. The role gate is a presentation gate (owner
 * decision D2): any role but PROJECT_MANAGER gets an explanatory state and NO R05 request is made (`enabled` stays false). The backend
 * remains the authority; a 403/404 from it is shown as a generic "unavailable", never as an empty tree.
 */
export function AreaScopeRoute() {
  const { objectId } = useParams<{ objectId: string }>();
  const state = useSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();

  const objectKnown = state.status === 'Ready' && state.snapshot.objects.some((candidate) => candidate.id === objectId);
  const allowed = !!session && canViewAreaScopes(session.user.role);
  const { load, reload } = useAreaScopes(objectId, allowed && objectKnown);
  const create = useAreaScopeCreate(objectId, reload);

  const tree = useMemo(() => (load.status === 'Ready' ? buildAreaTree(load.items) : null), [load]);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;
  if (!session) return <RouteForbidden label="Зоны объекта доступны после входа в Core." />;
  if (!allowed) return <RouteForbidden label="Раздел «Зоны объекта» доступен руководителю проекта." />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  const screenState: AreaScopeScreenState =
    load.status === 'Ready' && tree
      ? { status: 'Ready', tree }
      : load.status === 'Unavailable'
        ? { status: 'Unavailable', message: load.error.message, reference: load.error.reference }
        : load.status === 'Error'
          ? { status: 'Error', error: load.error }
          : { status: 'Loading' };

  return (
    <AreaScopes
      state={screenState}
      create={create.state}
      onCreate={create.submit}
      onDismissCreateResult={create.reset}
      onRetry={reload}
      sidebar={<AppSidebar />}
      objectName={object.name}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onOpenObject={() => navigate(objectPath(object.id))}
    />
  );
}
