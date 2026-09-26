import { Controller, Post, Get, Body, Req, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { onAppInstallWebhook, RealBitrixAdapter } from '../../bitrix';
import { Actor, authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
// user.get и department.get отдают ровно 50 записей на страницу и сдвигаются
// параметром start. Ответ обрезается верхней границей запросов, чтобы портал с
// аномально большим штатом (или портал, игнорирующий start) не превратил чтение
// в бесконечный цикл.
const DIRECTORY_PAGE_SIZE = 50;
const DIRECTORY_MAX_REQUESTS = 40;
// Allowlist на стороне запроса: user.get поддерживает параметр select, поэтому
// портал физически не присылает ни почту, ни телефоны, ни фото, ни дату рождения.
// Ответный санитайзер ниже остаётся вторым слоем и не отменяется этим select.
// department.get параметра select не имеет — там allowlist только ответный.
const USER_SELECT = ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'ACTIVE', 'WORK_POSITION', 'UF_DEPARTMENT'];
const trimmed = (value: any) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
// Числовые идентификаторы Bitrix (PARENT, UF_HEAD) приходят то числом, то строкой,
// то пустым значением — приводим к строке либо к null, без промежуточных форм.
const identifier = (value: any) => typeof value === 'number' && Number.isFinite(value) ? String(value) : trimmed(value) ?? null;
const sortValue = (value: any) => { const raw = typeof value === 'number' ? value : Number(trimmed(value) ?? NaN); return Number.isFinite(raw) ? raw : null; };
// Allowlist, а не blacklist: в ответ попадают только поля, разрешённые скоупом
// user_brief и нужные Core. Почта, телефоны, адреса, служебные UF_* и любая
// метаинформация Bitrix отбрасываются здесь, а не на фронтенде.
function sanitizeEmployee(raw: any) {
    const employee: Record<string, unknown> = {
        ID: String(raw.ID),
        NAME: trimmed(raw.NAME) ?? null,
        LAST_NAME: trimmed(raw.LAST_NAME) ?? null,
        ACTIVE: raw.ACTIVE === true || raw.ACTIVE === 'Y' || raw.ACTIVE === 1 || raw.ACTIVE === '1',
        WORK_POSITION: trimmed(raw.WORK_POSITION) ?? null,
        UF_DEPARTMENT: Array.isArray(raw.UF_DEPARTMENT) ? raw.UF_DEPARTMENT.map(Number).filter(Number.isFinite) : []
    };
    const secondName = trimmed(raw.SECOND_NAME);
    if (secondName) employee.SECOND_NAME = secondName;
    return employee;
}
function sanitizeDepartment(raw: any): Record<string, unknown> {
    return { ID: String(raw.ID), NAME: trimmed(raw.NAME) ?? null, SORT: sortValue(raw.SORT), PARENT: identifier(raw.PARENT), UF_HEAD: identifier(raw.UF_HEAD) };
}
// Общий шлюз обеих витрин: сессия Core, режим bitrix, роль ADMIN и запрет любых
// параметров запроса. Ни tenantId, ни portal, ни member_id, ни токен не могут
// прийти снаружи — tenant берётся исключительно из аутентифицированного Actor.
async function directoryActor(r: any): Promise<Actor> {
    const a = await authenticate(r);
    if (process.env.AUTH_MODE !== 'bitrix')
        throw new UnauthorizedException('Bitrix mode disabled');
    // Первый интеграционный шлюз намеренно уже, чем ADMIN_USERS по матрице прав:
    // читать штат портала может только роль ADMIN.
    requirePermission(a, P.ADMIN_USERS);
    if (a.role !== 'ADMIN')
        throw new ForbiddenException('Недостаточно прав: ADMIN');
    z.object({}).strict().parse({ ...(r.query ?? {}) });
    return a;
}
// Единственный путь к порталу — installedCall: он сам находит установку тенанта,
// сам расшифровывает access token и сам владеет веткой expired_token/refresh.
// Контроллер не видит токенов и не добавляет собственной логики обновления.
//
// strict — режим для оргструктуры. Плоские витрины /users и /departments имеют уже
// проверенный на реальном портале контракт (усечение отдаётся флагом truncated,
// полностраничный повтор считается концом выборки, дубликат — keep-first), и он
// не меняется. Проекции же нужна доказанная полнота: неполный или неоднозначный
// справочник породил бы ложные unknown-ссылки в diagnostics и мог бы спрятать
// цикл или членство, поэтому в strict все три случая — отказ.
async function readDirectory(tenantId: string, method: string, params: any, sanitize: (raw: any) => Record<string, unknown>, strict = false) {
    const adapter = new RealBitrixAdapter();
    const seen = new Map<string, string>();
    const records: Record<string, unknown>[] = [];
    let truncated = false;
    for (let request = 0;; request++) {
        if (request >= DIRECTORY_MAX_REQUESTS) {
            if (strict)
                throw new BadRequestException('Bitrix не отдал справочник целиком: ' + method);
            truncated = true;
            break;
        }
        const page = await adapter.installedCall(tenantId, method, { ...params, start: request * DIRECTORY_PAGE_SIZE });
        if (!Array.isArray(page))
            throw new BadRequestException('Bitrix вернул неожиданный ответ ' + method);
        const known = seen.size;
        for (const raw of page) {
            // Запись без пригодной идентичности — это малформед-ответ, а не запись,
            // которую можно тихо пропустить: пропуск превратил бы испорченную страницу
            // в частичный успех. Падает весь запрос, накопленное не возвращается.
            // Необязательные поля (NAME, SORT, PARENT, UF_HEAD) сюда не относятся —
            // их пустые и кривые значения по-прежнему нормализуются в null.
            if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.ID === undefined || raw.ID === null || raw.ID === '')
                throw new BadRequestException('Bitrix вернул некорректную запись ' + method);
            const record = sanitize(raw);
            // Сравниваются уже нормализованные записи, поэтому ID 7 и "007" — один
            // и тот же сотрудник. Совпадающий дубликат безвреден, расходящийся в
            // strict означает, что портал отдал две разные версии одной записи и
            // выбирать между ними (keep-first/keep-last) нельзя.
            const fingerprint = strict ? JSON.stringify(record) : '';
            const previous = seen.get(record.ID as string);
            if (previous !== undefined) {
                if (previous !== fingerprint)
                    throw new BadRequestException('Bitrix вернул расходящиеся записи с одним идентификатором: ' + method);
                continue;
            }
            seen.set(record.ID as string, fingerprint);
            records.push(record);
        }
        // Bitrix сигнализирует об окончании неполной страницей.
        if (page.length < DIRECTORY_PAGE_SIZE) break;
        // Полная страница, не давшая ни одного нового ID: для плоских витрин это
        // остановка (портал игнорирует start), для strict — недоказуемая полнота,
        // ведь следующая страница могла содержать остаток справочника.
        if (seen.size === known) {
            if (strict)
                throw new BadRequestException('Bitrix не продвинул пагинацию: ' + method);
            break;
        }
    }
    return { records, truncated };
}
// Детерминированный порядок не зависит ни от разбиения Bitrix на страницы, ни от
// разрядности double: канонический ID — десятичная строка без ведущих нулей, поэтому
// более короткая строка всегда меньше, а при равной длине достаточно сравнения по
// кодовым единицам. Number() здесь неприменим (теряет точность на больших ID),
// localeCompare — тоже (зависит от локали процесса).
function compareIds(left: string, right: string) {
    if (left.length !== right.length) return left.length - right.length;
    return left < right ? -1 : left > right ? 1 : 0;
}
const byId = (a: any, b: any) => compareIds(a.ID as string, b.ID as string);
// Подразделения: сначала SORT (пустой — в конец), затем NAME, затем ID.
function compareDepartments(a: any, b: any) {
    if (a.SORT !== b.SORT) return a.SORT === null ? 1 : b.SORT === null ? -1 : (a.SORT as number) - (b.SORT as number);
    if (a.NAME !== b.NAME) return a.NAME === null ? 1 : b.NAME === null ? -1 : (a.NAME as string) < (b.NAME as string) ? -1 : 1;
    return byId(a, b);
}
const byKeys = (...keys: string[]) => (a: any, b: any) => { for (const key of keys) { const order = compareIds(a[key], b[key]); if (order) return order; } return 0; };
const collect = (index: Map<string, string[]>, key: string, value: string) => { const list = index.get(key); if (list) list.push(value); else index.set(key, [value]); };
// ——— Строгая нормализация только для пути оргструктуры ———
// Плоские витрины /users и /departments сохраняют уже проверенный на реальном
// портале мягкий контракт. Проекция же строит граф, поэтому идентификатор, статус
// и ссылка обязаны быть однозначными: любое «почти подходящее» значение здесь
// валит весь запрос, а не превращается молча в 0, false или null.
//
// Идентификатор: положительное целое числом либо десятичной строкой. Канонический
// вид — десятичная строка без ведущих нулей. Длинные строковые ID не проходят через
// Number() и остаются точными.
const CANONICAL_ID = /^0*([1-9][0-9]*)$/;
function strictId(value: any): string {
    const text = typeof value === 'number' ? (Number.isSafeInteger(value) && value > 0 ? String(value) : '')
        : typeof value === 'string' ? value.trim() : '';
    const canonical = CANONICAL_ID.exec(text);
    if (!canonical)
        throw new BadRequestException('Bitrix вернул недопустимый идентификатор');
    return canonical[1];
}
// Ссылка (PARENT, UF_HEAD): отсутствие выражается null, пустой строкой или нулём —
// ноль никогда не бывает настоящим ID и в Bitrix означает «не задано». Любое иное
// непустое значение обязано быть корректным идентификатором.
function strictReference(value: any): string | null {
    if (value === undefined || value === null || value === 0) return null;
    if (typeof value === 'string') { const text = value.trim(); return text === '' || text === '0' ? null : strictId(text); }
    return strictId(value);
}
// ACTIVE: только явно представленные формы. Отсутствующее или неизвестное значение
// не имеет права стать false — иначе проекция молча объявит сотрудника уволенным.
function strictActive(value: any): boolean {
    if (value === true || value === 'Y') return true;
    if (value === false || value === 'N') return false;
    throw new BadRequestException('Bitrix вернул недопустимое значение ACTIVE');
}
// UF_DEPARTMENT: отсутствие — это ноль членств, но скалярная или иная неожиданная
// форма — ошибка. Каждое членство канонизируется, ни одно не отбрасывается.
function strictDepartmentIds(value: any): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value))
        throw new BadRequestException('Bitrix вернул недопустимый UF_DEPARTMENT');
    return [...new Set(value.map(strictId))].sort(compareIds);
}
function strictEmployee(raw: any): Record<string, unknown> {
    const employee: Record<string, unknown> = {
        ID: strictId(raw.ID),
        NAME: trimmed(raw.NAME) ?? null,
        LAST_NAME: trimmed(raw.LAST_NAME) ?? null,
        ACTIVE: strictActive(raw.ACTIVE),
        WORK_POSITION: trimmed(raw.WORK_POSITION) ?? null,
        departmentIds: strictDepartmentIds(raw.UF_DEPARTMENT)
    };
    const secondName = trimmed(raw.SECOND_NAME);
    if (secondName) employee.SECOND_NAME = secondName;
    return employee;
}
// SORT остаётся мягким: это порядок отображения, а не идентичность, и его кривое
// значение по уже согласованному контракту нормализуется в null.
function strictDepartment(raw: any): Record<string, unknown> {
    return { ID: strictId(raw.ID), NAME: trimmed(raw.NAME) ?? null, SORT: sortValue(raw.SORT), PARENT: strictReference(raw.PARENT), UF_HEAD: strictReference(raw.UF_HEAD) };
}
// Цикл в графе PARENT означает, что дерево оргструктуры непредставимо. Обход идёт
// по цепочке родителей (у подразделения не больше одного родителя), серый цвет —
// узел текущей цепочки, чёрный — уже проверенный. Неизвестный родитель обрывает
// цепочку и циклом не является: он уходит в диагностику, а не в ошибку.
function assertAcyclic(departmentById: Map<string, any>) {
    const checked = new Set<string>();
    for (const start of departmentById.keys()) {
        if (checked.has(start)) continue;
        const chain = new Set<string>();
        for (let current: string | undefined = start; current !== undefined && !checked.has(current);) {
            if (chain.has(current))
                throw new BadRequestException('Bitrix вернул циклическую структуру подразделений');
            chain.add(current);
            const parent = departmentById.get(current).PARENT as string | null;
            current = parent !== null && departmentById.has(parent) ? parent : undefined;
        }
        for (const id of chain) checked.add(id);
    }
}
// Проекция строится только из двух уже проверенных витрин и ничего не выдумывает:
// неизвестная ссылка остаётся ссылкой и попадает в diagnostics, а не превращается
// в фиктивное подразделение, в корень или в отброшенное членство. Никакого
// «основного» подразделения не выводится, никакая роль Core не назначается.
function projectOrganization(employeeRecords: Record<string, unknown>[], departmentRecords: Record<string, unknown>[]) {
    const departmentById = new Map(departmentRecords.map(record => [record.ID as string, record]));
    assertAcyclic(departmentById);
    const knownEmployeeIds = new Set(employeeRecords.map(record => record.ID as string));
    const members = new Map<string, string[]>(), children = new Map<string, string[]>();
    const employeesWithoutDepartment: string[] = [];
    const unknownEmployeeDepartmentRefs: { userId: string; departmentId: string }[] = [];
    const departmentsWithUnknownParent: { departmentId: string; parentId: string }[] = [];
    const departmentsWithUnknownHead: { departmentId: string; headUserId: string }[] = [];
    let employeeDepartmentLinks = 0;
    for (const record of employeeRecords) {
        const ID = record.ID as string;
        // UF_DEPARTMENT может содержать несколько подразделений — strictDepartmentIds
        // уже канонизировал и отсортировал их, сохранив все до единого.
        const departmentIds = record.departmentIds as string[];
        employeeDepartmentLinks += departmentIds.length;
        if (!departmentIds.length) employeesWithoutDepartment.push(ID);
        for (const departmentId of departmentIds)
            if (departmentById.has(departmentId)) collect(members, departmentId, ID);
            else unknownEmployeeDepartmentRefs.push({ userId: ID, departmentId });
    }
    const employees = [...employeeRecords].sort(byId);
    for (const record of departmentRecords) {
        const ID = record.ID as string, parent = record.PARENT as string | null, head = record.UF_HEAD as string | null;
        if (parent !== null)
            if (departmentById.has(parent)) collect(children, parent, ID);
            else departmentsWithUnknownParent.push({ departmentId: ID, parentId: parent });
        if (head !== null && !knownEmployeeIds.has(head)) departmentsWithUnknownHead.push({ departmentId: ID, headUserId: head });
    }
    const departments = departmentRecords.map(record => ({
        ...record,
        employeeIds: (members.get(record.ID as string) ?? []).slice().sort(compareIds),
        childrenIds: (children.get(record.ID as string) ?? []).slice().sort(compareIds)
    })).sort(compareDepartments);
    // Корень — только подразделение без PARENT. Неизвестный родитель корнем не делает.
    const roots = departmentRecords.filter(record => record.PARENT === null).map(record => record.ID as string).sort(compareIds);
    return {
        employees,
        departments,
        roots,
        diagnostics: {
            employeesWithoutDepartment: employeesWithoutDepartment.sort(compareIds),
            unknownEmployeeDepartmentRefs: unknownEmployeeDepartmentRefs.sort(byKeys('userId', 'departmentId')),
            departmentsWithUnknownParent: departmentsWithUnknownParent.sort(byKeys('departmentId', 'parentId')),
            departmentsWithUnknownHead: departmentsWithUnknownHead.sort(byKeys('departmentId', 'headUserId'))
        },
        counts: { employees: employees.length, departments: departments.length, roots: roots.length, employeeDepartmentLinks }
    };
}
// Server-to-server ONAPPINSTALL webhook (не browser-flow из auth-модуля) — fail-closed
// за BITRIX_INSTALL_WEBHOOK_ENABLED, см. bitrix.ts.
@Controller()
@ApiTags('Bitrix')
@ApiBearerAuth()
export class BitrixController {
    @Post('bitrix/onappinstall') onAppInstall(@Body() body: any) { return onAppInstallWebhook(body); }
    // Первый шаг интеграции со штатным расписанием портала: только чтение.
    // Ничего не пишется в Core (ни пользователей, ни ролей, ни синхронизации) —
    // это витрина сотрудников установленного портала, привязанная исключительно
    // к tenantId аутентифицированного Actor.
    @Get('bitrix/directory/users')
    async directoryUsers(
    @Req()
    r: any) { const a = await directoryActor(r); const { records, truncated } = await readDirectory(a.tenantId, 'user.get', { select: USER_SELECT }, sanitizeEmployee); return { users: records, count: records.length, truncated }; }
    // Витрина подразделений — подготовка к следующему реальному тестовому шлюзу.
    // Боевое приложение пока имеет только скоуп user_brief, поэтому department.get
    // на настоящем портале ответит ошибкой скоупа; она обязана дойти до клиента как
    // ошибка (fail-closed), а не превратиться в пустой список. Скоуп department
    // добавляется оператором вручную отдельным шагом, не из кода.
    @Get('bitrix/directory/departments')
    async directoryDepartments(
    @Req()
    r: any) { const a = await directoryActor(r); const { records, truncated } = await readDirectory(a.tenantId, 'department.get', {}, sanitizeDepartment); return { departments: records, count: records.length, truncated }; }
    // Оргструктура — производная проекция двух уже проверенных витрин, тоже только
    // чтение. Обе витрины читаются тем же readDirectory напрямую, без внутренних
    // HTTP-вызовов собственных маршрутов; сбой любой из них валит весь запрос,
    // поэтому ни «только сотрудники», ни «только подразделения» вернуться не могут.
    //
    // Это не атомарный снимок: два справочника читаются последовательно, между ними
    // портал может измениться, и повторов/снапшотов здесь нет. Нерезрешённая, но
    // синтаксически корректная ссылка — это диагностика. А вот усечение, отсутствие
    // продвижения пагинации, расходящийся дубликат, некорректный идентификатор или
    // статус, цикл и любой сбой REST обязаны валить весь запрос: на неполных или
    // неоднозначных данных проекция была бы ложной.
    @Get('bitrix/directory/org-structure')
    async orgStructure(
    @Req()
    r: any) { const a = await directoryActor(r); const employees = await readDirectory(a.tenantId, 'user.get', { select: USER_SELECT }, strictEmployee, true); const departments = await readDirectory(a.tenantId, 'department.get', {}, strictDepartment, true); return projectOrganization(employees.records, departments.records); }
}
