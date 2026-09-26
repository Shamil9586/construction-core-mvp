import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, typeClass } from '../design-system';
import {
  INTERNAL_CORE_ROLES,
  INTERNAL_ROLE_LABELS,
  isInternalCoreRole,
  type InternalCoreRole,
} from '../auth/internalRoles';
import { fetchAuthMode, signInWithMockKey, type SessionGrantResult } from '../auth/sessionClient';
import styles from './AuthStatus.module.css';

/**
 * F7 (Architecture Decision 1) — how a signed-out user gets a session, decided
 * by what the backend itself reports.
 *
 * `GET /api/health` returns the backend's `authMode`. Only the exact value
 * `"mock"` — a test environment the backend has explicitly started in mock
 * mode — shows Core's test sign-in, which calls the existing
 * `POST /api/auth/mock`. Any other value (`"bitrix"` in production) shows the
 * launch notice and no form at all: in that mode sessions are only created by
 * the Bitrix24 launch flow, and Core invents no other way in. If the mode
 * cannot be determined, nothing is shown either — an unknown mode never
 * unlocks the test sign-in.
 */
export const MOCK_AUTH_MODE = 'mock';
export const BITRIX_AUTH_MODE = 'bitrix';

type AuthModeState =
  | { status: 'Checking' }
  | { status: 'Known'; authMode: string }
  | { status: 'Failed'; message: string };

export interface SignInMethodProps {
  onSignedIn: (grant: SessionGrantResult) => void;
}

export function SignInMethod({ onSignedIn }: SignInMethodProps) {
  const [state, setState] = useState<AuthModeState>({ status: 'Checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'Checking' });

    fetchAuthMode().then(
      (authMode) => {
        if (!cancelled) setState({ status: 'Known', authMode });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: 'Failed', message: error instanceof Error ? error.message : String(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.status === 'Checking') {
    return <p className={[styles.note, typeClass('body')].join(' ')}>Проверка способа входа…</p>;
  }

  if (state.status === 'Failed') {
    return (
      <>
        <p role="alert" className={[styles.alert, typeClass('body')].join(' ')}>
          Не удалось определить способ входа: {state.message}
        </p>
        <Button variant="Secondary" onClick={() => setAttempt((count) => count + 1)}>
          Повторить
        </Button>
      </>
    );
  }

  if (state.authMode === MOCK_AUTH_MODE) return <MockSignInForm onSignedIn={onSignedIn} />;

  return <LaunchOnlyNotice authMode={state.authMode} />;
}

/**
 * The test sign-in. Offers the internal roles only (Architecture Decision 3):
 * the options come from `INTERNAL_CORE_ROLES`, so `CONTRACTOR_VIEWER` is not
 * a value this form can produce, and `signInWithMockKey` re-checks the role
 * before any request is sent.
 */
function MockSignInForm({ onSignedIn }: SignInMethodProps) {
  const [role, setRole] = useState<InternalCoreRole>(INTERNAL_CORE_ROLES[0]);
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const roleId = useId();
  const keyId = useId();

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      onSignedIn(await signInWithMockKey(role, key));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  }

  return (
    <form className={styles.form} aria-labelledby={titleId} onSubmit={(event) => void submit(event)}>
      <h2 id={titleId} className={[styles.heading, typeClass('heading-card')].join(' ')}>
        Тестовый вход
      </h2>
      <p className={[styles.note, typeClass('body')].join(' ')}>
        Сервер работает в тестовом режиме входа (mock). Этот вход существует только в тестовой среде.
      </p>

      <div className={styles.field}>
        <label htmlFor={roleId} className={[styles.fieldLabel, typeClass('label-strong')].join(' ')}>
          Роль
        </label>
        <select
          id={roleId}
          className={[styles.control, typeClass('ui')].join(' ')}
          value={role}
          onChange={(event) => {
            if (isInternalCoreRole(event.target.value)) setRole(event.target.value);
          }}
        >
          {INTERNAL_CORE_ROLES.map((option) => (
            <option key={option} value={option}>
              {INTERNAL_ROLE_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor={keyId} className={[styles.fieldLabel, typeClass('label-strong')].join(' ')}>
          Тестовый ключ
        </label>
        <input
          id={keyId}
          className={[styles.control, typeClass('ui')].join(' ')}
          type="password"
          autoComplete="off"
          required
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>

      {error ? (
        <p role="alert" className={[styles.alert, typeClass('body-strong')].join(' ')}>
          {error}
        </p>
      ) : null}

      <div>
        <Button type="submit" loading={pending}>
          Войти
        </Button>
      </div>
    </form>
  );
}

/**
 * Any non-mock auth mode. States where a session comes from instead of
 * offering a way to create one: there is no Core login in that mode.
 */
function LaunchOnlyNotice({ authMode }: { authMode: string }) {
  const bitrix = authMode === BITRIX_AUTH_MODE;

  return (
    <>
      <h2 className={[styles.heading, typeClass('heading-card')].join(' ')}>
        {bitrix ? 'Вход через Битрикс24' : 'Вход через утверждённый запуск'}
      </h2>
      <p className={[styles.alert, typeClass('body')].join(' ')}>
        {bitrix
          ? 'В этой среде вход выполняется только через запуск приложения из портала Битрикс24. Откройте приложение в Битрикс24.'
          : 'В этой среде вход выполняется только через утверждённый запуск приложения. Откройте приложение через него.'}
      </p>
      <p className={[styles.note, typeClass('body')].join(' ')}>
        Отдельного входа по ключу или паролю во внутреннем приложении нет.
      </p>
    </>
  );
}
