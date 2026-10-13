import type { ScheduleLoad } from '../types/schedule';

/**
 * GPR-1 — the pure rules of `useSchedule`'s state, kept apart from React so they can be tested on their own.
 *
 * A schedule is only ever shown for the key (object / work id) it was fetched for. That is what keeps one object's plan off another
 * object's screen: history stepping from one object straight to another reuses the same route element, and a hook that kept "the last
 * loaded value" across a key change would paint the previous object's schedule under the new object's name until the fetch returned.
 */
export interface ScheduleState<T> {
  key: string | undefined;
  load: ScheduleLoad<T>;
}

/** The state a hook starts in: nothing is fetched (and nothing will be) without a real session and a key — then the block is simply absent. */
export function initialScheduleState<T>(key: string | undefined, enabled: boolean): ScheduleState<T> {
  return { key, load: !enabled || !key ? { status: 'Hidden' } : { status: 'Loading' } };
}

/** The state to start a fetch of `key` from: a refresh of the SAME key keeps its loaded value on screen; any other key starts from `Loading`. */
export function keepForSameKey<T>(previous: ScheduleState<T>, key: string): ScheduleState<T> {
  return previous.key === key && previous.load.status === 'Loaded' ? previous : { key, load: { status: 'Loading' } };
}

/** What the screen is told: a value that belongs to another key is not the screen's, whatever the state still holds. */
export function loadFor<T>(state: ScheduleState<T>, key: string | undefined): ScheduleLoad<T> {
  return state.key === key ? state.load : { status: 'Loading' };
}

/** A failed refresh keeps the last good value of the same key; otherwise the failure is stated. */
export function afterFailure<T>(previous: ScheduleState<T>, key: string, message: string): ScheduleState<T> {
  return previous.key === key && previous.load.status === 'Loaded' ? previous : { key, load: { status: 'Error', message } };
}
