import { typeClass } from '../design-system';
import { useCoreRuntime, type CoreSessionInfo } from './CoreRuntimeContext';
import { DATA_SOURCE_LABELS } from './coreRuntime';
import { useSignOutAction } from './useSignOutAction';
import styles from './RuntimeFooter.module.css';

/**
 * F7 — the content of `Sidebar`'s existing `footer` slot.
 *
 * The first line states the data source the running build actually uses
 * (`DATA_SOURCE_LABELS`), replacing F5's fixed «F5 · типизированные
 * демо-данные». It is service context, so it keeps the slot's own `meta`
 * style. The session block — who is signed in, and the one action to end
 * it — is not service context, so it takes `label`/`ui` styles instead
 * (critical actions never sit in `meta`).
 */
export function RuntimeFooter() {
  const runtime = useCoreRuntime();

  return (
    <div className={styles.footer}>
      <span>{DATA_SOURCE_LABELS[runtime.dataSource]}</span>
      {runtime.session ? <SessionControls session={runtime.session} /> : null}
    </div>
  );
}

function SessionControls({ session }: { session: CoreSessionInfo }) {
  const signOut = useSignOutAction(session.signOut);

  return (
    <div className={styles.session}>
      <span className={[styles.user, typeClass('label-strong')].join(' ')}>{session.user.name}</span>
      {session.roleLabel ? <span className={typeClass('label')}>{session.roleLabel}</span> : null}
      <button
        type="button"
        className={[styles.signOut, typeClass('ui-strong')].join(' ')}
        onClick={signOut.run}
        disabled={signOut.pending}
        aria-busy={signOut.pending || undefined}
      >
        Выйти
      </button>
      {signOut.error ? (
        <p role="alert" className={[styles.error, typeClass('label')].join(' ')}>
          Не удалось выйти: {signOut.error}
        </p>
      ) : null}
    </div>
  );
}
