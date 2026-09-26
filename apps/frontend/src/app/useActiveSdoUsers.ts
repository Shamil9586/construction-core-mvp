import { useEffect, useState } from 'react';
import type { UserSummary } from '../types/api';
import { listActiveSdoUsers } from '../data/usersApi';

/**
 * F8.3 — the responsible-assignment picker's own data source, on the SDO
 * Case detail screen. Unlike `useActivePtoUsers` (F8.2.1-04), there is no
 * "defaults to itself" mode here: "Responsible SDO employee is assigned by
 * SDO or ADMIN" is a deliberate choice among the SDO team, not a per-session
 * default, so both SDO and ADMIN always pick from this list.
 *
 * A failed fetch is left as an empty list, the same honest-for-both-cases
 * treatment `useActivePtoUsers` already applies to its own failure.
 */
export function useActiveSdoUsers(role: string | undefined): UserSummary[] {
  const [users, setUsers] = useState<UserSummary[]>([]);

  useEffect(() => {
    if (role !== 'SDO' && role !== 'ADMIN') {
      setUsers([]);
      return;
    }
    let cancelled = false;
    listActiveSdoUsers()
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
