import { test, expect, type Locator } from '@playwright/test';

/**
 * Table-layer checks: DataTable, ObjectRow, WorkSummaryRow.
 *
 * Run against the same isolated preview page as the component specs, with the
 * legacy stylesheet loaded after the design system.
 */

const PREVIEW = '/preview.html';

async function style(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop),
    property,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(PREVIEW);
  await expect(page.getByRole('heading', { name: 'Design System — F1' })).toBeVisible();
});

test.describe('table semantics', () => {
  test('is a real table with an accessible name from its caption', async ({ page }) => {
    const table = page.getByRole('table', { name: /Портфель объектов/ });
    await expect(table).toBeVisible();
  });

  test('column headers are exposed as column headers', async ({ page }) => {
    const table = page.getByRole('table', { name: /Портфель объектов/ });
    await expect(
      table.getByRole('columnheader', { name: 'Объект / РП' }),
    ).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'СМР' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'График' })).toBeVisible();
  });

  test('rows are exposed as rows and cells as cells', async ({ page }) => {
    const table = page.getByRole('table', { name: /Портфель объектов/ });
    // Three object rows plus the header row.
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(
      table.getByRole('row').nth(1).getByRole('cell'),
    ).toHaveCount(4);
  });

  test('column widths are set once and hold across every row', async ({ page }) => {
    const offsets = await page.evaluate(() => {
      const table = document.querySelector('[data-section="object-table"] table');
      const bodyRows = Array.from(table?.querySelectorAll('tbody tr') ?? []);
      return bodyRows.map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        return cells.map((cell) => Math.round((cell as HTMLElement).offsetLeft));
      });
    });

    expect(offsets.length).toBe(3);
    for (const row of offsets.slice(1)) {
      expect(row).toEqual(offsets[0]);
    }
  });

  test('the coverage caption is present when a subset is shown', async ({ page }) => {
    await expect(
      page.getByText('Отделочные работы · 3 из 12 работ объекта', { exact: true }),
    ).toBeVisible();
  });
});

test.describe('ObjectRow', () => {
  test('renders name, code and responsible person', async ({ page }) => {
    const section = page.locator('[data-section="object-table"]');
    await expect(
      section.getByRole('button', { name: 'Учебный корпус · Северный' }),
    ).toBeVisible();
    await expect(
      section.getByText('CC-024 · ул. Строителей, 12', { exact: true }),
    ).toBeVisible();
    await expect(section.getByText('РП · Сергей Волков', { exact: true })).toBeVisible();
  });

  test('the attention fill marks one row, not the table', async ({ page }) => {
    const cellFill = async (rowIndex: number) =>
      style(
        page.locator('[data-section="object-table"] tbody tr').nth(rowIndex).locator('td').first(),
        'background-color',
      );

    const attention = await cellFill(0);
    const neutral = await cellFill(1);
    const alsoNeutral = await cellFill(2);

    expect(attention).not.toBe(neutral);
    expect(neutral).toBe(alsoNeutral);
  });

  test('the chevron appears only on a row that opens', async ({ page }) => {
    const rows = page.locator('[data-section="object-table"] tbody tr');
    await expect(rows.nth(0).locator('td').last()).toHaveText('›');
    await expect(rows.nth(2).locator('td').last()).toHaveText('');
  });

  test('a non-interactive row offers no control', async ({ page }) => {
    const row = page.locator('[data-section="object-table"] tbody tr').nth(2);
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('an unknown percentage shows a dash and draws no bar', async ({ page }) => {
    const row = page.locator('[data-section="object-table"] tbody tr').nth(2);
    await expect(row.locator('td').nth(1)).toContainText('—');
    await expect(row.locator('[class*="track"]')).toHaveCount(0);
  });

  test('the bar does not duplicate the percentage for assistive technology', async ({
    page,
  }) => {
    const table = page.getByRole('table', { name: /Портфель объектов/ });
    await expect(table.getByRole('progressbar')).toHaveCount(0);
  });
});

test.describe('row keyboard and activation', () => {
  test('the row control is reachable, named and activates on Enter', async ({ page }) => {
    const control = page.getByRole('button', { name: 'Учебный корпус · Северный' });
    await control.focus();
    await expect(control).toBeFocused();

    expect(await style(control, 'outline-style')).not.toBe('none');
    expect(parseFloat(await style(control, 'outline-width'))).toBeGreaterThan(0);

    await page.keyboard.press('Enter');
    await expect(page.locator('[data-activated]')).toHaveText(
      'Учебный корпус · Северный',
    );
  });

  test('a press on the row control activates exactly once', async ({ page }) => {
    // The row carries the same click as a convenience, so pressing the control
    // inside it could plausibly fire twice. What matters is the number of
    // activations the application sees, which is what this counts.
    const counter = page.locator('[data-activation-count]');
    await expect(counter).toHaveText('0');

    await page.getByRole('button', { name: 'Учебный корпус · Северный' }).click();
    await expect(page.locator('[data-activated]')).toHaveText(
      'Учебный корпус · Северный',
    );
    await expect(counter).toHaveText('1');

    await page.getByRole('button', { name: 'Штукатурка' }).click();
    await expect(page.locator('[data-activated]')).toHaveText('Штукатурка');
    await expect(counter).toHaveText('2');
  });

  test('clicking elsewhere in an interactive row still opens it', async ({ page }) => {
    const counter = page.locator('[data-activation-count]');
    await expect(counter).toHaveText('0');

    // The status cell — part of the row, but not the control.
    await page
      .locator('[data-section="object-table"] tbody tr')
      .first()
      .locator('td')
      .nth(2)
      .click();

    await expect(counter).toHaveText('1');
  });

  test('a row that does not open ignores clicks', async ({ page }) => {
    const counter = page.locator('[data-activation-count]');
    await page.locator('[data-section="object-table"] tbody tr').nth(2).click();
    await expect(counter).toHaveText('0');
  });
});

test.describe('WorkSummaryRow', () => {
  test('plan and fact are separate columns with separate values', async ({ page }) => {
    const table = page.getByRole('table', { name: /Производство/ });
    await expect(table.getByRole('columnheader', { name: 'План' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Факт' })).toBeVisible();

    const row = page.locator('[data-section="work-table"] tbody tr').nth(1);
    await expect(row.locator('td').nth(1)).toHaveText('1 000 м²');
    await expect(row.locator('td').nth(2)).toHaveText('500 м²');
  });

  test('no difference column and no computed deviation anywhere', async ({ page }) => {
    const section = page.locator('[data-section="work-table"]');
    const text = (await section.innerText()).toLowerCase();

    expect(text).not.toContain('отклонение');
    expect(text).not.toContain('разница');
    expect(text).not.toContain('п.п');
    // 1000 − 500 = 500 appears as the fact, but the shortfall must never be
    // presented as its own figure.
    expect(text).not.toContain('−500');
    expect(text).not.toContain('-500');
  });

  test('a measured zero and an unknown value stay distinct', async ({ page }) => {
    const rows = page.locator('[data-section="work-table"] tbody tr');

    // Шпаклёвка: nothing done yet, but the figure is known.
    await expect(rows.nth(2).locator('td').nth(2)).toHaveText('0 м²');
    await expect(rows.nth(2).locator('td').nth(3)).toHaveText('0%');

    // Окраска: nothing reported at all.
    await expect(rows.nth(3).locator('td').nth(2)).toHaveText('—');
    await expect(rows.nth(3).locator('td').nth(3)).toHaveText('—');
  });

  test('no confirmed-volume column exists', async ({ page }) => {
    const table = page.getByRole('table', { name: /Производство/ });
    const headers = await table.getByRole('columnheader').allInnerTexts();
    const joined = headers.join(' ').toLowerCase();
    expect(joined).not.toContain('подтвержд');
    expect(joined).not.toContain('принят');
  });
});

test.describe('table states', () => {
  test('loading shows the header and no values', async ({ page }) => {
    const table = page.getByRole('table', { name: /Загрузка/ });
    await expect(table.getByRole('columnheader', { name: 'СМР' })).toBeVisible();

    const body = await table.locator('tbody').innerText();
    expect(body.trim()).toBe('');
    expect(body).not.toContain('0%');
  });

  test('empty states the absence without inventing a zero', async ({ page }) => {
    const table = page.getByRole('table', { name: /Пусто/ });
    await expect(table.getByText('Объектов нет', { exact: true })).toBeVisible();
    expect(await table.locator('tbody').innerText()).not.toContain('0%');
  });

  test('error reports inside the table and offers a retry that works', async ({ page }) => {
    const table = page.getByRole('table', { name: /Ошибка/ });
    await expect(
      table.getByText('Не удалось загрузить портфель', { exact: true }),
    ).toBeVisible();

    await table.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.locator('[data-activated]')).toHaveText('Повтор запроса');
  });

  test('a failed table does not take the rest of the page down', async ({ page }) => {
    await expect(page.getByRole('table', { name: /Портфель объектов/ })).toBeVisible();
    await expect(page.getByRole('table', { name: /Ошибка/ })).toBeVisible();
  });
});

test.describe('product behaviour that must not be here', () => {
  test('no sorting, filtering, search or pagination controls', async ({ page }) => {
    const tables = page.locator(
      '[data-section="object-table"] table, [data-section="work-table"] table',
    );

    // Nothing interactive in the header row: a sortable column would put a
    // control there.
    await expect(tables.locator('thead button, thead a, thead input')).toHaveCount(0);
    // No inputs at all — no search box, no filter, no page size.
    await expect(tables.locator('input, select')).toHaveCount(0);

    const text = (await tables.first().innerText()).toLowerCase();
    expect(text).not.toContain('сортир');
    expect(text).not.toContain('фильтр');
    expect(text).not.toContain('страниц');
  });
});
