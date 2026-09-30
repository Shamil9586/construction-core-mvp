import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminUsersScreen, type AdminUsersLoad, type AdminUsersNotice, type DirectoryLoad } from '../../screens/AdminUsers';
import { AppSidebar } from '../AppSidebar';
import { RouteForbidden } from '../RouteStatus';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canAdministerUsers, adminRoleLabel, type AdminAssignableRole } from '../../auth/internalRoles';
import {
  addCoreUser,
  listAdminUsers,
  listBitrixDepartments,
  listBitrixEmployees,
  updateCoreUser,
  type AdminCoreUser,
  type BitrixEmployee,
} from '../../data/adminUsersApi';
import { buildAdminUserRows } from '../../view-models/adminUsers';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `/admin/users` — ADMIN only. A non-ADMIN session (or the session-less mock
 * runtime) gets an explicit access-denied state and makes no request; the
 * backend enforces ADMIN_USERS on every call regardless of this check.
 */
export function AdminUsersRoute() {
  const { session } = useCoreRuntime();
  if (!session || !canAdministerUsers(session.user.role)) {
    return <RouteForbidden label="Раздел «Пользователи и доступ» доступен только администратору." />;
  }
  return <AdminUsersContainer />;
}

function AdminUsersContainer() {
  const [core, setCore] = useState<AdminUsersLoad>({ status: 'Loading' });
  const [directory, setDirectory] = useState<DirectoryLoad>({ status: 'Loading' });
  const [coreUsers, setCoreUsers] = useState<AdminCoreUser[]>([]);
  const [employees, setEmployees] = useState<BitrixEmployee[] | null>(null);
  const [departments, setDepartments] = useState<Map<string, string> | null>(null);
  const [notice, setNotice] = useState<AdminUsersNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCore({ status: 'Loading' });
    setDirectory({ status: 'Loading' });
    listAdminUsers().then(
      (users) => {
        if (cancelled) return;
        setCoreUsers(users);
        setCore({ status: 'Loaded' });
      },
      (error: unknown) => {
        if (!cancelled) setCore({ status: 'Error', message: message(error) });
      },
    );
    // A directory failure is shown as an error and never as an empty employee list.
    listBitrixEmployees().then(
      async (result) => {
        let names: Map<string, string> | null = null;
        try {
          names = new Map((await listBitrixDepartments()).map((d) => [d.ID, d.NAME ?? `Подразделение № ${d.ID}`]));
        } catch {
          names = null; // department scope may be missing on the portal: context only, degrade to numbers
        }
        if (cancelled) return;
        setEmployees(result.employees);
        setDepartments(names);
        setDirectory({ status: 'Loaded', truncated: result.truncated, departmentsAvailable: names !== null });
      },
      (error: unknown) => {
        if (cancelled) return;
        setEmployees(null);
        setDirectory({ status: 'Error', message: message(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const rows = useMemo(() => buildAdminUserRows(employees, coreUsers, departments), [employees, coreUsers, departments]);

  const mutate = useCallback(async (run: () => Promise<AdminCoreUser>, success: (user: AdminCoreUser) => string) => {
    setBusy(true);
    setNotice(null);
    try {
      const user = await run();
      setCoreUsers((current) => (current.some((u) => u.id === user.id) ? current.map((u) => (u.id === user.id ? user : u)) : [...current, user]));
      setNotice({ kind: 'success', text: success(user) });
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: `Не удалось изменить доступ: ${message(error)}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <AdminUsersScreen
      sidebar={<AppSidebar />}
      rows={rows}
      core={core}
      directory={directory}
      notice={notice}
      busy={busy}
      onRetry={() => setReloadKey((key) => key + 1)}
      onDismissNotice={() => setNotice(null)}
      onAdd={(bitrixUserId: string, role: AdminAssignableRole) =>
        mutate(() => addCoreUser(bitrixUserId, role), (u) => `${u.name} добавлен в Core с ролью «${adminRoleLabel(u.role)}»`)
      }
      onChangeRole={(id, role) =>
        mutate(() => updateCoreUser(id, { role }), (u) => `Роль пользователя ${u.name} изменена: «${adminRoleLabel(u.role)}»`)
      }
      onDeactivate={(id) => mutate(() => updateCoreUser(id, { isActive: false }), (u) => `Доступ пользователя ${u.name} отключён`)}
      onReactivate={(id, role) =>
        mutate(
          () => updateCoreUser(id, role ? { isActive: true, role } : { isActive: true }),
          (u) => `Доступ пользователя ${u.name} включён, роль «${adminRoleLabel(u.role)}». Потребуется новый вход через Bitrix24.`,
        )
      }
    />
  );
}
