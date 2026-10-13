import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DocumentationRegistry } from '../../screens/DocumentationRegistry';
import type { RegistryActionHandlers, RegistryScreenState } from '../../screens/DocumentationRegistry';
import { buildRegistryViewModel, readRegistryQuery, writeRegistryQuery } from '../../view-models/documentationRegistry';
import type { RegistryQuery } from '../../data/documentationRegistryApi';
import { useSnapshot } from '../../data/SnapshotContext';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { useDocumentationRegistry } from '../useDocumentationRegistry';
import { canAccessDocumentation, canManageDocumentation } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { ROUTE_PATHS, objectPath, packagePath } from '../routePaths';
import { RouteError, RouteForbidden, RouteLoading, RouteNotFound } from '../RouteStatus';

/**
 * `/object/:objectId/documentation` — «Реестр ИД», the documentary register of ONE object (ID-AUTO-2).
 *
 * `objectId` comes only from the URL. The object must exist in the viewer's own snapshot (the navigation contract: a mismatched id is a
 * routing error, not a screen to render), and the registry itself is a single server read model — readiness, reasons, counts and filtering
 * are the backend's; this container only reads the URL filters, fetches once per (object, filters) and hands the answer to the screen.
 * Filters live in the URL so a link, a refresh and the back button keep them.
 *
 * Opening a package or a blocker goes to the existing package detail (`packagePath`, with an optional deep link to the section that fixes
 * it) — and only for `canManageDocumentation` roles, the same gate that route already applies. Other roles with documentation access see
 * the same register read-only, without links the package screen would refuse.
 */
export function DocumentationRegistryRoute() {
  const { objectId } = useParams<{ objectId: string }>();
  const state = useSnapshot();
  const { session } = useCoreRuntime();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The URL is the shareable source of the filters; the controls, though, answer immediately — a control bound straight to router state
  // snaps back until the (deferred) URL update lands. So the screen holds the filters locally and mirrors every change into the URL.
  // The local value is replaced only when the URL itself CHANGES (back button, a pasted link, the mirrored update arriving) — never merely
  // because the URL has not caught up with a change just made.
  const urlQuery = useMemo(() => readRegistryQuery(searchParams), [searchParams]);
  const urlKey = writeRegistryQuery(urlQuery).toString();
  const [query, setQuery] = useState<RegistryQuery>(urlQuery);
  const [seenUrlKey, setSeenUrlKey] = useState(urlKey);
  if (urlKey !== seenUrlKey) {
    setSeenUrlKey(urlKey);
    setQuery(urlQuery);
  }

  const objectKnown = state.status === 'Ready' && state.snapshot.objects.some((candidate) => candidate.id === objectId);
  const allowed = !!session && canAccessDocumentation(session.user.role);
  const { load, reload } = useDocumentationRegistry(objectId, query, allowed && objectKnown);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;
  if (!session) return <RouteForbidden label="Реестр ИД доступен после входа в Core." />;
  if (!canAccessDocumentation(session.user.role)) return <RouteForbidden label="У вас нет доступа к исполнительной документации." />;

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  const canOpen = canManageDocumentation(session.user.role);
  const actions: RegistryActionHandlers | undefined = canOpen
    ? { onOpenPackage: (packageId, link) => navigate(packagePath(packageId, link ? { focus: link.focus, ...(link.aosrId ? { aosrId: link.aosrId } : {}) } : undefined)) }
    : undefined;

  const screenState: RegistryScreenState =
    load.status === 'Ready'
      ? { status: 'Ready', viewModel: buildRegistryViewModel(load.payload, query, canOpen), refreshing: load.refreshing }
      : load.status === 'Error'
        ? { status: 'Error', message: load.message }
        : { status: 'Loading' };

  const onQueryChange = (next: RegistryQuery) => {
    setQuery(next);
    setSearchParams(writeRegistryQuery(next), { replace: true });
  };

  return (
    <DocumentationRegistry
      state={screenState}
      query={query}
      onQueryChange={onQueryChange}
      onRetry={reload}
      sidebar={<AppSidebar />}
      objectName={object.name}
      onNavigateHome={() => navigate(ROUTE_PATHS.company)}
      onOpenObject={() => navigate(objectPath(object.id))}
      actions={actions}
    />
  );
}
