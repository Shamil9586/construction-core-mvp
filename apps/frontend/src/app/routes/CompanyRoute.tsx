import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CompanyControlCenter } from '../../screens/C01';
import { CreateObjectForm } from '../../screens/C01/CreateObjectForm';
import { Button, typeClass } from '../../design-system';
import { buildC01ViewModel } from '../../view-models/c01';
import {
  classifySubmitFailure,
  optionsState,
  toInput,
  type CreateObjectDraft,
  type CreateOptionsState,
  type SubmitFailure,
} from '../../view-models/createObject';
import { useRefetchSnapshot, useSnapshot } from '../../data/SnapshotContext';
import { createObject, getObjectCreateOptions, ObjectCreateError } from '../../data/objectCreateApi';
import { canCreateObject } from '../../auth/internalRoles';
import { AppSidebar } from '../AppSidebar';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { objectPath } from '../routePaths';
import { RouteError, RouteLoading } from '../RouteStatus';

/**
 * `/company` — reads the snapshot off the data boundary, runs it through the
 * existing C01 adapter unchanged (`buildC01ViewModel`, F4), and hands the
 * result to the screen. `onSelectObject` is the routing side of C01's own
 * contract — C01 itself still just calls a callback with an id, same as in
 * the preview; only what that callback does (navigate) is new.
 *
 * OBJ-1 — «Добавить объект» is offered only to a confirmed Core session with
 * create-object authority (`canCreateObject`); everyone else gets C01 exactly as before.
 */
export function CompanyRoute() {
  const state = useSnapshot();
  const navigate = useNavigate();
  const { session } = useCoreRuntime();
  const refetch = useRefetchSnapshot();
  const allowed = !!session && canCreateObject(session.user.role);

  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CreateOptionsState>({ kind: 'Loading' });
  const [optionsKey, setOptionsKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOptions({ kind: 'Loading' });
    getObjectCreateOptions().then(
      (loaded) => { if (!cancelled) setOptions(optionsState(loaded)); },
      (error: unknown) => { if (!cancelled) setOptions({ kind: 'Error', message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { cancelled = true; };
  }, [open, optionsKey]);

  const submit = useCallback(async (draft: CreateObjectDraft) => {
    setSubmitting(true);
    setFailure(null);
    try {
      const object = await createObject(toInput(draft));
      setCreated({ id: object.id, name: draft.name.trim() });
      setOpen(false);
      refetch();
    } catch (error) {
      const status = error instanceof ObjectCreateError ? error.status : 0;
      setFailure(classifySubmitFailure(status, error instanceof Error ? error.message : String(error)));
    } finally {
      setSubmitting(false);
    }
  }, [refetch]);

  if (state.status === 'Loading') return <RouteLoading />;
  if (state.status === 'Error') return <RouteError message={state.message} />;

  const viewModel = buildC01ViewModel(state.snapshot.objects, state.snapshot.works);

  const createSlot = allowed ? (
    <>
      {created ? (
        <div role="status" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--cc-p-space-12)', marginTop: 'var(--cc-p-space-16)' }}>
          <span className={typeClass('body')}>Объект «{created.name}» создан.</span>
          <Button variant="Secondary" arrow="forward" onClick={() => navigate(objectPath(created.id))}>Открыть объект</Button>
        </div>
      ) : null}
      {open ? (
        <CreateObjectForm
          options={options}
          submitting={submitting}
          failure={failure}
          onSubmit={(draft) => { void submit(draft); }}
          onCancel={() => { setOpen(false); setFailure(null); }}
          onRetryOptions={() => setOptionsKey((k) => k + 1)}
        />
      ) : null}
    </>
  ) : undefined;

  return (
    <CompanyControlCenter
      viewModel={viewModel}
      sidebar={<AppSidebar />}
      onSelectObject={(objectId) => navigate(objectPath(objectId))}
      onAddObject={allowed && !open ? () => { setCreated(null); setFailure(null); setOpen(true); } : undefined}
      createSlot={createSlot}
    />
  );
}
