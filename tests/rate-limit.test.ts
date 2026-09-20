import { test } from 'node:test';
import assert from 'node:assert/strict';

// Лимитер читает env внутри createApp(), поэтому один процесс может собрать
// приложение с разной конфигурацией. Env восстанавливается после каждого сценария.
function withRateLimitEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const names = ['RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_MAX'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, values);
  return fn().finally(() => { for (const n of names) { delete process.env[n]; if (saved[n] !== undefined) process.env[n] = saved[n]; } });
}
// X-RateLimit-Limit (legacyHeaders включены в express-rate-limit по умолчанию)
// показывает фактически собранный лимит, не требуя исчерпания окна.
async function effectiveLimit(base: string, path: string) { const r = path === '/health' ? await fetch(base + path) : await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return Number(r.headers.get('x-ratelimit-limit')); }

test('Rate limit: production defaults, env override and fail-closed validation', async (t) => {
  delete process.env.DATABASE_URL; process.env.DB_MODE = 'pglite'; process.env.PGLITE_DIR = 'memory://';
  process.env.AUTH_MODE = 'mock'; process.env.MOCK_LOGIN_KEY = 'rate-limit-test-only';
  const { positiveIntEnv, createApp } = await import('../apps/backend/src/main');
  const { parseResponse } = await import('../apps/frontend/src/http');
  const { pool } = await import('../apps/backend/src/db');
  const TIMER_MAX_MS = 2147483647;
  try {
    await t.test('Без env приложение собирается с прежними production defaults', async () => {
      await withRateLimitEnv({}, async () => {
        assert.equal(positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), 60000);
        const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
        try {
          assert.equal(await effectiveLimit(base, '/health'), 300);
          assert.equal(await effectiveLimit(base, '/auth/mock'), 30);
        } finally { await app.close(); }
      });
      // Пустая строка — это отсутствие конфигурации, а не «ноль запросов».
      await withRateLimitEnv({ RATE_LIMIT_MAX: '' }, async () => { assert.equal(positiveIntEnv('RATE_LIMIT_MAX', 300), 300); });
    });

    await t.test('Некорректное значение не становится NaN/0/безлимитом, а валит старт', async () => {
      for (const bad of ['0', '-1', 'abc', 'NaN', 'Infinity', '1.5', '1e3', '-0', '9007199254740993'])
        await withRateLimitEnv({ RATE_LIMIT_MAX: bad }, async () => {
          assert.throws(() => positiveIntEnv('RATE_LIMIT_MAX', 300), /positive integer/, 'принято некорректное значение ' + JSON.stringify(bad));
        });
      for (const name of ['RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_MAX'])
        await withRateLimitEnv({ [name]: 'unlimited' }, async () => { await assert.rejects(() => createApp(), new RegExp(name + ' must be a positive integer')); });
    });

    await t.test('Окно ограничено максимумом таймера Node: больший интервал переполняется в 1ms', async () => {
      await withRateLimitEnv({}, async () => { assert.equal(positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), 60000); });
      await withRateLimitEnv({ RATE_LIMIT_WINDOW_MS: String(TIMER_MAX_MS) }, async () => {
        assert.equal(positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), TIMER_MAX_MS);
      });
      for (const tooLong of [String(TIMER_MAX_MS + 1), '2592000000'])
        await withRateLimitEnv({ RATE_LIMIT_WINDOW_MS: tooLong }, async () => {
          assert.throws(() => positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), /RATE_LIMIT_WINDOW_MS must be a positive integer not greater than 2147483647/);
          await assert.rejects(() => createApp(), /RATE_LIMIT_WINDOW_MS must be a positive integer not greater than 2147483647/);
        });
      // Счётчики запросов — не задержки, таймерный предел на них не переносится.
      await withRateLimitEnv({ RATE_LIMIT_MAX: '2592000000', AUTH_RATE_LIMIT_MAX: '2592000000' }, async () => {
        assert.equal(positiveIntEnv('RATE_LIMIT_MAX', 300), 2592000000);
        assert.equal(positiveIntEnv('AUTH_RATE_LIMIT_MAX', 30), 2592000000);
      });
    });

    await t.test('Явный override применяется: запросы до лимита проходят, следующий — 429', async () => {
      await withRateLimitEnv({ RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000' }, async () => {
        const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
        try {
          for (let i = 1; i <= 5; i++) assert.equal((await fetch(base + '/health')).status, 200, 'запрос #' + i + ' должен проходить');
          const limited = await fetch(base + '/health');
          assert.equal(limited.status, 429);
          // Ровно тот ответ, который ломал frontend: 429 приходит не как JSON.
          assert.ok(!(limited.headers.get('content-type') ?? '').includes('application/json'));
          // Настоящий 429 лимитера разбирается без JSON SyntaxError.
          await assert.rejects(() => parseResponse(limited), (e: Error) => e.name === 'Error' && !/JSON|Unexpected token/i.test(e.message));
        } finally { await app.close(); }
      });
    });

    await t.test('Лимит /auth настраивается отдельно от глобального', async () => {
      await withRateLimitEnv({ RATE_LIMIT_MAX: '100', AUTH_RATE_LIMIT_MAX: '2' }, async () => {
        const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
        try {
          // POST /auth/mock с неверным ключом — это ровно 401 (auth.controller.ts),
          // а не «что угодно, кроме 429»: иначе 500 на пути к лимитеру прошёл бы
          // за успешную проверку.
          const post = () => fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'ADMIN', key: 'wrong' }) });
          for (let i = 1; i <= 2; i++) assert.equal((await post()).status, 401, 'auth-запрос #' + i + ' должен дойти до контроллера');
          assert.equal((await post()).status, 429);
          // Исчерпанный /auth не закрывает остальной API: лимиты независимы.
          assert.equal((await fetch(base + '/health')).status, 200);
        } finally { await app.close(); }
      });
    });

    await t.test('E2E-конфигурация браузерного гейта поднимает лимит явно', async () => {
      const { E2E_RATE_LIMIT_WINDOW_MS, E2E_RATE_LIMIT_MAX, E2E_AUTH_RATE_LIMIT_MAX } = await import('../playwright.config');
      // Окно тоже задано явно, иначе прогон унаследовал бы чужое значение из shell.
      await withRateLimitEnv({ RATE_LIMIT_WINDOW_MS: '900000' }, async () => {
        assert.equal(E2E_RATE_LIMIT_WINDOW_MS, '60000');
        assert.equal(positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), 900000, 'наследование из окружения действительно возможно');
      });
      await withRateLimitEnv({ RATE_LIMIT_WINDOW_MS: E2E_RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX: E2E_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_MAX: E2E_AUTH_RATE_LIMIT_MAX }, async () => {
        const app = await createApp(); await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
        try {
          assert.ok(await effectiveLimit(base, '/health') >= 2000, 'E2E-лимита не хватает на полный suite');
          assert.ok(await effectiveLimit(base, '/auth/mock') > 30);
          // Повышение живёт только в E2E-конфигурации, окно остаётся production.
          assert.equal(positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), 60000);
        } finally { await app.close(); }
      });
    });
  } finally { await pool.end(); }
});
