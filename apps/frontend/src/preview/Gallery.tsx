import { useState, type ReactNode } from 'react';
import {
  Button,
  DataTable,
  LinkedStage,
  ObjectRow,
  objectColumns,
  PlanFact,
  ProgressBar,
  StatusBadge,
  WorkSummaryRow,
  workSummaryColumns,
  SCOPE_CLASS,
  typeClass,
} from '../design-system';

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

export function Gallery() {
  const [activated, setActivated] = useState('—');
  const [activations, setActivations] = useState(0);

  const activate = (label: string) => {
    setActivated(label);
    setActivations((count) => count + 1);
  };

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
