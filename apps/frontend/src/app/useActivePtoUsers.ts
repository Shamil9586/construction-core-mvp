import { useEffect, useState } from 'react';
import type { UserSummary } from '../types/api';
import { listActivePtoUsers } from '../data/usersApi';

/**
 * F8.2.1-04 (Corrective Patch) — the ADMIN responsible-picker's own data
 * source. A PTO session never needs this (it defaults to itself); fetching
 * it only for `role === 'ADMIN'` keeps every other session's page load
 * exactly as it was before this patch. Shared by `PtoRoute.tsx` and
 * `WorkRoute.tsx` (Decision 1: one implementation, not two).
 *
 * A failed fetch is left as an empty list rather than surfaced as a route
 * error: `CreatePackageResponsible`'s own `pick` mode already renders an
 * explicit "no active PTO users" state for zero options, which is exactly
 * as honest for "couldn't load the list" as for "the list is genuinely
 * empty" — neither is treated as ADMIN having someone to default to.
 */
export function useActivePtoUsers(role: string | undefined): UserSummary[] {
  const [users, setUsers] = useState<UserSummary[]>([]);

  useEffect(() => {
    if (role !== 'ADMIN') {
      setUsers([]);
      return;
    }
    let cancelled = false;
    listActivePtoUsers()
      .then((result) => {
        if (!cancelled) setUsers(result);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  return users;
}
