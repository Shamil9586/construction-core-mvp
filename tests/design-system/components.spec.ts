import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Design-system component checks, run against the isolated preview page with the
 * legacy global stylesheet loaded.
 *
 * Two things are being verified throughout. First, that each component looks and
 * behaves as the specification describes. Second — and this is why the legacy
 * sheet is loaded rather than excluded — that the design system survives contact
 * with it. `style.css` styles bare h1, h2, p, small, strong, a, aside, header and
 * main, and the preview imports it *after* the design system, which is the harder
 * ordering. Anything that still renders correctly here is protected by
 * specificity, not by load order.
 */

const PREVIEW = '/preview.html';

async function style(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop),
    property,
  );
}

test.beforeEach(async ({ page }: { page: Page }) => {
  await page.goto(PREVIEW);
  await expect(page.getByRole('heading', { name: 'Design System — F1' })).toBeVisible();
});

test.describe('scope and typography', () => {
  test('tabular figures are active inside the scope', async ({ page }) => {
    const digits = page.locator('[data-leak="digits"]');
    expect(await style(digits, 'font-variant-numeric')).toContain('tabular-nums');
  });

  test('legacy element rules do not deform design-system text', async ({ page }) => {
    // Legacy: h1 is 30px with letter-spacing -0.8px and margin 8px 0 10px.
    const h1 = page.locator('[data-leak="h1"]');
    expect(await style(h1, 'font-size')).toBe('28px');
    expect(await style(h1, 'letter-spacing')).toBe('normal');
    expect(await style(h1, 'margin-top')).toBe('0px');
    expect(await style(h1, 'margin-bottom')).toBe('0px');

    // Legacy: h2 is 19px with margin 0 0 7px.
    const h2 = page.locator('[data-leak="h2"]');
    expect(await style(h2, 'font-size')).toBe('20px');
    expect(await style(h2, 'margin-bottom')).toBe('0px');

    // Legacy: p has line-height 1.5, which at 14px would be 21px.
    const p = page.locator('[data-leak="p"]');
    expect(await style(p, 'font-size')).toBe('14px');
    expect(await style(p, 'line-height')).toBe('20px');

    // Legacy: small is 12px with line-height 1.7. Size and leading are ours, but
    // `display: block` still leaks — see the next test for why that is tolerated.
    const small = page.locator('[data-leak="small"]');
    expect(await style(small, 'font-size')).toBe('11px');
    expect(await style(small, 'line-height')).toBe('16px');

    // Legacy: strong is weight 600.
    const strong = page.locator('[data-leak="strong"]');
    expect(await style(strong, 'font-weight')).toBe('400');
  });

  test('Inter is the resolved family', async ({ page }) => {
    const h1 = page.locator('[data-leak="h1"]');
    expect(await style(h1, 'font-family')).toContain('Inter');
  });

  test('no component renders a bare <small>, which legacy forces to block', async ({
    page,
  }) => {
    // One leak survives: legacy `small { display: block }` is an element rule for
    // a property the meta style does not declare, and declaring `display` on a
    // text style would break every block use of it. Rather than fight that, the
    // components avoid the element — meta text is a span with cc-type-meta. This
    // test pins that choice, so the leak stays unreachable from the design system
    // even if someone reaches for <small> later out of habit.
    const componentSmalls = page.locator(
      '[data-section="status-badge"] small, [data-section="progress-bar"] small, [data-section="button"] small, [data-section="plan-fact"] small, [data-section="linked-stage"] small',
    );
    await expect(componentSmalls).toHaveCount(0);
  });
});

test.describe('StatusBadge', () => {
  test('every variant renders with its label', async ({ page }) => {
    const section = page.locator('[data-section="status-badge"]');
    for (const label of [
      'По графику',
      'Есть отставание',
      'Требует внимания',
      'Заблокировано',
      'Не предъявлено',
    ]) {
      await expect(section.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('Delayed and Attention share one amber, as decided', async ({ page }) => {
    const section = page.locator('[data-section="status-badge"]');
    const delayed = section.getByText('Есть отставание', { exact: true });
    const attention = section.getByText('Требует внимания', { exact: true });

    expect(await style(delayed, 'background-color')).toBe(
      await style(attention, 'background-color'),
    );
    expect(await style(delayed, 'color')).toBe(await style(attention, 'color'));
  });

  test('variants are visually distinct where the design says they are', async ({ page }) => {
    const section = page.locator('[data-section="status-badge"]');
    const onTrack = await style(section.getByText('По графику', { exact: true }), 'background-color');
    const delayed = await style(section.getByText('Есть отставание', { exact: true }), 'background-color');
    const blocked = await style(section.getByText('Заблокировано', { exact: true }), 'background-color');
    const neutral = await style(section.getByText('Не предъявлено', { exact: true }), 'background-color');

    expect(new Set([onTrack, delayed, blocked, neutral]).size).toBe(4);
  });
});

test.describe('ProgressBar', () => {
  test('exposes value, bounds and an accessible name', async ({ page }) => {
    const bar = page.getByRole('progressbar', { name: 'Готовность, пример' });
    await expect(bar).toHaveAttribute('aria-valuenow', '62');
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  test('a real zero is a value, not an absence', async ({ page }) => {
    const zero = page.getByRole('progressbar', { name: 'Ноль, пример' });
    await expect(zero).toHaveAttribute('aria-valuenow', '0');
  });

  test('no data renders a caption and claims no value', async ({ page }) => {
    const section = page.locator('[data-section="progress-bar"]');
    await expect(section.getByText('Нет данных', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: 'Без данных, пример' }),
    ).toHaveCount(0);
  });

  test('the fill never changes colour — no quality, delay or completion implied', async ({
    page,
  }) => {
    const fillOf = async (name: string) =>
      style(
        page.getByRole('progressbar', { name }).locator('> div'),
        'background-color',
      );

    const partial = await fillOf('Готовность, пример');
    const complete = await fillOf('Сто процентов, пример');
    const zero = await fillOf('Ноль, пример');

    expect(complete).toBe(partial);
    expect(zero).toBe(partial);
  });
});

test.describe('Button', () => {
  test('accessible names come from the label', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: 'Разобрать отставание' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Открыть производство' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Посмотреть основание' }),
    ).toBeVisible();
  });

  test('keyboard focus is visible', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Разобрать отставание' });
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();

    const width = await style(button, 'outline-width');
    const outlineStyle = await style(button, 'outline-style');
    expect(outlineStyle).not.toBe('none');
    expect(parseFloat(width)).toBeGreaterThan(0);
  });

  test('activates on Enter and on Space', async ({ page }) => {
    await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('button')).find(
        (node) => node.textContent?.includes('Разобрать отставание'),
      );
      (window as unknown as { ccClicks: number }).ccClicks = 0;
      target?.addEventListener('click', () => {
        (window as unknown as { ccClicks: number }).ccClicks += 1;
      });
    });

    const button = page.getByRole('button', { name: 'Разобрать отставание' });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');

    const clicks = await page.evaluate(
      () => (window as unknown as { ccClicks: number }).ccClicks,
    );
    expect(clicks).toBe(2);
  });

  test('loading keeps the label, marks busy and blocks activation', async ({ page }) => {
    const button = page
      .locator('[data-section="button"]')
      .getByRole('button', { name: 'Загрузка' })
      .first();

    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeDisabled();
    await expect(button).toContainText('Загрузка');
  });

  test('secondary outline uses the interactive border, not the decorative one', async ({
    page,
  }) => {
    const secondary = page.getByRole('button', { name: 'Посмотреть основание' });
    // border.interactive #778C9C, not border.default #DFE6EC.
    expect(await style(secondary, 'border-top-color')).toBe('rgb(119, 140, 156)');
  });

  test('disabled buttons are not activatable', async ({ page }) => {
    const disabled = page
      .locator('[data-section="button"]')
      .getByRole('button', { name: 'Недоступно' })
      .first();
    await expect(disabled).toBeDisabled();
  });
});

test.describe('PlanFact', () => {
  test('plan and fact stay separate, with their own captions', async ({ page }) => {
    const section = page.locator('[data-section="plan-fact"]');
    await expect(section.getByText('План на дату', { exact: true }).first()).toBeVisible();
    await expect(section.getByText('Факт', { exact: true }).first()).toBeVisible();
    await expect(section.getByText('75%', { exact: true })).toBeVisible();
    await expect(section.getByText('62%', { exact: true })).toBeVisible();
  });

  test('no difference between the two figures is rendered anywhere', async ({ page }) => {
    const text = (await page.locator('[data-section="plan-fact"]').innerText()).toLowerCase();
    expect(text).not.toContain('п.п');
    expect(text).not.toContain('отклонение');
    // 75 − 62 = 13; the component must not have computed it.
    expect(text).not.toContain('13%');
  });

  test('the unit is carried apart from the figure', async ({ page }) => {
    const section = page.locator('[data-section="plan-fact"]');
    await expect(
      section.getByText('м² · физически выполнено', { exact: true }),
    ).toBeVisible();
  });
});

test.describe('LinkedStage', () => {
  test('records and the closing sum render', async ({ page }) => {
    const section = page.locator('[data-section="linked-stage"]');
    await expect(section.getByText('ИД по АОСР', { exact: true })).toBeVisible();
    await expect(
      section.getByText('Черновик · номер не присвоен', { exact: true }),
    ).toBeVisible();
    await expect(section.getByText('0 ₽', { exact: true })).toBeVisible();
    await expect(section.getByText('2,0 млн ₽', { exact: true })).toBeVisible();
  });

  test('sums at different levels are not reconciled', async ({ page }) => {
    // 0 ₽ closed on a work sits beside 2,0 млн ₽ closed on an object. They are
    // different levels and the component must show both without combining them.
    const section = page.locator('[data-section="linked-stage"]');
    await expect(section.getByText('Закрыто по работе', { exact: true })).toBeVisible();
    await expect(section.getByText('Закрыто по объекту', { exact: true })).toBeVisible();
  });

  test('records carry no step or ordering markers', async ({ page }) => {
    const text = await page.locator('[data-section="linked-stage"]').innerText();
    expect(text).not.toContain('→');
    expect(text).not.toMatch(/Шаг\s*\d/);
  });
});
