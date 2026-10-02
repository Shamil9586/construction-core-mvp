import { ForbiddenException, UnauthorizedException, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { pool, one, insert } from './db';
import { hasPermission, isPtoRole, Permission, Role } from '../../../packages/domain';
export type Actor = {
    id: string;
    tenantId: string;
    role: Role;
    name: string;
    contractorId?: string;
};
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function requirePermission(a: Actor, p: Permission) { if (!hasPermission(a.role, p))
    throw new ForbiddenException('Недостаточно прав: ' + p); }
export function checkVersion(row: any, version: number) { if (row.version !== version)
    throw new ConflictException('Данные изменены другим пользователем. Обновите страницу.'); }
export async function authenticate(req: any): Promise<Actor> { const token = req.headers.authorization?.replace(/^Bearer /, ''); if (!token)
    throw new UnauthorizedException('Требуется вход'); const u = await one(pool, 'SELECT u.* FROM sessions s JOIN users u ON (u.tenant_id=s.tenant_id AND u.id=s.user_id) WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true', [hash(token)]); if (!u)
    throw new UnauthorizedException('Сессия истекла'); return u; }
export async function session(user: any, c: any = pool) { const token = randomBytes(32).toString('base64url'); await insert(c, 'sessions', user.tenantId, { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) }); return { token, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId } }; }
export function sameSecret(a: string, b: string) { return !!a && !!b && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export function encrypt(value: string) { const key = process.env.TOKEN_ENCRYPTION_KEY; if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes hex'); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join('.'); }
export function decrypt(value: string) { const [iv, tag, data] = value.split('.'); const cipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, 'hex'), Buffer.from(iv, 'hex')); cipher.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString(); }
export async function scoped(c: any, table: string, id: string, a: Actor, lock = false) { if (!/^[a-z_]+$/.test(table))
    throw Error('table'); const row = await one(c, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [a.tenantId, id]); if (!row)
    throw new NotFoundException('Запись не найдена'); return row; }
export async function objectAccess(c: any, a: Actor, objectId: string, write = false) { const o = await scoped(c, 'objects', objectId, a); if (a.role === 'PROJECT_MANAGER' && o.projectManagerId !== a.id)
    throw new ForbiddenException('Объект закреплён за другим РП'); if (a.role === 'CONTRACTOR_VIEWER' && (!a.contractorId || !(await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3', [a.tenantId, objectId, a.contractorId]))))
    throw new ForbiddenException('Нет доступа к объекту'); await ensurePtoObjectScope(c, a, objectId); return o; }
export async function audit(c: any, a: Actor, entityType: string, entityId: string, action: string, oldValue: any, newValue: any, eventType?: string) { await insert(c, 'audit_logs', a.tenantId, { userId: a.id, entityType, entityId, action, oldValue: oldValue ? JSON.stringify(oldValue) : null, newValue: JSON.stringify(newValue) }); if (eventType) {
    const event = await insert(c, 'domain_events', a.tenantId, { eventType, entityId, payload: JSON.stringify({ actorId: a.id, entityType, entityId }) });
    const users = (await c.query("SELECT id FROM users WHERE tenant_id=$1 AND is_active=true AND role IN ('PTO','PTO_HEAD','DEPUTY_DIRECTOR','GENERAL_DIRECTOR','CONSTRUCTION_CONTROL','CONSTRUCTION_CONTROL_HEAD','SDO','SDO_HEAD','PROJECT_MANAGER')", [a.tenantId])).rows;
    for (const user of users)
        await c.query('INSERT INTO notifications(tenant_id,user_id,event_id,title,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [a.tenantId, user.id, event.id, eventType, `${event.id}:${user.id}`]);
} }
export function ensure(allowed: boolean, message: string) { if (!allowed)
    throw new BadRequestException(message); }
// F12-FILE-01 (LOCKED DECISION 3): an ordinary object file (a document or an
// inspection photo) belongs to exactly one object. `attachments` itself
// carries no object_id — it is a bare tenant-scoped blob store — so
// ownership exists only implicitly, through whichever other row references
// an attachment's id first. This proves that reference against every other
// *ordinary* reference already made across the whole tenant: an attachment
// already used by an executive_documents row, or already used as an
// inspection photo, for a *different* object is refused. First use for an
// object establishes nothing persistent (there is no column to set) — it
// simply means no conflicting reference exists yet, so same-object reuse
// (any later document/photo under that same object) keeps working exactly
// as before. Deliberately excludes material_documents: material passports
// and quality certificates are the one locked exception — a company-level
// shared library legitimately reused across multiple objects in the same
// tenant (materials.controller.ts never calls this).
// F12.3 FINAL-R03 corrective: the check above (conflict query) and the
// caller's own insert of the new executive_documents/inspection_photos
// reference are two separate statements — without a shared lock, two
// concurrent first-uses of the SAME never-before-referenced attachment,
// one under Object A and one under Object B, can both run the conflict
// query before either has inserted its reference, both find nothing, and
// both proceed, leaving the one attachment referenced by two objects at
// once. Locking the attachments row itself FOR UPDATE first closes this:
// PostgreSQL serializes any two transactions attempting to lock the same
// row, so the second one blocks until the first COMMITS (by which point its
// reference is visible to the conflict query) or ROLLS BACK (by which point
// there is nothing to conflict with). The lock is held for the rest of the
// enclosing transaction by ordinary PostgreSQL semantics — callers do
// nothing extra to "hold" it through their own subsequent insert. Lock
// order is Attachment-only relative to whatever the caller already locked
// first (Package in createDocument(), Inspection in the photo-attach
// route) — always acquired *after* that primary entity, in both current
// callers, so no reverse-order cycle exists between them.
export async function ensureAttachmentObjectScope(c: any, a: Actor, fileId: string, objectId: string) {
    await c.query('SELECT id FROM attachments WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, fileId]);
    const conflict = await one(c,
        `SELECT 1 FROM executive_documents WHERE tenant_id=$1 AND file_id=$2 AND object_id<>$3
         UNION ALL
         SELECT 1 FROM inspection_photos p JOIN inspections i ON i.tenant_id=p.tenant_id AND i.id=p.inspection_id WHERE p.tenant_id=$1 AND p.attachment_id=$2 AND i.object_id<>$3
         LIMIT 1`,
        [a.tenantId, fileId, objectId]);
    ensure(!conflict, 'Файл уже используется в другом объекте');
}
// F12.3 FINAL-R02 corrective: true command idempotency (LOCKED DECISION 2,
// Option A) for operations that mutate an *existing* versioned row rather
// than creating an independent new one — recordPortionFact(),
// requestPortionInspection(), handoffDocumentationPackageToSdo(),
// returnSdoCaseToPto(), changeSdoClosingStatus() (service.ts). Those already
// lock and version-check the row they mutate, which prevents duplicate
// writes but resolves a retry to 400/409 — proving the first call probably
// succeeded, never returning/referencing what it actually produced. This is
// the minimum mechanism to close that gap: a small, shared, opt-in ledger
// used only by those five confirmed paths, not wired into any other
// mutation in the repository.
//
// claimIdempotentCommand() is called first, before the operation's own
// checkVersion()/row locks, so a retry carrying the same (now-stale)
// version short-circuits to the stored response instead of hitting a
// conflict a genuinely new, unrelated command would still correctly hit.
// The claim's own INSERT ... ON CONFLICT DO NOTHING is the same atomic
// primitive insertIdempotent() uses (db.ts): a concurrent same-key claim
// blocks on the first transaction's uncommitted claim row rather than both
// observing "not found". Claim and mutation share one transaction, so a
// business-rule failure rolls back the claim together with everything else
// — a genuinely failed attempt leaves nothing behind, and a stale command
// without a matching prior success keeps failing normally on retry.
//
// FINAL-R06-C: idempotency is retry safety, not an authorization mechanism.
// A command row's own `created_by` binds a replay to the actor who first
// made it — a different actor who merely learns/reuses the same key is
// rejected outright, even with an identical payload, rather than receiving
// the original actor's response or silently starting a second command under
// the same key. Checked in both the initial-existing branch and the
// post-ON-CONFLICT raced branch, before the payload/scope check, so the
// rejection is reported as "someone else's key" rather than conflated with
// "different data".
export type IdempotentClaim = { replay: false } | { replay: true; response: any };
function payloadEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys)
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
            return false;
    return true;
}
export async function claimIdempotentCommand(c: any, a: Actor, operation: string, idempotencyKey: string | undefined | null, scopeId: string, payload: Record<string, unknown>): Promise<IdempotentClaim> {
    if (!idempotencyKey)
        return { replay: false };
    const existing = await one(c, 'SELECT * FROM idempotent_commands WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [a.tenantId, operation, idempotencyKey]);
    if (existing) {
        ensure(existing.createdBy === a.id, 'Idempotency key уже использован другим пользователем');
        ensure(existing.scopeId === scopeId && payloadEquals(existing.payload, payload), 'Idempotency key уже использован с другими данными');
        return { replay: true, response: existing.response };
    }
    const claimed = await one(c, 'INSERT INTO idempotent_commands(tenant_id,operation,idempotency_key,scope_id,payload,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,operation,idempotency_key) DO NOTHING RETURNING *', [a.tenantId, operation, idempotencyKey, scopeId, JSON.stringify(payload), a.id]);
    if (claimed)
        return { replay: false };
    const raced = await one(c, 'SELECT * FROM idempotent_commands WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [a.tenantId, operation, idempotencyKey]);
    ensure(!!raced, 'Idempotency key conflict');
    ensure(raced.createdBy === a.id, 'Idempotency key уже использован другим пользователем');
    ensure(raced.scopeId === scopeId && payloadEquals(raced.payload, payload), 'Idempotency key уже использован с другими данными');
    return { replay: true, response: raced.response };
}
export async function completeIdempotentCommand(c: any, a: Actor, operation: string, idempotencyKey: string | undefined | null, response: any): Promise<void> {
    if (!idempotencyKey)
        return;
    await c.query('UPDATE idempotent_commands SET response=$4 WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [a.tenantId, operation, idempotencyKey, JSON.stringify(response)]);
}

// PBX-3A (PBX3-D08): object scope for PTO operational authority. PTO_HEAD works
// only on objects it CURRENTLY leads; PTO only on objects where it is CURRENTLY
// an active object member. Nothing is inferred from the organizational team or
// from Bitrix data — only the current object assignment rows count. ADMIN keeps
// its system override, and every other role is untouched here (DEPUTY_DIRECTOR /
// GENERAL_DIRECTOR never had PTO operational permissions, so they gain none).
export async function isCurrentPtoLead(c: any, tenantId: string, objectId: string, userId: string): Promise<boolean> {
    return !!(await one(c, "SELECT 1 FROM object_function_lead_assignments WHERE tenant_id=$1 AND object_id=$2 AND function_code='PTO' AND lead_user_id=$3 AND ended_at IS NULL", [tenantId, objectId, userId]));
}
export async function isCurrentPtoMember(c: any, tenantId: string, objectId: string, userId: string): Promise<boolean> {
    return !!(await one(c, "SELECT 1 FROM object_function_member_assignments WHERE tenant_id=$1 AND object_id=$2 AND function_code='PTO' AND member_user_id=$3 AND ended_at IS NULL", [tenantId, objectId, userId]));
}
// PILOT-W01 UI03: an ACTIVE PTO work assignment (pto_work_assignments, the PTO_HEAD's «Передать в работу») is
// work-scoped PTO access for its assignee — no object-team membership is required or created. It lasts exactly as
// long as the assignment AND while the assignee is still on the object's current PTO_HEAD's functional team (the same
// rule as eligibility): reassignment, or a team change, ends the access. Never granted to anyone else.
export async function hasActivePtoWorkAssignmentOnObject(c: any, tenantId: string, objectId: string, userId: string): Promise<boolean> {
    return !!(await one(c, `SELECT 1 FROM pto_work_assignments pa
        JOIN object_function_lead_assignments l ON l.tenant_id=pa.tenant_id AND l.object_id=pa.object_id AND l.function_code='PTO' AND l.ended_at IS NULL
        JOIN functional_team_memberships t ON t.tenant_id=pa.tenant_id AND t.function_code='PTO' AND t.manager_user_id=l.lead_user_id AND t.member_user_id=pa.assignee_user_id AND t.ended_at IS NULL
        WHERE pa.tenant_id=$1 AND pa.object_id=$2 AND pa.assignee_user_id=$3 AND pa.ended_at IS NULL`, [tenantId, objectId, userId]));
}
export async function ensurePtoObjectScope(c: any, a: Actor, objectId: string) {
    if (!isPtoRole(a.role))
        return;
    const allowed = a.role === 'PTO_HEAD' ? await isCurrentPtoLead(c, a.tenantId, objectId, a.id) : (await isCurrentPtoMember(c, a.tenantId, objectId, a.id)) || (await hasActivePtoWorkAssignmentOnObject(c, a.tenantId, objectId, a.id));
    if (!allowed)
        throw new ForbiddenException(a.role === 'PTO_HEAD' ? 'Вы не являетесь текущим начальником ПТО этого объекта' : 'Вы не назначены на ПТО этого объекта');
}
// PBX-3A (PBX3-D08): a PTO responsible selected for an object's documentation
// package must be active AND currently on that object's PTO team — a current
// PTO object member, or the current PTO_HEAD of that object. Applies to every
// actor including ADMIN; a member removed from the object can never receive
// new responsibility there, while historical attribution is never rewritten.
export async function ensurePtoResponsibleOnObject(c: any, a: Actor, objectId: string, responsible: any) {
    ensure(isPtoRole(responsible.role) && responsible.isActive, 'Назначьте активного сотрудника ПТО');
    const onTeam = responsible.role === 'PTO_HEAD' ? await isCurrentPtoLead(c, a.tenantId, objectId, responsible.id) : await isCurrentPtoMember(c, a.tenantId, objectId, responsible.id);
    ensure(onTeam, 'Ответственный должен входить в текущую команду ПТО этого объекта');
}
