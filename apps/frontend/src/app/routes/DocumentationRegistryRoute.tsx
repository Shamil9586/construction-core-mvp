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
 * The registry is PTO's documentary workspace: it is gated on `canManageDocumentation` (PTO, PTO head, ADMIN) exactly like `/pto` and the
 * package screen. A role that only reads documentation status on W01 (project manager, deputy, CEO, СК) gets the same explanatory message those
 * routes give. Opening a package or a blocker goes to the existing package detail (`packagePath`, with an optional deep link to the
 * section that fixes it).
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
  const allowed = !!session && canManageDocumentation(session.user.role);
  const { load, reload } = useDocumentationRegistry(objectId, query, allowed && objectKnown);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;
  if (!session) return <RouteForbidden label="Реестр ИД доступен после входа в Core." />;
  if (!canManageDocumentation(session.user.role)) {
    return (
      <RouteForbidden
        label={
          canAccessDocumentation(session.user.role)
            ? 'Реестр ИД — рабочая область ПТО. Статус исполнительной документации по работе доступен на странице работы.'
            : 'У вас нет доступа к исполнительной документации.'
        }
      />
    );
  }

  const object = state.snapshot.objects.find((candidate) => candidate.id === objectId);
  if (!object) return <RouteNotFound label="Объект не найден" />;

  // Same gate as the package route the rows lead to, so every row / blocker link is one the viewer may follow.
  const canOpen = true;
  const actions: RegistryActionHandlers = { onOpenPackage: (packageId, link) => navigate(packagePath(packageId, link ? { focus: link.focus, ...(link.aosrId ? { aosrId: link.aosrId } : {}) } : undefined)) };

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
