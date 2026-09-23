import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * F4 screen checks: C01 (Company Control Center), O01 (Object Overview), W01
 * (Work Card) — including the Work review corrective patch (see the header
 * comments in view-models/status.ts, c01.ts, o01.ts and w01.ts for what each
 * finding was and why).
 *
 * Run against the same isolated preview page as the design-system specs. Every
 * query below is scoped to its own `[data-section]` — the three screens share
 * one demo object ("Жилой комплекс «Полесье»"), which renders as an
 * interactive control in more than one section (an `ObjectRow` activator on
 * C01, a breadcrumb crumb on W01), so an unscoped page-wide query would be
 * ambiguous the same way it would for the F2/F3 sections above these. W01 has
 * a second, separate section (`w01-accepted`) demonstrating the same screen
 * through `buildW01ViewModel`'s real adapter with no demo override, for the
 * corrective patch's СК-confirmation finding.
 */

const PREVIEW = '/preview.html';

// Intl.NumberFormat('ru-RU') groups thousands with U+00A0 (non-breaking
// space), not a plain space — confirmed directly against the runtime rather
// than assumed, since a literal ASCII space in a test string would silently
// never match the rendered text.
const NBSP = ' ';

async function style(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop),
    property,
  );
}

function c01Section(page: Page): Locator {
  return page.locator('[data-section="c01"]');
}

function o01Section(page: Page): Locator {
  return page.locator('[data-section="o01"]');
}

function w01Section(page: Page): Locator {
  return page.locator('[data-section="w01"]');
}

function w01AcceptedSection(page: Page): Locator {
  return page.locator('[data-section="w01-accepted"]');
}

test.beforeEach(async ({ page }: { page: Page }) => {
  await page.goto(PREVIEW);
  await expect(page.getByRole('heading', { name: 'Design System — F1' })).toBeVisible();
});

test.describe('C01 — Company Control Center', () => {
  test('renders the executive page header', async ({ page }) => {
    const section = c01Section(page);
    await expect(section.getByText('ИСПОЛНИТЕЛЬНЫЙ ОБЗОР', { exact: true })).toBeVisible();
    await expect(section.getByRole('heading', { level: 1, name: 'Портфель объектов' })).toBeVisible();
  });

  test('the portfolio table lists every object with its physical readiness', async ({
    page,
  }) => {
    const table = c01Section(page).getByRole('table', { name: /Объекты компании/ });
    await expect(table.getByRole('button', { name: 'Жилой комплекс «Полесье»' })).toBeVisible();
    await expect(table.getByRole('button', { name: 'Бизнес-центр «Горизонт»' })).toBeVisible();
    await expect(table.getByRole('button', { name: 'Логистический терминал' })).toBeVisible();

    // Physical readiness (СМР), not health status or financial closing.
    await expect(table.getByText('62%', { exact: true })).toBeVisible();
    await expect(table.getByText('88%', { exact: true })).toBeVisible();
  });

  test('the "График" column never shows a schedule verdict — no confirmed per-object source exists', async ({
    page,
  }) => {
    // Two objects have healthStatus RED (one from a real blocker, one from a
    // real schedule delay) and one is GREEN — if this badge still read
    // healthStatus, "Есть отставание"/"По графику" would appear here. Every
    // row must read the same neutral absence marker instead (see
    // NO_SCHEDULE_STATUS in view-models/status.ts).
    const table = c01Section(page).getByRole('table', { name: /Объекты компании/ });
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(table.getByText('Есть отставание')).toHaveCount(0);
    await expect(table.getByText('По графику')).toHaveCount(0);
    await expect(table.getByText('Нет данных')).toHaveCount(4);
  });

  test('attention queue uses management wording, never a work or trade name', async ({ page }) => {
    const section = c01Section(page);
    await expect(
      section.getByText('Есть отставание по графику производства работ', { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText('Есть технологическая блокировка производства работ', { exact: true }),
    ).toBeVisible();

    // The two works actually responsible for these signals are never named here
    // — that is what makes the wording "management", not operational.
    await expect(section.getByText('Отделка фасада')).toHaveCount(0);
    await expect(section.getByText('Монтаж вентфасада')).toHaveCount(0);

    // АОСР/ИД/СДО/financial-closing detail is off this screen entirely.
    await expect(section.getByText('АОСР')).toHaveCount(0);
    await expect(section.getByText(/СДО/)).toHaveCount(0);
  });

  test('activating a portfolio row and an attention item both navigate into the object', async ({
    page,
  }) => {
    const section = c01Section(page);
    const marker = page.locator('[data-activated]');

    await section.getByRole('button', { name: 'Бизнес-центр «Горизонт»' }).click();
    await expect(marker).toHaveText('Бизнес-центр «Горизонт» (C01 → объект)');

    await section.getByRole('button', { name: 'Открыть объект' }).first().click();
    await expect(marker).toHaveText('Жилой комплекс «Полесье» (C01 → объект)');
  });

  test('a portfolio row opens on Enter, same keyboard contract as F2', async ({ page }) => {
    const section = c01Section(page);
    const row = section.getByRole('button', { name: 'Логистический терминал' });
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-activated]')).toHaveText(
      'Логистический терминал (C01 → объект)',
    );
  });

  test('an object with no evaluable data is reported as unevaluated, never as "no problems"', async ({
    page,
  }) => {
    // Логистический терминал (demo-object-3) has healthStatus GRAY — no
    // schedule data at all yet. It must not be silently indistinguishable
    // from a portfolio that was checked and found clean.
    const section = c01Section(page);
    await expect(
      section.getByText('Недостаточно данных для оценки графика по части объектов', { exact: true }),
    ).toBeVisible();
    // The two real, confirmed problems (object 1 blocked, object 4 delayed)
    // are still reported — the insufficient-data note is additional, not a
    // replacement for genuine attention items.
    await expect(
      section.getByText('Есть технологическая блокировка производства работ', { exact: true }),
    ).toBeVisible();
    // The positive "no problems" claim must not appear alongside either of
    // the above — this portfolio was never fully clean nor fully unevaluated.
    await expect(
      section.getByText('Проблем по графику производства работ не выявлено'),
    ).toHaveCount(0);
  });
});

test.describe('O01 — Object Overview', () => {
  test('breadcrumb, header and object details render', async ({ page }) => {
    const section = o01Section(page);
    await expect(
      section.getByRole('navigation', { name: 'Хлебные крошки' }).getByText('Портфель'),
    ).toBeVisible();
    await expect(
      section.getByRole('heading', { level: 1, name: 'Жилой комплекс «Полесье»' }),
    ).toBeVisible();
    await expect(section.getByText('CC-052 · ул. Лесная, 8', { exact: true })).toBeVisible();

    await expect(section.getByText('ООО «Полесье Девелопмент»', { exact: true })).toBeVisible();
    await expect(section.getByText('Дмитрий Соколов', { exact: true })).toBeVisible();
  });

  test('physical readiness renders once, at display scale, separate from the schedule figures', async ({
    page,
  }) => {
    const section = o01Section(page);
    const readiness = section.getByText('62%', { exact: true }).first();
    await expect(readiness).toBeVisible();
    expect(await style(readiness, 'font-size')).toBe('42px');

    // Plan-on-date and fact stay two figures, per §7 — never a computed gap.
    await expect(section.getByText('75%', { exact: true })).toBeVisible();
  });

  test('"Состояние графика" shows plan and fact only — no status badge, no healthStatus verdict', async ({
    page,
  }) => {
    // healthStatus for this object is RED (from a real blocker), but nothing
    // here may say "Есть отставание"/"По графику" for the *object* — that
    // would claim a schedule-specific verdict healthStatus does not confirm
    // (it mixes in issues, staleness and late ИД/СДО). The only "Есть
    // отставание" on this screen belongs to one specific WorkSummaryRow
    // (Отделка фасада), a real per-work figure, not an object-level one.
    const section = o01Section(page);
    const scheduleHeading = section.getByText('Состояние графика', { exact: true });
    await expect(scheduleHeading).toBeVisible();

    const worksTableDelayedBadges = section
      .getByRole('table', { name: /Работы объекта/ })
      .getByText('Есть отставание', { exact: true });
    await expect(worksTableDelayedBadges).toHaveCount(1);
    // Exactly one "Есть отставание" on the whole screen — the works-table
    // one above. If the schedule card still had its own badge, this would be 2.
    await expect(section.getByText('Есть отставание', { exact: true })).toHaveCount(1);
  });

  test('production attention lists every work, with the ones needing attention first', async ({
    page,
  }) => {
    const table = o01Section(page).getByRole('table', { name: /Работы объекта/ });
    const rows = table.locator('tbody tr');

    await expect(rows).toHaveCount(4);
    // Отделка фасада (Delayed) and Монтаж вентфасада (Blocked) sort ahead of
    // the on-track/no-data works — `needsAttention` first, per view-models/o01.ts.
    await expect(rows.nth(0)).toContainText('Отделка фасада');
    await expect(rows.nth(1)).toContainText('Монтаж вентфасада');

    await expect(table.getByText('Заблокировано', { exact: true })).toBeVisible();
  });

  test('quality, ИД and finance are never rendered on the production overview', async ({
    page,
  }) => {
    const section = o01Section(page);
    await expect(section.getByText('АОСР')).toHaveCount(0);
    await expect(section.getByText(/СДО/)).toHaveCount(0);
    await expect(section.getByText('Подтверждено СК', { exact: false })).toHaveCount(0);
  });

  test('breadcrumb "Портфель" and a production row both navigate, independently', async ({
    page,
  }) => {
    const section = o01Section(page);
    const marker = page.locator('[data-activated]');

    await section
      .getByRole('table', { name: /Работы объекта/ })
      .getByRole('button', { name: 'Утепление фасада' })
      .click();
    await expect(marker).toHaveText('Утепление фасада (O01 → работа)');

    await section.getByRole('navigation', { name: 'Хлебные крошки' }).getByRole('button', { name: 'Портфель' }).click();
    await expect(marker).toHaveText('Портфель (O01 → хлебная крошка)');
  });

  test('a blocked work shows its real reason, not just a generic "Заблокировано" badge', async ({
    page,
  }) => {
    // Монтаж вентфасада (demo-work-1-3) carries a real blocker reason in the
    // fixtures. Before this patch the works-table badge said only
    // "Заблокировано" and the reason was dropped; it must now be visible.
    // (The empty case — no blocked works, section omitted entirely — is
    // covered precisely in tests/view-models.test.ts, since this preview's
    // one O01 object always has a blocked work to demonstrate the fix.)
    const section = o01Section(page);
    await expect(section.getByText('Блокировки в производстве', { exact: true })).toBeVisible();
    await expect(section.getByText('Монтаж вентфасада', { exact: true }).first()).toBeVisible();
    await expect(section.getByText('Отделка фасада: не завершена', { exact: true })).toBeVisible();
  });
});

test.describe('W01 — Work Card', () => {
  test('breadcrumb carries Company → Object → Work, and only the work is current', async ({
    page,
  }) => {
    const nav = w01Section(page).getByRole('navigation', { name: 'Хлебные крошки' });
    await expect(nav.getByRole('button', { name: 'Портфель' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Жилой комплекс «Полесье»' })).toBeVisible();
    await expect(nav.getByText('Отделка фасада', { exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('header shows the work, its performer and its schedule state', async ({ page }) => {
    const section = w01Section(page);
    await expect(section.getByRole('heading', { level: 1, name: 'Отделка фасада' })).toBeVisible();
    await expect(
      section.getByText('Жилой комплекс «Полесье» · ООО «ФасадСтройГрупп»', { exact: true }),
    ).toBeVisible();
    await expect(section.getByText('Есть отставание', { exact: true })).toBeVisible();
  });

  test('plan, fact and СК confirmation are three separate figures, never merged', async ({
    page,
  }) => {
    const section = w01Section(page);
    await expect(section.getByText('План работы', { exact: true })).toBeVisible();
    await expect(section.getByText('Факт выполнения', { exact: true })).toBeVisible();
    await expect(section.getByText(`1${NBSP}000`, { exact: true })).toBeVisible();
    await expect(section.getByText('500', { exact: true })).toBeVisible();

    // The СК confirmation demonstration (498 next to a Fact of 500) — a
    // capability the real backend cannot express yet; see view-models/w01.ts.
    // It renders as its own block, not as a third column of the Plan/Fact
    // figure above, and is not labelled "partial" or "full" — that judgement
    // would itself be an inference nobody supplied a source for.
    await expect(section.getByText('Подтверждено СК', { exact: true })).toBeVisible();
    await expect(section.getByText('498', { exact: true })).toBeVisible();

    // No arithmetic difference (500 - 498 = 2, or "-2") is ever displayed.
    await expect(section.getByText('-2', { exact: true })).toHaveCount(0);
  });

  test('a work with no blockers renders no blockers block', async ({ page }) => {
    // demo-work-1-1 ("Отделка фасада") has an empty `blockers` array — a real,
    // confirmed "nothing is blocking this" fact, not an unmeasured gap, so the
    // block is left out rather than shown empty (see W01/index.tsx).
    await expect(w01Section(page).getByText('Причины блокировки')).toHaveCount(0);
  });

  test('does not render a work definition the domain model cannot express', async ({ page }) => {
    // Work type + finish type + layer/pie + execution conditions + zone is the
    // full specified definition, but `Work` only carries the work type today.
    // Rendering a placeholder for the rest would claim a capability that does
    // not exist — see the header comment in view-models/w01.ts.
    const section = w01Section(page);
    await expect(section.getByText('Тип отделки')).toHaveCount(0);
    await expect(section.getByText('Зона', { exact: false })).toHaveCount(0);
    await expect(section.getByText('Слой', { exact: false })).toHaveCount(0);
    await expect(section.getByText('Условия производства')).toHaveCount(0);
  });

  test('schedule dates show plan and fact separately, with an honest dash where nothing happened yet', async ({
    page,
  }) => {
    const section = w01Section(page);
    await expect(section.getByText('01.06.2026', { exact: true })).toBeVisible(); // plannedStart
    await expect(section.getByText('15.08.2026', { exact: true })).toBeVisible(); // plannedFinish
    await expect(section.getByText('03.06.2026', { exact: true })).toBeVisible(); // actualStart
    await expect(section.getByText('Фактическое окончание', { exact: true })).toBeVisible();
    // actualFinishDate is null — the work has not finished — so that one <dd>
    // reads as the absence marker, never a fabricated date. Scoped to the
    // `definition` role (a <dd>) so it does not also match this preview
    // section's own "last activated: —" demo-interaction marker.
    await expect(section.getByRole('definition').filter({ hasText: '—' })).toBeVisible();
  });

  test('breadcrumb navigation back to the object and to the portfolio both fire, independently', async ({
    page,
  }) => {
    const section = w01Section(page);
    const nav = section.getByRole('navigation', { name: 'Хлебные крошки' });
    const marker = page.locator('[data-activated]');

    await nav.getByRole('button', { name: 'Жилой комплекс «Полесье»' }).click();
    await expect(marker).toHaveText('Жилой комплекс «Полесье» (W01 → хлебная крошка)');

    await nav.getByRole('button', { name: 'Портфель' }).click();
    await expect(marker).toHaveText('Портфель (W01 → хлебная крошка)');
  });
});

test.describe('W01 — accepted work, real adapter (no demo override)', () => {
  test('acceptance is shown as a status, never as a restated Fact quantity', async ({ page }) => {
    // Утепление фасада (demo-work-1-2): accepted:true, actualQuantity 800 м².
    // Before this patch, `work.accepted` alone produced a "Подтверждено СК"
    // figure equal to Fact — an inference the backend never confirmed. The
    // real adapter now produces only a status.
    const section = w01AcceptedSection(page);
    await expect(section.getByRole('heading', { level: 1, name: 'Утепление фасада' })).toBeVisible();

    await expect(section.getByText('Принято СК', { exact: true })).toBeVisible();
    // "Подтверждено СК" is the label the PlanFact figure would use if an
    // explicit confirmed quantity existed (see ConfirmedQuantity in the other
    // W01 section) — it must not appear here, where none does.
    await expect(section.getByText('Подтверждено СК', { exact: true })).toHaveCount(0);

    // Fact is still shown, plainly, unaffected by the acceptance decision.
    // (Plan and Fact are both 800 for this fully-completed work, so two
    // elements legitimately match — the point here is that at least one does.)
    await expect(section.getByText('800', { exact: true }).first()).toBeVisible();
  });
});
