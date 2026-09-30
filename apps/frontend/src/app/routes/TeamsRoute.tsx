import { useCallback, useEffect, useState } from 'react';
import { TeamsScreen, type TeamsLoad, type TeamsNotice } from '../../screens/Teams';
import { MyTeamScreen, type MyTeamLoad, type MyTeamNotice } from '../../screens/MyTeam';
import { AppSidebar } from '../AppSidebar';
import { RouteForbidden } from '../RouteStatus';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { canRedistributeTeams, canViewMyPtoTeam, canViewTeamsOverview } from '../../auth/internalRoles';
import {
  acknowledgeHandover,
  addObjectPtoMember,
  adminCompleteHandover,
  endObjectPtoMember,
  getMyTeam,
  getTeamsOverview,
  redistributePto,
} from '../../data/functionTeamsApi';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `/teams` — «Команды и объекты»: DEPUTY_DIRECTOR / ADMIN manage, GENERAL_DIRECTOR reads. Others: access denied, no request. */
export function TeamsRoute() {
  const { session } = useCoreRuntime();
  if (!session || !canViewTeamsOverview(session.user.role)) {
    return <RouteForbidden label="Раздел «Команды и объекты» доступен руководству." />;
  }
  return <TeamsContainer canRedistribute={canRedistributeTeams(session.user.role)} />;
}

function TeamsContainer({ canRedistribute }: { canRedistribute: boolean }) {
  const [load, setLoad] = useState<TeamsLoad>({ status: 'Loading' });
  const [notice, setNotice] = useState<TeamsNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getTeamsOverview().then(
      (overview) => { if (!cancelled) setLoad({ status: 'Loaded', overview }); },
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
      setNotice({ kind: 'error', text: `Не удалось выполнить: ${message(error)}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <TeamsScreen
      sidebar={<AppSidebar />}
      load={load}
      canRedistribute={canRedistribute}
      notice={notice}
      busy={busy}
      onRetry={() => setReloadKey((k) => k + 1)}
      onDismissNotice={() => setNotice(null)}
      onRedistribute={(command) => run(() => redistributePto(command), 'Перераспределение выполнено')}
      onAdminComplete={(handover, reason) => run(() => adminCompleteHandover(handover.id, handover.version, reason), 'Передача дел завершена администратором')}
    />
  );
}

/** `/my-team` — «Моя команда ПТО»: PTO_HEAD manages own objects, PTO reads. */
export function MyTeamRoute() {
  const { session } = useCoreRuntime();
  if (!session || !canViewMyPtoTeam(session.user.role)) {
    return <RouteForbidden label="Раздел «Моя команда ПТО» доступен сотрудникам ПТО." />;
  }
  return <MyTeamContainer userId={session.user.id} canManage={session.user.role === 'PTO_HEAD'} />;
}

function MyTeamContainer({ userId, canManage }: { userId: string; canManage: boolean }) {
  const [load, setLoad] = useState<MyTeamLoad>({ status: 'Loading' });
  const [notice, setNotice] = useState<MyTeamNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMyTeam().then(
      (team) => { if (!cancelled) setLoad({ status: 'Loaded', team }); },
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
      setNotice({ kind: 'error', text: `Не удалось выполнить: ${message(error)}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <MyTeamScreen
      sidebar={<AppSidebar />}
      load={load}
      userId={userId}
      canManage={canManage}
      notice={notice}
      busy={busy}
      onRetry={() => setReloadKey((k) => k + 1)}
      onDismissNotice={() => setNotice(null)}
      onAdd={(objectId, memberUserId) => run(() => addObjectPtoMember(objectId, memberUserId), 'Инженер добавлен в команду объекта')}
      onRemove={(objectId, memberUserId) => run(() => endObjectPtoMember(objectId, memberUserId), 'Инженер снят с объекта')}
      onAcknowledge={(handover) => run(() => acknowledgeHandover(handover.id, handover.version), 'Передача дел подтверждена')}
    />
  );
}
