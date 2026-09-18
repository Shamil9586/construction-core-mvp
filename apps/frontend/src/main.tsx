// React 19 removed ReactDOM.render, which antd v5's imperative APIs (Modal, message,
// notification) relied on internally — without this patch those components mount
// nothing at all (confirmed: zero .ant-message elements ever appear in the DOM).
// https://ant.design/docs/react/v5-for-19
import '@ant-design/v5-patch-for-react-19';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConfigProvider, App as AntdApp, Button, Card, Table, Tag, Progress, Input, Select, Space, Modal, Alert, Spin, Tabs, Empty, message, Statistic, Descriptions, Timeline } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AppstoreOutlined, ApartmentOutlined, TeamOutlined, BuildOutlined, CalendarOutlined, SafetyCertificateOutlined, FileDoneOutlined, CalculatorOutlined, WalletOutlined, DatabaseOutlined, SettingOutlined, ArrowRightOutlined } from '@ant-design/icons';
import './style.css';
import ContractorPanel, { WorkChain } from './ContractorPanel';
import { Gantt, GanttTask } from './Gantt';
const queryClient = new QueryClient();
let token = sessionStorage.getItem('session') ?? '';
async function api(path: string, body?: any) { const r = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok)
    throw Error(data.message ?? 'Ошибка сервера'); return data; }
/**
 * Открыть бинарное вложение (фото приёмки) в новой вкладке. GET /attachments/:id
 * требует Authorization-заголовок (см. attachments.controller.ts), поэтому
 * обычный <a href>/<img src> не сработает — грузим как Blob через fetch и
 * открываем в заранее созданной пустой вкладке (открыта СИНХРОННО, до await,
 * иначе браузер блокирует window.open как потерявший связь с жестом пользователя).
 */
async function openAttachment(attachmentId: string) {
    const win = window.open('', '_blank', 'noopener,noreferrer');
    try {
        const r = await fetch('/api/attachments/' + attachmentId, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
        if (!r.ok)
            throw Error('Не удалось открыть файл');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        if (win)
            win.location.href = url;
        else
            message.warning('Браузер заблокировал открытие вкладки — разрешите всплывающие окна для этого сайта');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    catch (e: any) {
        win?.close();
        message.error(e.message ?? 'Не удалось открыть файл');
    }
}
const roleNames: any = { GENERAL_DIRECTOR: 'Генеральный директор', TECHNICAL_DIRECTOR: 'Технический директор', PROJECT_MANAGER: 'Руководитель проекта', CONSTRUCTION_CONTROL: 'Строительный контроль', PTO: 'ПТО', SDO: 'СДО', ADMIN: 'Администратор', DEPARTMENT_HEAD: 'Руководитель направления', CONTRACTOR_VIEWER: 'Субподрядчик' };
const money = (v: any) => v == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(v) / 1000000) + ' млн ₽';
const pct = (v: any) => v == null ? '—' : Number(v).toFixed(0) + '%';
const date = (v: any) => v ? new Date(v).toLocaleDateString('ru-RU') : '—';
const today = () => new Date().toISOString().slice(0, 10);
const stateNames: any = { PLANNED: 'Запланировано', ACTIVE: 'В работе', COMPLETED: 'Выполнено', WAITING: 'Ожидает СК', ISSUES_FOUND: 'Есть замечания', REINSPECTION: 'Повторная проверка', ACCEPTED: 'Принято', REJECTED: 'Отклонено', OPEN: 'Открыто', READY_FOR_VERIFICATION: 'Проверить устранение', CLOSED: 'Закрыто', DRAFT: 'Черновик', IN_PROGRESS: 'В работе', APPROVED: 'Подтверждено', READY: 'Готово', TRANSFERRED_TO_SDO: 'Передано в СДО', TRANSFERRED: 'Получено СДО', CALCULATED: 'Осмечено', READY_TO_CLOSE: 'Частично закрыто' };
const Status = ({ value }: any) => <Tag>{stateNames[value] ?? value}</Tag>;
const Health = ({ value }: any) => <Tag color={{ GREEN: 'green', YELLOW: 'gold', RED: 'red', GRAY: 'default' }[value]}>{({ GREEN: 'В срок', YELLOW: 'Риск', RED: 'Проблема', GRAY: 'Нет данных' } as any)[value] ?? value}</Tag>;
const navigation = [['', 'Панель', AppstoreOutlined], ['objects', 'Объекты', ApartmentOutlined], ['contractors', 'Субподрядчики', TeamOutlined], ['production', 'Производство', BuildOutlined], ['schedule', 'График', CalendarOutlined], ['inspections', 'Строительный контроль', SafetyCertificateOutlined], ['pto', 'ПТО', FileDoneOutlined], ['sdo', 'СДО', CalculatorOutlined], ['finance', 'Финансы', WalletOutlined], ['materials', 'Материалы', DatabaseOutlined], ['dictionaries', 'Справочники', DatabaseOutlined], ['admin', 'Администрирование', SettingOutlined]] as const;
function Login({ done }: any) { const [role, setRole] = useState('GENERAL_DIRECTOR'), [key, setKey] = useState(''), [error, setError] = useState(''); return <div className="login"><Card><div className="brand-mark">К</div><h1>Контур строительства</h1><p>Вход в тестовую среду</p><Alert type="info" message="Демонстрационные данные. Режим Mock Bitrix24."/><label>Роль<Select value={role} onChange={setRole} options={Object.entries(roleNames).map(([value, label]) => ({ value, label: label as string }))}/></label><label>Тестовый ключ<Input.Password value={key} onChange={e => setKey(e.target.value)} onPressEnter={() => { }}/></label>{error && <Alert type="error" message={error}/>}<Button type="primary" block onClick={async () => { try {
    const s = await api('auth/mock', { role, key });
    token = s.token;
    sessionStorage.setItem('session', token);
    done(s.user);
}
catch (e: any) {
    setError(e.message);
} }}>Войти</Button></Card></div>; }
function RecordForm({ title, fields, onSave, onClose }: any) { const shape = Object.fromEntries(fields.map((f: any) => [f.name, f.optional ? z.string().optional() : z.string().min(1, 'Заполните поле')])); const form = useForm<any>({ resolver: zodResolver(z.object(shape)), defaultValues: Object.fromEntries(fields.map((f: any) => [f.name, f.value ?? ''])) }); const [error, setError] = useState(''); return <Modal open title={title} onCancel={onClose} footer={null}><form onSubmit={form.handleSubmit(async (d) => { try {
    await onSave(d);
    onClose();
}
catch (e: any) {
    setError(e.message);
} })} className="record-form">{fields.map((f: any) => <label key={f.name}>{f.label}{f.options ? <select aria-label={f.label} {...form.register(f.name)}><option value="">Выберите</option>{f.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : f.type === 'file' ? <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={async (e) => { try {
    const file = e.target.files![0];
    const base64 = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
    const uploaded = await api('attachments', { fileName: file.name, mimeType: file.type, base64 });
    form.setValue(f.name, uploaded.id);
    message.success('Файл загружен');
}
catch (e: any) {
    setError(e.message);
} }}/> : <input type={f.type ?? 'text'} step="any" {...form.register(f.name)}/>}<span className="error">{String(form.formState.errors[f.name]?.message ?? '')}</span></label>)}{error && <Alert type="error" message={error}/>} {error.includes('изменены другим') && <Button onClick={async()=>{await queryClient.invalidateQueries();onClose()}}>Обновить данные</Button>}<Button type="primary" htmlType="submit" loading={form.formState.isSubmitting}>Сохранить</Button></form></Modal>; }
function App() {
    const [user, setUser] = useState<any>(null), [form, setForm] = useState<any>(null);
    const [objectTab, setObjectTab] = useState('production');
    // Materials is defined below as a nested function of App (recreated on every App
    // render), so its element type changes on every re-render and React remounts it,
    // wiping any local useState. App itself only re-renders (not remounts) on data
    // changes, so this one piece of cross-render state is lifted up here instead.
    const [materialFileId, setMaterialFileId] = useState('');
    // Same reason as materialFileId above: Admin is a nested function of App,
    // recreated (and remounted by React) on every App render. Its Excel-import
    // preview/selection/scale state is lifted up here for the same fix already
    // applied to Materials.
    const [adminPreview, setAdminPreview] = useState<any>(null);
    const [adminSelected, setAdminSelected] = useState<any[]>([]);
    const [adminScale, setAdminScale] = useState(1000000);
    const nav = useNavigate(), location = useLocation();
    const me = useQuery({ queryKey: ['me'], queryFn: () => api('me'), enabled: !!token, retry: false });
    const actor = user ?? me.data;
    const snapshot = useQuery({ queryKey: ['snapshot'], queryFn: () => api('snapshot'), enabled: !!actor, refetchInterval: 30000 });
    const dictionary = useQuery({ queryKey: ['dict'], queryFn: () => api('dictionaries'), enabled: !!actor });
    const users = useQuery({ queryKey: ['users'], queryFn: () => api('users'), enabled: !!actor });
    const d = snapshot.data;
    const [search, setSearch] = useState(''), [health, setHealth] = useState('ALL'), [planType, setPlanType] = useState('ALL');
    async function mutate(path: string, body: any) { try {
        const result = await api(path, body);
        await queryClient.invalidateQueries();
        message.success('Сохранено');
        return result;
    }
    catch (e: any) {
        message.error(e.message);
        throw e;
    } }
    async function upload(file: File) { const base64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); }); return api('attachments', { fileName: file.name, mimeType: file.type, base64 }); }
    const can = (...roles: string[]) => actor && ['ADMIN', ...roles].includes(actor.role);
    const opts = (arr: any[], label = 'name') => (arr ?? []).map(x => ({ value: x.id, label: label==='name' && x.objectId ? `${d.objects.find(o=>o.id===x.objectId)?.name ?? ''} — ${x.name}` : x[label] }));
    const newObject = () => setForm({ title: 'Новый объект', fields: [{ name: 'externalCode', label: 'УКО' }, { name: 'name', label: 'Название' }, { name: 'address', label: 'Адрес' }, { name: 'organizationName', label: 'Организация', value: 'ООО СЗ «Гор-Строй»' }, { name: 'projectManagerId', label: 'Руководитель проекта', options: opts(users.data?.filter(u => u.role === 'PROJECT_MANAGER')) }, { name: 'contractorId', label: 'Субподрядчик', options: opts(d.contractors) }, { name: 'startDate', label: 'Начало', type: 'date', value: today() }, { name: 'plannedFinishDate', label: 'Срок сдачи', type: 'date' }, { name: 'contractValue', label: 'Стоимость, ₽', type: 'number' }], onSave: async (v) => { const { contractorId, ...b } = v; const o = await mutate('objects', { ...b, contractorIds: [contractorId] }); setObjectTab('production'); nav('/objects/' + o.id); } });
    const newWork = (objectId?: string) => setForm({ title: 'Добавить работу', fields: [{ name: 'objectId', label: 'Объект', options: opts(d.objects), value: objectId }, { name: 'workTypeId', label: 'Вид работ', options: opts(dictionary.data?.workTypes) }, { name: 'name', label: 'Название работы', value: 'Армирование фундамента' }, { name: 'contractorId', label: 'Субподрядчик', options: opts(d.contractors) }, { name: 'responsibleUserId', label: 'Ответственный РП', options: opts(users.data?.filter(u => u.role === 'PROJECT_MANAGER')) }, { name: 'unit', label: 'Единица', value: 'т' }, { name: 'plannedQuantity', label: 'Плановый объём', type: 'number', value: '20' }, { name: 'plannedStartDate', label: 'Начало', type: 'date', value: today() }, { name: 'plannedFinishDate', label: 'Окончание', type: 'date' }, { name: 'estimatedCost', label: 'Ориентировочная стоимость, ₽', type: 'number' }], onSave: v => mutate('works', v) });
    if (!token || me.isError)
        return <Login done={u => { setUser(u); queryClient.clear(); }}/>;
    if (!actor || !d)
        return snapshot.isError ? <Alert type="error" message={snapshot.error.message}/> : <div className="loading"><Spin size="large"/></div>;
    const filteredObjects = d.objects.filter(o => (health === 'ALL' || o.healthStatus === health) && (planType === 'ALL' || d.monthlyPlans?.some(p => p.objectId === o.id && p.planType === planType)) && `${o.name} ${o.address} ${o.externalCode} ${o.contractors.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
    const objectLink = (id: string) => <Link to={'/objects/' + id}>{d.objects.find(o => o.id === id)?.name ?? 'Объект'}</Link>;
    const actionForm = (title: string, path: string, fields: any[], extra: any = {}) => setForm({ title, fields, onSave: v => mutate(path, { ...Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== '')), ...extra }) });
    const worksTable = (works: any[]) => <Table<any> rowKey="id" size="middle" pagination={{ pageSize: 10 }} dataSource={works} scroll={{ x: 1100 }} columns={[{ title: 'Работа / подрядчик', render: (_, w) => <><strong>{w.name}</strong><small>{w.contractor}</small>{w.blockers.length > 0 && <small className="error">{w.blockers.join('; ')}</small>}</> }, { title: 'Объём', render: (_, w) => <>{w.actualQuantity} / {w.plannedQuantity} {w.unit}</> }, { title: 'План / факт', render: (_, w) => <div style={{ minWidth: 130 }}><Progress percent={Math.round(w.actualProgress ?? 0)} size="small" strokeColor={w.scheduleStatus === 'RED' ? '#dc544e' : '#228e7d'}/><small>План {pct(w.plannedProgress)} · Δ {Number(w.variance ?? 0).toFixed(0)} п.п.</small></div> }, { title: 'Срок', render: (_, w) => <>{date(w.plannedFinishDate)}<small>{w.delayDays > 0 ? `${w.delayDays} дн. отставания` : 'В графике'}</small></> }, { title: 'СК / ИД', render: (_, w) => <><Tag color={w.accepted ? 'green' : 'default'}>{w.accepted ? 'Принято' : 'Нет приёмки'}</Tag><Tag>{w.docsReady ? 'ИД готова' : 'ИД не готова'}</Tag></> }, { title: 'Действие', render: (_, w) => <Space direction="vertical">{can('PROJECT_MANAGER') && <><Button size="small" onClick={() => actionForm('Внести факт', `works/${w.id}/progress`, [{ name: 'totalQuantity', label: 'Всего выполнено, ' + w.unit, type: 'number', value: String(Number(w.actualQuantity)) }, { name: 'comment', label: 'Комментарий' }], { version: w.version })}>Внести факт</Button><Button size="small" onClick={() => mutate(`works/${w.id}/inspection-request`, { version: w.version }).catch(() => { })}>Предъявить СК</Button>{w.status === 'PLANNED' && <Button size="small" onClick={() => mutate(`works/${w.id}/start`, { version: w.version }).catch(() => { })}>Начать работу</Button>}</>}{can('PTO') && w.accepted && <Button size="small" onClick={() => mutate('executive-packages', { objectWorkId: w.id }).catch(() => { })}>Создать пакет ИД</Button>}</Space> }]}/>;
    const inspectionsView = (list = d.inspections ?? []) => <><h2>Проверки строительного контроля</h2><Table<any> rowKey="id" dataSource={list} columns={[{ title: 'Объект / работа', render: (_, i) => <>{objectLink(i.objectId)}<small>{d.works.find(w => w.id === i.objectWorkId)?.name}</small></> }, { title: 'Статус', render: (_, i) => <Status value={i.status}/> }, { title: 'Предъявлено', render: (_, i) => date(i.requestedAt) }, { title: 'Действия СК', render: (_, i) => can('CONSTRUCTION_CONTROL') && <Space wrap><Button onClick={() => actionForm('Замечание', `inspections/${i.id}/issues`, [{ name: 'title', label: 'Замечание' }, { name: 'description', label: 'Описание' }, { name: 'severity', label: 'Важность', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(value => ({ value, label: value })) }, { name: 'responsibleUserId', label: 'Ответственный', options: opts(users.data) }, { name: 'dueDate', label: 'Устранить до', type: 'date' }], { version: i.version })}>Замечание</Button><label className="file-button">Фото<input type="file" accept="image/png,image/jpeg" onChange={async (e) => { try {
                const f = await upload(e.target.files![0]);
                await mutate(`inspections/${i.id}/photos`, { attachmentId: f.id });
            }
            catch (err: any) {
                message.error(err.message);
            } }}/></label><Button type="primary" onClick={() => mutate(`inspections/${i.id}/accept`, { version: i.version, comment: 'Проверено, замечания устранены' }).catch(() => { })}>Принять</Button><Button danger onClick={() => actionForm('Отклонить проверку', `inspections/${i.id}/reject`, [{ name: 'comment', label: 'Причина' }], { version: i.version })}>Отклонить</Button></Space> }]}/><h2>Замечания</h2><Table<any> rowKey="id" dataSource={(d.issues ?? []).filter(i => list.some(x => x.id === i.inspectionId))} columns={[{ title: 'Замечание', dataIndex: 'title' }, { title: 'Ответственный', dataIndex: 'responsible' }, { title: 'Срок', render: (_, i) => date(i.dueDate) }, { title: 'Статус', render: (_, i) => <Status value={i.status}/> }, { title: 'Действие', render: (_, i) => <Space>{can('PROJECT_MANAGER') && ['OPEN', 'REJECTED', 'IN_PROGRESS'].includes(i.status) && <Button onClick={() => mutate(`issues/${i.id}/resolve`, { version: i.version }).catch(() => { })}>Устранено</Button>}{can('CONSTRUCTION_CONTROL') && i.status === 'READY_FOR_VERIFICATION' && <Button onClick={() => mutate(`issues/${i.id}/verify`, { version: i.version }).catch(() => { })}>Проверить устранение</Button>}</Space> }]}/></>;
    const ptoView = (list = d.packages ?? []) => <><h2>Исполнительная документация</h2><p className="muted">Принятые работы доступны для формирования пакета в разделе «Производство».</p><Table<any> rowKey="id" dataSource={list} columns={[{ title: 'Объект / работа', render: (_, p) => <>{objectLink(p.objectId)}<small>{d.works.find(w => w.id === p.objectWorkId)?.name}</small></> }, { title: 'Статус', render: (_, p) => <Status value={p.status}/> }, { title: 'Действия ПТО', render: (_, p) => can('PTO') && <Space wrap><Button onClick={() => actionForm('Добавить документ', `executive-documents`, [{ name: 'type', label: 'Тип', value: 'AOSR', options: ['AOSR', 'EXECUTIVE_SCHEME', 'CERTIFICATE', 'PASSPORT', 'OTHER'].map(value => ({ value, label: value })) }, { name: 'number', label: 'Номер' }, { name: 'documentDate', label: 'Дата', type: 'date', value: today() }, { name: 'fileId', label: 'Проверенный файл документа', type: 'file' }], { packageId: p.id })}>Документ</Button><Button onClick={async () => { try {
                const v = await api(`executive-packages/${p.id}/validation`);
                Modal.info({ title: 'Проверка комплекта', content: v.allowed ? 'Комплект готов' : v.reasons.join('. ') });
            }
            catch (e: any) {
                message.error(e.message);
            } }}>Проверить</Button><Button onClick={() => mutate(`executive-packages/${p.id}/ready`, { version: p.version }).catch(() => { })}>Готов</Button><Button type="primary" onClick={() => mutate(`executive-packages/${p.id}/transfer-sdo`, { version: p.version }).catch(() => { })}>Передать в СДО</Button></Space> }]}/><h3>Документы пакетов</h3><Table<any> rowKey="id" dataSource={(d.documents ?? []).filter(doc => list.some(p => p.objectWorkId === doc.objectWorkId))} columns={[{ title: 'Тип', dataIndex: 'type' }, { title: 'Номер', dataIndex: 'number' }, { title: 'Статус', render: (_, x) => <Status value={x.status}/> }, { title: 'Проверка', render: (_, x) => <Space><Button onClick={() => Modal.info({ title: 'Черновик документа', content: <pre style={{ whiteSpace: 'pre-wrap' }}>{x.draftContent}</pre> })}>Черновик</Button>{can('PTO') && <Button onClick={() => mutate(`executive-documents/${x.id}/approve`, { version: x.version }).catch(() => { })}>Подтвердить ПТО</Button>}</Space> }]}/></>;
    const sdoView = (list = d.sdo ?? []) => <><h2>Сметно-договорной отдел</h2><p className="muted">Расчёт выполняется в Гранд-Смете. Здесь фиксируются результат и сумма закрытия.</p><Table<any> rowKey="id" dataSource={list} columns={[{ title: 'Объект / работа', render: (_, s) => <>{objectLink(s.objectId)}<small>{d.works.find(w => w.id === s.objectWorkId)?.name}</small></> }, { title: 'Статус', render: (_, s) => <Status value={s.status}/> }, { title: 'В СДО с', render: (_, s) => date(s.ptoTransferredAt) }, { title: 'Рассчитано', render: (_, s) => money(s.calculatedValue) }, { title: 'Действия', render: (_, s) => can('SDO') && <Space><Button onClick={() => actionForm('Результат осмечивания', `sdo/${s.id}/calculate`, [{ name: 'calculatedValue', label: 'Рассчитанная стоимость, ₽', type: 'number' }], { version: s.version })}>Ввести расчёт</Button><Button type="primary" onClick={() => actionForm('Финансовое закрытие', 'financial-closings', [{ name: 'amount', label: 'Сумма закрытия, ₽', type: 'number' }, { name: 'closingDate', label: 'Дата', type: 'date', value: today() }, { name: 'period', label: 'Период ГГГГ-ММ', value: today().slice(0, 7) }], { sdoCaseId: s.id, version: s.version, idempotencyKey: crypto.randomUUID() })}>Закрыть сумму</Button></Space> }]}/></>;
    // Диаграмма Ганта — перенос сильной стороны construction-erp (см. Gantt.tsx:
    // цветные полосы по scheduleStatus GREEN/YELLOW/RED/GRAY + тултип план/факт),
    // заменяет прежнюю текстовую реализацию. Обёртка сохраняет тот же вызов
    // gantt(works), чтобы не менять оба места использования ниже.
    const gantt = (works: GanttTask[] = d.works) => <Gantt tasks={works.map((w: any) => ({ id: w.id, name: w.name, plannedStartDate: w.plannedStartDate, plannedFinishDate: w.plannedFinishDate, actualProgress: w.actualProgress, plannedProgress: w.plannedProgress, scheduleStatus: w.scheduleStatus }))} />;
    const dashboard = d.dashboard;
    const dashboardView = dashboard ? <><div className="page-heading"><div><div className="eyebrow">ОПЕРАТИВНОЕ УПРАВЛЕНИЕ</div><h1>Куда смотреть сегодня</h1><p>Производство и закрытие · {new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div><Tag color="blue">{dashboard.activeObjects} активных объектов</Tag></div><ContractorPanel data={d}/><div className="kpi-grid">{[['План закрытия', dashboard.plannedClosing], ['Факт за месяц', dashboard.closedThisMonth], ['Потенциал закрытия', dashboard.potentialClosing], ['Прогноз закрытия', dashboard.forecastClosing]].map(([label, value]) => <Card key={label}><div className="muted">{label}</div><div className="kpi-number">{money(value)}</div><small>{label === 'Прогноз закрытия' ? 'Факт + рассчитано к закрытию' : label === 'Потенциал закрытия' ? 'Физически выполнено минус закрыто' : 'Текущий месяц'}</small></Card>)}</div><div className="signals">{[['redObjects', 'Красные объекты', 'RED'], ['yellowObjects', 'Риск по объектам', 'YELLOW'], ['delayedWorks', 'Просрочено работ', 'RED'], ['openInspectionIssues', 'Замечания СК', 'YELLOW'], ['ptoBacklog', 'Работы ждут ИД', 'GRAY'], ['sdoBacklog', 'Дела в СДО', 'GRAY']].map(([key, label, color]) => <div key={key} className={color}><b>{dashboard[key]}</b><span>{label}</span></div>)}</div><Card className="attention"><div className="section-heading"><div><h2>Требует внимания</h2><p>Причина, ответственный и действие по каждому отклонению</p></div><Tag color="red">{dashboard.attentionRequired.length} сигналов</Tag></div><Table<any> rowKey={r => r.entityId + r.title} pagination={{ pageSize: 8 }} dataSource={dashboard.attentionRequired} scroll={{ x: 1050 }} columns={[{ title: 'Объект / подрядчик', render: (_, r) => <>{objectLink(r.objectId)}<small>{r.contractor}</small></> }, { title: 'Проблема', render: (_, r) => <><strong>{r.title}</strong><small>{r.reason}</small></> }, { title: 'Отклонение', render: (_, r) => <><Health value={r.severity}/><small>{r.daysOverdue} дн.</small></> }, { title: 'Денежный эффект', render: (_, r) => money(r.moneyImpact) }, { title: 'Ответственный', dataIndex: 'responsible' }, { title: 'Необходимое действие', dataIndex: 'recommendedAction' }]}/><small>Денежный эффект разных сигналов по одной работе не суммируется.</small></Card><Card title="Где находится потенциал закрытия" style={{ marginTop: 20 }}><div className="money-stages">{Object.entries(dashboard.buckets).map(([k, v]) => <div key={k}><small>{({ notAccepted: 'Не принято СК', pto: 'Ожидает ИД', ready: 'ИД готова', sdo: 'В СДО', calculated: 'Осмечено' } as any)[k]}</small><b>{money(v)}</b></div>)}</div></Card></> : <Alert message="Финансовая панель недоступна для роли подрядчика"/>;
    const objectsView = <><div className="section-heading"><h1>Объекты</h1>{can('PROJECT_MANAGER', 'TECHNICAL_DIRECTOR') && <Button type="primary" onClick={newObject}>Создать объект</Button>}</div><div className="filters"><Input.Search placeholder="Название, адрес, УКО, субподрядчик" value={search} onChange={e => setSearch(e.target.value)}/><Select value={health} onChange={setHealth} options={['ALL', 'GREEN', 'YELLOW', 'RED', 'GRAY'].map(value => ({ value, label: ({ ALL: 'Все статусы', GREEN: 'В срок', YELLOW: 'Риск', RED: 'Проблема', GRAY: 'Нет данных' } as any)[value] }))}/><Select value={planType} onChange={setPlanType} options={[{ value: 'ALL', label: 'Все типы плана' }, { value: 'INTERMEDIATE', label: 'Промежуточный' }, { value: 'FINAL', label: 'Итоговый' }]}/></div><div className="objects-grid">{filteredObjects.map(o => <Card key={o.id} className={'object-card ' + o.healthStatus}><div className="section-heading"><span className="muted">{o.externalCode}</span><Health value={o.healthStatus}/></div><Link to={'/objects/' + o.id}><h2>{o.name}</h2></Link><p>{o.address}</p><small>{o.contractors.join(', ')}</small><Progress percent={Math.round(o.actualProgress ?? 0)} strokeColor="#238d7d"/><div className="section-heading"><small>План {pct(o.plannedProgress)}</small><small>до {date(o.plannedFinishDate)}</small></div><hr /><div className="section-heading"><span>Потенциал <b>{money(o.potential)}</b></span><Link to={'/objects/' + o.id}><ArrowRightOutlined /></Link></div></Card>)}</div></>;
    /**
     * Карточка объекта — 11 вкладок (перенос из construction-erp/ObjectDetail.tsx:
     * Обзор, Производство, График, Строительный контроль, ПТО, Материалы, СДО,
     * Финансы, Фото, Документы, История), но поверх реальных данных/эндпоинтов
     * construction-core (единый snapshot() вместо отдельных запросов на вкладку —
     * так уже устроен весь этот файл). Производство/СК/ПТО/СДО/Финансы уже были
     * реализованы (inspectionsView/ptoView/sdoView, отфильтрованные по объекту) —
     * здесь они только переиспользуются; новые — Обзор, Материалы, Фото,
     * Документы, История.
     */
    function ObjectCard() {
        const { id } = useParams();
        const o = d.objects.find((o: any) => o.id === id);
        if (!o)
            return <Empty description="Объект не найден"/>;
        const works = d.works.filter((w: any) => w.objectId === id);
        const objectInspections = (d.inspections ?? []).filter((i: any) => i.objectId === id);
        const objectPhotos = (d.photos ?? []).filter((p: any) => objectInspections.some((i: any) => i.id === p.inspectionId));
        const objectDocuments = (d.documents ?? []).filter((x: any) => works.some((w: any) => w.id === x.objectWorkId));
        const [photoInspectionId, setPhotoInspectionId] = useState('');
        const [photoIssueId, setPhotoIssueId] = useState('');
        const activeInspectionId = photoInspectionId || objectInspections[0]?.id;
        // Материалы и история — только по объекту; переиспользуют общие
        // эндпоинты GET materials / GET audit (уже применяются в Materials()/Admin()),
        // отфильтрованные на клиенте по этому объекту — новых прав не требуется.
        const materialsQ = useQuery({ queryKey: ['materials'], queryFn: () => api('materials'), enabled: !!actor });
        const auditQ = useQuery({ queryKey: ['audit'], queryFn: () => api('audit'), enabled: !!actor });
        // Active object↔contractor relations (id+version, needed to remove one) — a
        // dedicated object-scoped endpoint, same shape as GET /objects/:id/works.
        const contractorsQ = useQuery({ queryKey: ['object-contractors', id], queryFn: () => api(`objects/${id}/contractors`), enabled: !!actor });
        const objectMaterialBatches = (materialsQ.data?.batches ?? []).filter((b: any) => b.objectId === id);
        const relatedHistoryIds = new Set<string>([
            id!,
            ...works.map((w: any) => w.id),
            ...objectInspections.map((i: any) => i.id),
            ...(d.issues ?? []).filter((i: any) => objectInspections.some((ii: any) => ii.id === i.inspectionId)).map((i: any) => i.id),
            ...(d.packages ?? []).filter((p: any) => p.objectId === id).map((p: any) => p.id),
            ...objectDocuments.map((x: any) => x.id),
            ...(d.sdo ?? []).filter((s: any) => s.objectId === id).map((s: any) => s.id),
            ...(d.closings ?? []).filter((f: any) => f.objectId === id).map((f: any) => f.id),
        ]);
        const objectHistory = (auditQ.data ?? []).filter((a: any) => relatedHistoryIds.has(a.entityId));
        return <><Link to="/objects">← Все объекты</Link><div className="page-heading"><div><h1>{o.name}</h1><p>{o.externalCode} · {o.address}</p><p>РП: {o.responsible} · {o.contractors.join(', ')}</p></div><Health value={o.healthStatus}/></div><div className="kpi-grid">{[['Факт / план', pct(o.actualProgress) + ' / ' + pct(o.plannedProgress)], ['Стоимость', money(o.contractValue)], ['Закрыто', money(o.closed)], ['Потенциал', money(o.potential)]].map(([label, value]) => <Card key={label}><small>{label}</small><h2>{value}</h2></Card>)}</div><WorkChain data={d} works={works}/><Tabs activeKey={objectTab} onChange={setObjectTab} items={[
            { key: 'overview', label: 'Обзор', children: <Card><Descriptions column={2} size="small" bordered>
                <Descriptions.Item label="Статус"><Status value={o.status}/></Descriptions.Item>
                <Descriptions.Item label="УКО">{o.externalCode}</Descriptions.Item>
                <Descriptions.Item label="Руководитель проекта">{o.responsible}</Descriptions.Item>
                <Descriptions.Item label="Организация">{o.organizationName ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="Заказчик">{o.customerName ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="Плановый старт">{date(o.startDate)}</Descriptions.Item>
                <Descriptions.Item label="Плановое завершение">{date(o.plannedFinishDate)}</Descriptions.Item>
                <Descriptions.Item label="Сумма договора">{money(o.contractValue)}</Descriptions.Item>
                <Descriptions.Item label="Физ. готовность" span={2}><Progress percent={Math.round(o.actualProgress ?? 0)} style={{ maxWidth: 320 }}/></Descriptions.Item>
                <Descriptions.Item label="Субподрядчики" span={2}><Space direction="vertical" style={{ width: '100%' }}>
                  <Space wrap>{(contractorsQ.data ?? []).length ? contractorsQ.data.map((rel: any) => <Tag key={rel.id} closable={can('PROJECT_MANAGER', 'TECHNICAL_DIRECTOR')} onClose={() => mutate(`objects/${id}/contractors/${rel.contractorId}/remove`, { version: rel.version }).catch(() => { })}>{rel.contractorName}</Tag>) : <small>не назначены</small>}</Space>
                  {can('PROJECT_MANAGER', 'TECHNICAL_DIRECTOR') && <Button size="small" onClick={() => actionForm('Добавить подрядчика', `objects/${id}/contractors`, [{ name: 'contractorId', label: 'Субподрядчик', options: opts(d.contractors.filter((c: any) => !(contractorsQ.data ?? []).some((rel: any) => rel.contractorId === c.id))) }])}>Добавить подрядчика</Button>}
                </Space></Descriptions.Item>
              </Descriptions></Card> },
            { key: 'production', label: 'Производство', children: <>{can('PROJECT_MANAGER', 'TECHNICAL_DIRECTOR') && <Button onClick={() => newWork(id)}>Добавить работу</Button>}{worksTable(works)}</> },
            { key: 'schedule', label: 'График', children: gantt(works) },
            { key: 'sk', label: 'Строительный контроль', children: inspectionsView(objectInspections) },
            { key: 'pto', label: 'ПТО / документы', children: ptoView(d.packages?.filter((p: any) => p.objectId === id)) },
            { key: 'materials', label: 'Материалы', children: <Space direction="vertical" style={{ width: '100%' }}>
                {can('PTO') && <Button type="primary" onClick={() => setForm({ title: 'Материал и паспорт партии', fields: [{ name: 'objectWorkId', label: 'Работа', options: opts(works) }, { name: 'name', label: 'Материал', value: 'Арматура А500С' }, { name: 'manufacturer', label: 'Производитель' }, { name: 'batchNumber', label: 'Номер партии' }, { name: 'quantity', label: 'Количество', type: 'number' }, { name: 'documentNumber', label: 'Номер паспорта' }, { name: 'validUntil', label: 'Действителен до', type: 'date' }, { name: 'fileId', label: 'Файл паспорта/сертификата', type: 'file' }], onSave: (v: any) => mutate('materials/bind', v) })}>Привязать материал</Button>}
                <Table<any> rowKey="id" loading={materialsQ.isLoading} dataSource={objectMaterialBatches} locale={{ emptyText: 'Материалы ещё не привязаны' }} columns={[
                  { title: 'Материал', render: (_: any, b: any) => materialsQ.data?.materials?.find((m: any) => m.id === b.materialId)?.name ?? '—' },
                  { title: 'Партия №', dataIndex: 'batchNumber', width: 140 },
                  { title: 'Документы', render: (_: any, b: any) => { const docs = (materialsQ.data?.documents ?? []).filter((doc: any) => doc.materialBatchId === b.id); return docs.length ? docs.map((doc: any) => <Tag key={doc.id}>{doc.number ?? doc.type}</Tag>) : <small>нет</small>; } },
                  { title: 'Привязано к работам', render: (_: any, b: any) => { const links = (materialsQ.data?.links ?? []).filter((l: any) => l.materialBatchId === b.id); const names = links.map((l: any) => works.find((w: any) => w.id === l.objectWorkId)?.name).filter(Boolean); return names.length ? names.join(', ') : <small>не привязано</small>; } },
                ]}/>
              </Space> },
            { key: 'sdo', label: 'СДО', children: sdoView(d.sdo?.filter((s: any) => s.objectId === id)) },
            { key: 'finance', label: 'Финансы', children: <Table<any> rowKey="id" dataSource={d.closings?.filter((f: any) => f.objectId === id)} columns={[{ title: 'Период', dataIndex: 'period' }, { title: 'Сумма', render: (_: any, f: any) => money(f.amount) }, { title: 'Дата', render: (_: any, f: any) => date(f.closingDate) }]}/> },
            { key: 'photos', label: 'Фото', children: objectInspections.length === 0 ? <Empty description="У объекта ещё нет проверок строительного контроля — фото прикладываются к конкретной проверке"/> : <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                  <Select style={{ width: 320 }} placeholder="Проверка (работа)" value={activeInspectionId} onChange={(v) => { setPhotoInspectionId(v); setPhotoIssueId(''); }} options={objectInspections.map((i: any) => ({ value: i.id, label: `${works.find((w: any) => w.id === i.objectWorkId)?.name ?? '—'} (${i.status})` }))}/>
                  <Select style={{ width: 260 }} allowClear placeholder="Замечание (необязательно)" value={photoIssueId || undefined} onChange={(v) => setPhotoIssueId(v ?? '')} options={(d.issues ?? []).filter((i: any) => i.inspectionId === activeInspectionId).map((i: any) => ({ value: i.id, label: i.title }))}/>
                  {can('CONSTRUCTION_CONTROL') && <label className="file-button">Загрузить фото<input type="file" accept="image/png,image/jpeg" onChange={async (e) => { try {
                      const f = await upload(e.target.files![0]);
                      await mutate(`inspections/${activeInspectionId}/photos`, { attachmentId: f.id, issueId: photoIssueId || undefined });
                  }
                  catch (err: any) {
                      message.error(err.message);
                  } }}/></label>}
                </Space>
                <Table<any> rowKey="id" dataSource={objectPhotos} locale={{ emptyText: 'Фото ещё не загружены' }} columns={[
                  { title: 'Проверка', render: (_: any, p: any) => { const insp = objectInspections.find((i: any) => i.id === p.inspectionId); return works.find((w: any) => w.id === insp?.objectWorkId)?.name ?? '—'; } },
                  { title: 'Замечание', dataIndex: 'issueId', width: 100, render: (v: string | null) => v ? <Tag color="gold">да</Tag> : '—' },
                  { title: 'Загрузил', render: (_: any, p: any) => users.data?.find((u: any) => u.id === p.uploadedBy)?.name ?? '—' },
                  { title: 'Когда', dataIndex: 'createdAt', width: 150, render: (v: string) => new Date(v).toLocaleString('ru-RU') },
                  { title: 'Просмотр', key: 'view', width: 130, render: (_: any, p: any) => <Button size="small" onClick={() => openAttachment(p.attachmentId)}>Открыть</Button> },
                ]}/>
              </Space> },
            { key: 'documents', label: 'Документы', children: <Table<any> rowKey="id" dataSource={objectDocuments} locale={{ emptyText: 'Документы появятся после формирования в разделе «ПТО»' }} columns={[
                { title: 'Тип', dataIndex: 'type' },
                { title: 'Работа', render: (_: any, x: any) => works.find((w: any) => w.id === x.objectWorkId)?.name },
                { title: 'Номер', dataIndex: 'number' },
                { title: 'Статус', render: (_: any, x: any) => <Status value={x.status}/> },
                { title: 'Проверка', render: (_: any, x: any) => <Space><Button size="small" onClick={() => Modal.info({ title: 'Черновик документа', content: <pre style={{ whiteSpace: 'pre-wrap' }}>{x.draftContent}</pre> })}>Черновик</Button>{can('PTO') && x.status === 'DRAFT' && <Button size="small" onClick={() => mutate(`executive-documents/${x.id}/approve`, { version: x.version }).catch(() => { })}>Подтвердить ПТО</Button>}</Space> },
              ]}/> },
            { key: 'history', label: 'История', children: auditQ.error ? <Alert type="error" message={(auditQ.error as any).message}/> : objectHistory.length === 0 ? <Empty description="Записей пока нет"/> : <Timeline items={objectHistory.map((a: any) => ({ children: <>{a.action} · {a.entityType}<br/><small>{new Date(a.createdAt).toLocaleString('ru-RU')} · {a.author}</small></> }))}/> },
        ]}/></>;
    }
    function Materials({ fileId, setFileId }: any) { const q = useQuery({ queryKey: ['materials'], queryFn: () => api('materials') }); return <><h1>Материалы и документы</h1><Card><p>Загрузите PDF паспорта или сертификата, затем привяжите партию к работе.</p><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={async (e) => { try {
        const f = await upload(e.target.files![0]);
        setFileId(f.id);
        message.success('Файл загружен');
    }
    catch (e: any) {
        message.error(e.message);
    } }}/>{fileId && <><Alert type="success" message="Документ загружен"/><Button type="primary" onClick={() => actionForm('Материал и паспорт партии', 'materials/bind', [{ name: 'objectWorkId', label: 'Работа', options: opts(d.works) }, { name: 'name', label: 'Материал', value: 'Арматура А500С' }, { name: 'manufacturer', label: 'Производитель' }, { name: 'batchNumber', label: 'Номер партии' }, { name: 'quantity', label: 'Количество', type: 'number' }, { name: 'documentNumber', label: 'Номер паспорта' }, { name: 'validUntil', label: 'Действителен до', type: 'date' }], { fileId })}>Привязать к работе</Button></>}</Card><Table<any> rowKey="id" dataSource={q.data?.materials ?? []} columns={[{ title: 'Материал', dataIndex: 'name' }, { title: 'Производитель', dataIndex: 'manufacturer' }]}/></>; }
    function Admin({ preview, setPreview, selected, setSelected, scale, setScale }: any) { const q = useQuery({ queryKey: ['audit'], queryFn: () => api('audit') }); return <><h1>Администрирование</h1>{can('ADMIN') && <Tabs items={[{ key: 'users', label: 'Пользователи', children: <><Space wrap><Button onClick={() => actionForm('Добавить пользователя Bitrix24', 'users', [{ name: 'bitrixUserId', label: 'Числовой ID пользователя Bitrix24' }, { name: 'name', label: 'ФИО' }, { name: 'role', label: 'Роль', options: Object.entries(roleNames).map(([value, label]) => ({ value, label })) }, { name: 'contractorId', label: 'Организация (для внешнего подрядчика)', optional: true, options: opts(d.contractors) }])}>Добавить пользователя</Button><Button onClick={() => actionForm('Новый субподрядчик', 'contractors', [{ name: 'name', label: 'Наименование' }, { name: 'inn', label: 'ИНН', optional: true }])}>Добавить субподрядчика</Button></Space><Table<any> rowKey="id" dataSource={users.data} columns={[{ title: 'ФИО', dataIndex: 'name' }, { title: 'Роль', render: (_, u) => roleNames[u.role] }]}/></> }, { key: 'risk', label: 'Пороги риска', children: <Card><p>Жёлтый порог: {d.risk.yellowVariance} п.п. · Красный: {d.risk.redVariance} п.п. · Актуальность факта: {d.risk.staleDays} дн.</p><Button onClick={() => setForm({ title: 'Настройки риска', fields: Object.entries({ yellowVariance: 'Жёлтый порог, п.п.', redVariance: 'Красный порог, п.п.', staleDays: 'Срок актуальности факта, дни', ptoDays: 'ПТО без передачи, дни', sdoDays: 'Срок СДО, дни', escalateTechnicalDays: 'Эскалация ТД, дни', escalateDirectorDays: 'Эскалация ГД, дни' }).map(([name, label]) => ({ name, label, type: 'number', value: String(d.risk[name]) })), onSave: v => mutate('settings/risk', { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])), version: d.risk.version }) })}>Изменить пороги</Button></Card> }, { key: 'import', label: 'Импорт Excel', children: <Card><p>Сначала проверка и предварительный просмотр. Импортируются выбранные объекты; физические объёмы и исторические закрытия требуют отдельной сверки.</p><Space><Select value={scale} onChange={setScale} options={[{ value: 1, label: 'Суммы в рублях' }, { value: 1000, label: 'Суммы в тыс. ₽' }, { value: 1000000, label: 'Суммы в млн ₽' }]}/><input type="file" accept=".xlsx" onChange={async (e) => { try {
                const file = e.target.files![0];
                const base64 = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
                const result = await api('imports/preview', { fileName: file.name, base64, multiplier: scale });
                setPreview(result);
                setSelected([]);
            }
            catch (e: any) {
                message.error(e.message);
            } }}/></Space>{preview && <><Alert message={`${preview.report.rows.length} строк готовы к выбору; ошибок: ${preview.report.errors.length}; предупреждений: ${preview.report.warnings.length}`} type="info"/><Table<any> rowKey={r => r.source + ':' + r.sourceRow} rowSelection={{ selectedRowKeys: selected, onChange: k => setSelected(k) }} dataSource={preview.report.rows} columns={[{ title: 'Источник', dataIndex: 'source' }, { title: 'УКО', dataIndex: 'externalCode' }, { title: 'Объект', dataIndex: 'name' }, { title: 'Адрес', dataIndex: 'address' }, { title: 'Стоимость', render: (_, r) => money(r.contractValue) }]}/><Button type="primary" disabled={!selected.length} onClick={() => actionForm('Импорт выбранных объектов', `imports/${preview.id}/commit`, [{ name: 'projectManagerId', label: 'Назначить РП', options: opts(users.data?.filter(u => u.role === 'PROJECT_MANAGER')) }, { name: 'contractorId', label: 'Назначить субподрядчика', options: opts(d.contractors) }, { name: 'startDate', label: 'Дата начала', type: 'date' }, { name: 'plannedFinishDate', label: 'Плановая сдача', type: 'date' }, { name: 'period', label: 'Месяц плана ГГГГ-ММ', value: today().slice(0, 7) }], { sourceRows: selected })}>Импортировать выбранные</Button><details><summary>Ошибки и предупреждения</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ errors: preview.report.errors, warnings: preview.report.warnings }, null, 2)}</pre></details></>}</Card> }]}/>}<h2>История действий</h2>{q.error && <Alert message={q.error.message}/>}<Table<any> rowKey="id" dataSource={q.data ?? []} columns={[{ title: 'Дата', render: (_, r) => new Date(r.createdAt).toLocaleString('ru-RU') }, { title: 'Автор', dataIndex: 'author' }, { title: 'Сущность', dataIndex: 'entityType' }, { title: 'Действие', dataIndex: 'action' }]}/></>; }
    return <div className="shell"><aside><Link className="brand" to="/"><span className="brand-mark">К</span><div>КОНТУР<small>СТРОИТЕЛЬСТВО</small></div></Link><div className="nav-caption">ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ</div><nav>{navigation.map(([path, label, Icon]) => <Link key={path} className={location.pathname === '/' + path ? 'active' : ''} to={'/' + path}><Icon aria-hidden="true" />{label}</Link>)}</nav><div className="sidebar-bottom">Тестовая среда<br /><small>Mock Bitrix24 · демоданные</small></div></aside><div className="workspace"><header><span>Производственное ядро</span><Space><span className="user-avatar">{actor.name[0]}</span><div><b>{actor.name}</b><small>{roleNames[actor.role]}</small></div><Button onClick={async () => { await api('auth/logout',{}); token = ''; sessionStorage.removeItem('session'); setUser(null); queryClient.clear(); nav('/'); }}>Выйти</Button></Space></header><main><Routes><Route path="/" element={dashboardView}/><Route path="/objects" element={objectsView}/><Route path="/objects/:id" element={<ObjectCard />}/><Route path="/production" element={<><div className="section-heading"><h1>Производство</h1><Space>{can('PROJECT_MANAGER', 'TECHNICAL_DIRECTOR') && <><Button onClick={() => actionForm('Технологическая зависимость', 'work-dependencies', [{ name: 'predecessorWorkId', label: 'Предыдущая работа', options: opts(d.works) }, { name: 'successorWorkId', label: 'Следующая работа', options: opts(d.works) }], { requiresAcceptance: true })}>Добавить зависимость</Button><Button type="primary" onClick={() => newWork()}>Добавить работу</Button></>}</Space></div>{worksTable(d.works)}</>}/><Route path="/schedule" element={<><h1>График производства работ</h1><p className="muted">Вертикальная линия — сегодня. Заполнение — фактический объём.</p>{gantt()}</>}/><Route path="/inspections" element={inspectionsView()}/><Route path="/pto" element={ptoView()}/><Route path="/sdo" element={sdoView()}/><Route path="/finance" element={<><h1>Финансовое закрытие</h1><Table<any> rowKey="id" dataSource={d.closings ?? []} columns={[{ title: 'Объект', render: (_, f) => objectLink(f.objectId) }, { title: 'Период', dataIndex: 'period' }, { title: 'Закрыто', render: (_, f) => money(f.amount) }, { title: 'Дата', render: (_, f) => date(f.closingDate) }]}/></>}/><Route path="/contractors" element={<ContractorPanel data={d}/>}/><Route path="/materials" element={<Materials fileId={materialFileId} setFileId={setMaterialFileId} />}/><Route path="/dictionaries" element={<><h1>Справочник работ</h1><Table<any> rowKey="id" dataSource={dictionary.data?.workTypes ?? []} columns={[{ title: 'Вид работ', dataIndex: 'name' }, { title: 'Единица', dataIndex: 'unit' }, { title: 'Приёмка СК', render: (_, t) => t.requiresInspection ? 'Обязательна' : 'Нет' }]}/></>}/><Route path="/admin" element={<Admin preview={adminPreview} setPreview={setAdminPreview} selected={adminSelected} setSelected={setAdminSelected} scale={adminScale} setScale={setAdminScale} />}/></Routes></main></div>{form && <RecordForm {...form} onClose={() => setForm(null)}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<ConfigProvider locale={ruRU} theme={{ token: { colorPrimary: '#197d70', borderRadius: 8, fontFamily: 'Inter, Arial, sans-serif', colorText: '#233442' } }}><QueryClientProvider client={queryClient}><AntdApp><BrowserRouter><App /></BrowserRouter></AntdApp></QueryClientProvider></ConfigProvider>);
