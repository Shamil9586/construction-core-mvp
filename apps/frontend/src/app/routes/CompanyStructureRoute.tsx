import { useCallback, useEffect, useState } from 'react';
import { CompanyStructureScreen, type CompanyStructureLoad, type CompanyStructureNotice } from '../../screens/CompanyStructure';
import { AppSidebar } from '../AppSidebar';
import { RouteForbidden } from '../RouteStatus';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canViewCompanyStructure } from '../../auth/internalRoles';
import { assignOrgMember, getOrgHistory, getOrgStructure, transferOrgMember } from '../../data/orgStructureApi';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `/company-structure` — «Структура компании» (ORG-1). Ordinary engineers, РП and the session-less mock runtime get an
 * explicit access-denied state and make NO request; a functional head is served their own team only by the backend, which
 * enforces visibility and every mutation rule regardless of this check (`canManage` comes from the backend response).
 */
export function CompanyStructureRoute() {
  const { session } = useCoreRuntime();
  if (!session || !canViewCompanyStructure(session.user.role)) {
    return <RouteForbidden label="Раздел «Структура компании» доступен руководству и начальникам подразделений." />;
  }
  return <CompanyStructureContainer />;
}

function CompanyStructureContainer() {
  const [load, setLoad] = useState<CompanyStructureLoad>({ status: 'Loading' });
  const [notice, setNotice] = useState<CompanyStructureNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getOrgStructure().then(
      (structure) => { if (!cancelled) setLoad({ status: 'Loaded', structure }); },
      (error: unknown) => { if (!cancelled) setLoad({ status: 'Error', message: message(error) }); },
    );
    return () => { cancelled = true; };
  }, [reloadKey]);

  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ kind: 'success', text: success });
      setReloadKey((k) => k + 1);
      return true;
    } catch (error) {
      // A stale id/version is a 409: reload so the next attempt names the row that is actually current.
      setNotice({ kind: 'error', text: `Не удалось выполнить: ${message(error)}` });
      setReloadKey((k) => k + 1);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <CompanyStructureScreen
      sidebar={<AppSidebar />}
      load={load}
      notice={notice}
      busy={busy}
      onRetry={() => setReloadKey((k) => k + 1)}
      onDismissNotice={() => setNotice(null)}
      onAssign={(fn, memberUserId, managerUserId) => run(() => assignOrgMember(fn, memberUserId, managerUserId), 'Руководитель назначен')}
      onTransfer={(fn, employee, managerUserId, reason) => (employee.assignment ? run(() => transferOrgMember(fn, employee.userId, managerUserId, reason, employee.assignment!), 'Сотрудник переведён к другому руководителю') : Promise.resolve(false))}
      onLoadHistory={getOrgHistory}
    />
  );
}
