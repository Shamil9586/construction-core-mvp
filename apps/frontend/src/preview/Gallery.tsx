import { useState, type ReactNode } from 'react';
import {
  AppShell,
  Breadcrumb,
  Button,
  DataTable,
  LinkedStage,
  ObjectRow,
  objectColumns,
  PageHeader,
  PlanFact,
  ProgressBar,
  Sidebar,
  StatusBadge,
  WorkSummaryRow,
  workSummaryColumns,
  SCOPE_CLASS,
  typeClass,
  type NavItem,
} from '../design-system';
import { CompanyControlCenter } from '../screens/C01';
import { ObjectOverview } from '../screens/O01';
import { WorkCard } from '../screens/W01';
import { buildC01ViewModel } from '../view-models/c01';
import { buildO01ViewModel } from '../view-models/o01';
import { buildW01ViewModel, type W01ViewModel } from '../view-models/w01';
import {
  demoInspections,
  demoObjects,
  demoSelectedObjectId,
  demoSelectedWorkId,
  demoWorks,
} from '../screens/demo/fixtures';

/**
 * Isolated preview of the design-system components.
 *
 * This page exists to be looked at and to be driven by a browser test. It is not
 * part of the application: `preview.html` is a second Vite entry, served in dev
 * and excluded from the production build, and nothing in the product imports it.
 *
 * The demonstration values below are invented for display. They are not domain
 * data and are not derived from any rule — several are deliberately implausible
 * so that nobody mistakes the page for a screen.
 */

function Section({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <section data-section={id} style={{ marginBottom: 40 }}>
      <h2 className={typeClass('heading-card')} style={{ marginBottom: 16 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'center',
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function Card({
  children,
  span = 4,
}: {
  children: ReactNode;
  span?: 4 | 8 | 12;
}) {
  return (
    <div
      style={{
        background: 'var(--cc-background-surface)',
        border: '1px solid var(--cc-border-default)',
        borderRadius: 'var(--cc-radius-card)',
        padding: 'var(--cc-card-padding)',
        width: `var(--cc-layout-span-${span})`,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

const shellNavItems: NavItem[] = [
  { key: 'dashboard', label: 'Панель' },
  { key: 'objects', label: 'Объекты' },
  { key: 'production', label: 'Производство' },
  { key: 'finance', label: 'Финансы' },
];

const demoTopbar = (
  <>
    <span className={typeClass('ui')}>Производственное ядро</span>
    <span className={typeClass('ui')} style={{ color: 'var(--cc-text-secondary)' }}>
      Демо-пользователь
    </span>
  </>
);

/**
 * `POST /inspections/:id/accept` decides a work as a whole — the backend has no
 * field for "498 of the 500 reported" (see `view-models/w01.ts`'s corrective
 * note). This override exists only so the F4 screen preview can show the
 * two-figure layout the product spec asks for; `buildW01ViewModel` itself
 * never infers a confirmed quantity from `work.accepted` and never produces
 * `ConfirmedQuantity` from real data. The demo number is not labelled "full"
 * or "partial" — that judgement would itself be an inference this override
 * has no more right to make than the adapter does; it is shown plainly next
 * to Fact and left for the reader to compare.
 */
function demoConfirmedQuantity(viewModel: W01ViewModel): W01ViewModel {
  return {
    ...viewModel,
    confirmation: { kind: 'ConfirmedQuantity', value: '498', meta: 'м² · подтверждено СК' },
  };
}

export function Gallery() {
  const [activated, setActivated] = useState('—');
  const [activations, setActivations] = useState(0);
  const [activeNavKey, setActiveNavKey] = useState('objects');
  const [c01NavKey, setC01NavKey] = useState('objects');
  const [o01NavKey, setO01NavKey] = useState('objects');
  const [w01NavKey, setW01NavKey] = useState('production');
  const [w01AcceptedNavKey, setW01AcceptedNavKey] = useState('production');

  const activate = (label: string) => {
    setActivated(label);
    setActivations((count) => count + 1);
  };

  const c01ViewModel = buildC01ViewModel(demoObjects, demoWorks);

  const selectedObject = demoObjects.find((object) => object.id === demoSelectedObjectId);
  if (!selectedObject) throw new Error(`Demo fixture missing object: ${demoSelectedObjectId}`);
  const o01ViewModel = buildO01ViewModel(selectedObject, demoWorks);

  const selectedWork = demoWorks.find((work) => work.id === demoSelectedWorkId);
  if (!selectedWork) throw new Error(`Demo fixture missing work: ${demoSelectedWorkId}`);
  const w01ViewModel = demoConfirmedQuantity(
    buildW01ViewModel(selectedWork, selectedObject, demoInspections),
  );

  // Утепление фасада (demo-work-1-2) is accepted with no explicit confirmed
  // quantity anywhere in the fixtures — the real, non-overridden path through
  // buildW01ViewModel, kept alongside the override above so both are visible:
  // `Accepted` (a status, no number) is what real data produces; `ConfirmedQuantity`
  // is demo-only. See view-models/w01.ts's corrective note.
  const acceptedWork = demoWorks.find((work) => work.id === 'demo-work-1-2');
  if (!acceptedWork) throw new Error('Demo fixture missing work: demo-work-1-2');
  const w01AcceptedViewModel = buildW01ViewModel(acceptedWork, selectedObject, demoInspections);

  return (
    <div
      className={SCOPE_CLASS}
      style={{
        background: 'var(--cc-background-page)',
        minHeight: '100vh',
        padding: 40,
      }}
    >
      <h1 className={typeClass('heading-page')} style={{ marginBottom: 8 }}>
        Design System — F1
      </h1>
      <p
        className={typeClass('ui')}
        style={{ color: 'var(--cc-text-secondary)', marginBottom: 40 }}
      >
        Изолированный просмотр. Значения демонстрационные и не являются данными
        продукта.
      </p>

      <Section title="Data / StatusBadge" id="status-badge">
        <Row>
          <StatusBadge variant="OnTrack">По графику</StatusBadge>
          <StatusBadge variant="Delayed">Есть отставание</StatusBadge>
          <StatusBadge variant="Attention">Требует внимания</StatusBadge>
          <StatusBadge variant="Blocked">Заблокировано</StatusBadge>
          <StatusBadge variant="Neutral">Не предъявлено</StatusBadge>
        </Row>
        <p className={typeClass('label')} style={{ color: 'var(--cc-text-secondary)' }}>
          «Есть отставание» и «Требует внимания» используют один янтарный. Различие
          несёт подпись.
        </p>
      </Section>

      <Section title="Data / ProgressBar" id="progress-bar">
        <Row>
          <ProgressBar value={62} label="Готовность, пример" />
          <ProgressBar value={0} label="Ноль, пример" />
          <ProgressBar value={100} label="Сто процентов, пример" />
          <ProgressBar value={null} label="Без данных, пример" />
        </Row>
        <div style={{ width: 'var(--cc-layout-span-4)' }}>
          <ProgressBar value={62} label="Блочный вариант, пример" size="Block" />
        </div>
      </Section>

      <Section title="Controls / Button" id="button">
        <Row>
          <Button variant="Primary">Разобрать отставание</Button>
          <Button variant="Primary" arrow="forward">
            Открыть производство
          </Button>
          <Button variant="Primary" disabled>
            Недоступно
          </Button>
          <Button variant="Primary" arrow="forward" loading>
            Загрузка
          </Button>
        </Row>
        <Row>
          <Button variant="Secondary">Посмотреть основание</Button>
          <Button variant="Secondary" arrow="back">
            К обзору объекта
          </Button>
          <Button variant="Secondary" disabled>
            Недоступно
          </Button>
          <Button variant="Secondary" arrow="forward" loading>
            Загрузка
          </Button>
        </Row>
        <div style={{ width: 'var(--cc-layout-span-4)' }}>
          <Button variant="Primary" width="Fill" arrow="forward">
            Во всю ширину
          </Button>
        </div>
      </Section>

      <Section title="Data / PlanFact" id="plan-fact">
        <Row>
          <Card>
            <PlanFact
              items={[
                { label: 'План на дату', value: '75%' },
                { label: 'Факт', value: '62%' },
              ]}
            />
          </Card>
          <Card>
            <PlanFact
              emphasis="LeadValue"
              items={[
                { label: 'Факт выполнения', value: '500', meta: 'м² · физически выполнено' },
                { label: 'План работы', value: '1 000', meta: 'м² · оба этажа' },
              ]}
            />
          </Card>
        </Row>
        <Card span={12}>
          <PlanFact
            items={[
              { label: 'План работы', value: '1 000', meta: 'м²' },
              { label: 'Факт выполнения', value: '500', meta: 'м²' },
              { label: 'Готовность', value: '50%' },
              { label: 'План на дату', value: '65%' },
            ]}
          />
        </Card>
      </Section>

      <Section title="Data / LinkedStage" id="linked-stage">
        <Row>
          <Card>
            <LinkedStage
              items={[
                { label: 'ИД по АОСР', state: 'Черновик · номер не присвоен' },
                { label: 'СДО', state: 'Не предъявлено' },
              ]}
              summary={{ label: 'Закрыто по работе', value: '0 ₽' }}
            />
          </Card>
          <Card>
            <LinkedStage
              items={[
                { label: 'ПТО / ИД', state: 'Пакет в подготовке' },
                { label: 'СДО', state: 'Осмечено' },
                { label: 'Финансовое закрытие', state: 'Частично закрыто' },
              ]}
              summary={{ label: 'Закрыто по объекту', value: '2,0 млн ₽' }}
            />
          </Card>
        </Row>
      </Section>

      <Section title="Data / Table · rowType = Object" id="object-table">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Последняя активация: <span data-activated>{activated}</span> · всего
          активаций: <span data-activation-count>{activations}</span>
        </p>
        <DataTable columns={objectColumns} title="Портфель объектов">
          <ObjectRow
            name="Учебный корпус · Северный"
            meta="CC-024 · ул. Строителей, 12"
            responsible="РП · Сергей Волков"
            smr="62%"
            smrProgress={62}
            status={{ variant: 'Delayed', label: 'Есть отставание' }}
            tone="Attention"
            interactive
            onActivate={() => activate('Учебный корпус · Северный')}
          />
          <ObjectRow
            name="Производственный корпус"
            meta="CC-031 · ул. Заводская, 4"
            responsible="РП · Анна Кузнецова"
            smr="88%"
            smrProgress={88}
            status={{ variant: 'OnTrack', label: 'По графику' }}
            interactive
            onActivate={() => activate('Производственный корпус')}
          />
          <ObjectRow
            name="Склад"
            meta="CC-018 · пр. Промышленный, 7"
            responsible="РП · Игорь Лебедев"
            smr="—"
            smrProgress={null}
            status={{ variant: 'Neutral', label: 'Нет данных' }}
          />
        </DataTable>
      </Section>

      <Section title="Data / Table · rowType = WorkSummary" id="work-table">
        <DataTable
          columns={workSummaryColumns}
          title="Производство"
          context="Отделочные работы · 3 из 12 работ объекта"
        >
          <WorkSummaryRow
            name="Подготовка основания"
            performer="ООО «Монолит Отделка»"
            plan="800 м²"
            fact="800 м²"
            smr="100%"
            status={{ variant: 'OnTrack', label: 'По графику' }}
          />
          <WorkSummaryRow
            name="Штукатурка"
            performer="ООО «Монолит Отделка»"
            plan="1 000 м²"
            fact="500 м²"
            smr="50%"
            status={{ variant: 'Delayed', label: 'Есть отставание' }}
            tone="Attention"
            interactive
            onActivate={() => activate('Штукатурка')}
          />
          <WorkSummaryRow
            name="Шпаклёвка"
            performer="ООО «Монолит Отделка»"
            plan="1 000 м²"
            fact="0 м²"
            smr="0%"
            status={{ variant: 'Neutral', label: 'В работе' }}
          />
          <WorkSummaryRow
            name="Окраска"
            performer="ООО «Монолит Отделка»"
            plan="1 000 м²"
            fact="—"
            smr="—"
            status={{ variant: 'Neutral', label: 'Нет данных' }}
          />
        </DataTable>
      </Section>

      <Section title="Data / Table · состояния" id="table-states">
        <div style={{ display: 'grid', gap: 20 }}>
          <DataTable columns={objectColumns} title="Загрузка" state="Loading" />
          <DataTable
            columns={objectColumns}
            title="Пусто"
            state="Empty"
            emptyLabel="Объектов нет"
          />
          <DataTable
            columns={objectColumns}
            title="Ошибка"
            state="Error"
            errorLabel="Не удалось загрузить портфель"
            onRetry={() => activate('Повтор запроса')}
          />
        </div>
      </Section>

      <Section title="Navigation / AppShell" id="app-shell">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Активный раздел: <span data-active-nav>{activeNavKey}</span>
        </p>
        <div
          style={{
            height: 560,
            border: '1px solid var(--cc-border-default)',
            borderRadius: 'var(--cc-radius-card)',
            overflow: 'hidden',
          }}
        >
          <AppShell
            sidebar={
              <Sidebar
                brand={<span className={typeClass('ui-strong')}>Contour</span>}
                caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
                items={shellNavItems}
                activeKey={activeNavKey}
                onNavigate={setActiveNavKey}
                footer={<span>Тестовая среда</span>}
              />
            }
            topbar={
              <>
                <span className={typeClass('ui')}>Производственное ядро</span>
                <span
                  className={typeClass('ui')}
                  style={{ color: 'var(--cc-text-secondary)' }}
                >
                  Демо-пользователь
                </span>
              </>
            }
          >
            <Breadcrumb
              items={[
                {
                  label: 'Объекты',
                  onSelect: () => activate('Объекты (хлебная крошка)'),
                },
                { label: 'Учебный корпус · Северный' },
              ]}
            />
            <PageHeader
              eyebrow="ОБЪЕКТ"
              title="Учебный корпус · Северный"
              description="CC-024 · ул. Строителей, 12"
              actions={
                <Button variant="Secondary" onClick={() => activate('Экспорт')}>
                  Экспорт
                </Button>
              }
            />
            <p className={typeClass('body')}>
              Содержимое экрана рендерится здесь вызывающей стороной. AppShell не
              решает, какой раздел активен, — это состояние снаружи, переданное как
              activeKey и onNavigate; C01/O01/W01 сюда не входят.
            </p>
          </AppShell>
        </div>
      </Section>

      <Section title="Screens / C01 — Company Control Center" id="c01">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Последняя активация: <span>{activated}</span>
        </p>
        <div
          style={{
            height: 900,
            border: '1px solid var(--cc-border-default)',
            borderRadius: 'var(--cc-radius-card)',
            overflow: 'hidden',
          }}
        >
          <CompanyControlCenter
            viewModel={c01ViewModel}
            sidebar={
              <Sidebar
                brand={<span className={typeClass('ui-strong')}>Contour</span>}
                caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
                items={shellNavItems}
                activeKey={c01NavKey}
                onNavigate={setC01NavKey}
                footer={<span>Тестовая среда</span>}
              />
            }
            topbar={demoTopbar}
            onSelectObject={(objectId) => {
              const object = demoObjects.find((o) => o.id === objectId);
              activate(object ? `${object.name} (C01 → объект)` : objectId);
            }}
          />
        </div>
      </Section>

      <Section title="Screens / O01 — Object Overview" id="o01">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Последняя активация: <span>{activated}</span>
        </p>
        <div
          style={{
            height: 900,
            border: '1px solid var(--cc-border-default)',
            borderRadius: 'var(--cc-radius-card)',
            overflow: 'hidden',
          }}
        >
          <ObjectOverview
            viewModel={o01ViewModel}
            sidebar={
              <Sidebar
                brand={<span className={typeClass('ui-strong')}>Contour</span>}
                caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
                items={shellNavItems}
                activeKey={o01NavKey}
                onNavigate={setO01NavKey}
                footer={<span>Тестовая среда</span>}
              />
            }
            topbar={demoTopbar}
            onNavigateHome={() => activate('Портфель (O01 → хлебная крошка)')}
            onSelectWork={(workId) => {
              const work = demoWorks.find((w) => w.id === workId);
              activate(work ? `${work.name} (O01 → работа)` : workId);
            }}
          />
        </div>
      </Section>

      <Section title="Screens / W01 — Work Card" id="w01">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Последняя активация: <span>{activated}</span>
        </p>
        <div
          style={{
            height: 900,
            border: '1px solid var(--cc-border-default)',
            borderRadius: 'var(--cc-radius-card)',
            overflow: 'hidden',
          }}
        >
          <WorkCard
            viewModel={w01ViewModel}
            sidebar={
              <Sidebar
                brand={<span className={typeClass('ui-strong')}>Contour</span>}
                caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
                items={shellNavItems}
                activeKey={w01NavKey}
                onNavigate={setW01NavKey}
                footer={<span>Тестовая среда</span>}
              />
            }
            topbar={demoTopbar}
            onNavigateHome={() => activate('Портфель (W01 → хлебная крошка)')}
            onSelectObject={(objectId) => {
              const object = demoObjects.find((o) => o.id === objectId);
              activate(object ? `${object.name} (W01 → хлебная крошка)` : objectId);
            }}
          />
        </div>
      </Section>

      <Section title="Screens / W01 — accepted work, no demo override" id="w01-accepted">
        <p
          className={typeClass('label')}
          style={{ color: 'var(--cc-text-secondary)', marginBottom: 12 }}
        >
          Тот же экран, через реальный адаптер без демонстрационной подмены:
          работа принята СК (<code>work.accepted</code>), и подтверждение
          показывается только как статус — без сочинённого объёма. Последняя
          активация: <span>{activated}</span>
        </p>
        <div
          style={{
            height: 900,
            border: '1px solid var(--cc-border-default)',
            borderRadius: 'var(--cc-radius-card)',
            overflow: 'hidden',
          }}
        >
          <WorkCard
            viewModel={w01AcceptedViewModel}
            sidebar={
              <Sidebar
                brand={<span className={typeClass('ui-strong')}>Contour</span>}
                caption="ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ"
                items={shellNavItems}
                activeKey={w01AcceptedNavKey}
                onNavigate={setW01AcceptedNavKey}
                footer={<span>Тестовая среда</span>}
              />
            }
            topbar={demoTopbar}
            onNavigateHome={() => activate('Портфель (W01 accepted → хлебная крошка)')}
            onSelectObject={(objectId) => {
              const object = demoObjects.find((o) => o.id === objectId);
              activate(object ? `${object.name} (W01 accepted → хлебная крошка)` : objectId);
            }}
          />
        </div>
      </Section>

      <Section title="Проверка утечек legacy CSS" id="leak-test">
        <Card>
          <h1 data-leak="h1" className={typeClass('heading-page')}>
            h1 со стилем heading-page
          </h1>
          <h2 data-leak="h2" className={typeClass('heading-section')}>
            h2 со стилем heading-section
          </h2>
          <p data-leak="p" className={typeClass('body')}>
            p со стилем body
          </p>
          <small data-leak="small" className={typeClass('meta')}>
            small со стилем meta
          </small>
          <div>
            <strong data-leak="strong" className={typeClass('ui')}>
              strong со стилем ui
            </strong>
          </div>
          <p data-leak="digits" className={typeClass('metric-md')}>
            1111111111 / 0000000000
          </p>
        </Card>
      </Section>
    </div>
  );
}
