import { AppShell, Button, PageHeader, typeClass } from '../design-system';
import type { SessionGrantResult } from '../auth/sessionClient';
import { AppSidebar } from './AppSidebar';
import { SignInMethod } from './SignInMethod';
import type { UnavailableAccess } from './sessionState';
import { useSignOutAction } from './useSignOutAction';
import styles from './AuthStatus.module.css';

/**
 * F7 — the application states that come before any data: the session is
 * being checked, there is no session, it ended, it could not be checked, it
 * belongs to a role Core does not serve, or the build itself is not
 * configured. The same pattern as RouteStatus.tsx: every state still mounts
 * `AppShell`/`AppSidebar`, only `<main>` differs.
 *
 * None of these states fetches or shows data, and none of them falls back to
 * the demo fixtures — each says plainly why there is nothing to show.
 */

export type SignInReason = 'NoSession' | 'SignedOut' | 'Expired';

const SIGN_IN_COPY: Record<SignInReason, { title: string; description: string }> = {
  NoSession: {
    title: 'Требуется вход',
    description: 'Чтобы открыть внутреннее приложение, войдите в систему.',
  },
  SignedOut: {
    title: 'Вы вышли из системы',
    description: 'Сессия завершена. Чтобы продолжить работу, войдите снова.',
  },
  Expired: {
    title: 'Сессия истекла',
    description: 'Сессия истекла или больше не действительна. Войдите снова.',
  },
};

export function SessionCheckingScreen() {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <p className={typeClass('body')}>Проверка сессии…</p>
    </AppShell>
  );
}

export function SignInScreen({
  reason,
  onSignedIn,
}: {
  reason: SignInReason;
  onSignedIn: (grant: SessionGrantResult) => void;
}) {
  const copy = SIGN_IN_COPY[reason];

  return (
    <AppShell sidebar={<AppSidebar />}>
      <PageHeader eyebrow="ВХОД" title={copy.title} description={copy.description} />
      <section className={styles.panel}>
        <SignInMethod onSignedIn={onSignedIn} />
      </section>
    </AppShell>
  );
}

export function SessionCheckFailedScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <PageHeader
        eyebrow="ВХОД"
        title="Не удалось проверить сессию"
        description="Сервер не подтвердил сессию, поэтому данные не загружаются."
      />
      <section className={styles.panel}>
        <p role="alert" className={[styles.alert, typeClass('body')].join(' ')}>
          Причина: {message}
        </p>
        <Button variant="Secondary" onClick={onRetry}>
          Повторить
        </Button>
      </section>
    </AppShell>
  );
}

const UNAVAILABLE_COPY: Record<UnavailableAccess, string> = {
  External:
    'Эта учётная запись принадлежит внешнему участнику. Внутреннее приложение предназначено только для сотрудников компании.',
  Unrecognized: 'Роль этой учётной записи не поддерживается внутренним приложением.',
};

/**
 * Architecture Decision 4 — an existing session whose role is not an internal
 * one. Nothing is loaded for it; the only action offered is ending the
 * session, so a different account can sign in.
 */
export function CoreUnavailableScreen({
  access,
  onSignOut,
}: {
  access: UnavailableAccess;
  onSignOut: () => Promise<void>;
}) {
  const signOut = useSignOutAction(onSignOut);

  return (
    <AppShell sidebar={<AppSidebar />}>
      <PageHeader eyebrow="ДОСТУП" title="Внутреннее приложение недоступно" description={UNAVAILABLE_COPY[access]} />
      <section className={styles.panel}>
        <p className={[styles.note, typeClass('body')].join(' ')}>
          Чтобы войти под другой учётной записью, завершите текущую сессию.
        </p>
        {signOut.error ? (
          <p role="alert" className={[styles.alert, typeClass('body-strong')].join(' ')}>
            Не удалось выйти: {signOut.error}
          </p>
        ) : null}
        <Button variant="Secondary" loading={signOut.pending} onClick={signOut.run}>
          Выйти
        </Button>
      </section>
    </AppShell>
  );
}

/**
 * The build's data source is missing or invalid (`resolveCoreRuntime`). Shown
 * instead of the blank page a module-load throw used to leave; no request is
 * made and no demo data is substituted. The technical line is the
 * configuration message itself — it names the build variable, never a value
 * or a secret.
 */
export function ConfigurationErrorScreen({ message }: { message: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <PageHeader
        eyebrow="КОНФИГУРАЦИЯ"
        title="Приложение не настроено"
        description="Источник данных этой сборки не задан или задан неверно. Данные не загружаются и не заменяются демонстрационными."
      />
      <section className={styles.panel}>
        <p className={[styles.technical, typeClass('label')].join(' ')}>
          Техническая причина: <code>{message}</code>
        </p>
      </section>
    </AppShell>
  );
}
