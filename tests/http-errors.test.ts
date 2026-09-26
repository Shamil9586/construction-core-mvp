import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, httpErrorMessage } from '../apps/frontend/src/http';

const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const html = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const text = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
const rejection = (r: Response) => parseResponse(r).then(() => null, (e: Error) => e);

test('API error parsing: non-JSON HTTP errors never surface as JSON SyntaxError', async (t) => {
  await t.test('Успешный JSON-ответ возвращается как раньше', async () => {
    assert.deepEqual(await parseResponse(json(200, { id: 'x', version: 2 })), { id: 'x', version: 2 });
    assert.deepEqual(await parseResponse(json(201, [1, 2])), [1, 2]);
  });

  await t.test('Business-ошибка backend сохраняет своё сообщение', async () => {
    await assert.rejects(() => parseResponse(json(409, { statusCode: 409, message: 'Данные изменены другим пользователем. Обновите страницу.', requestId: 'r' })), /Обновите страницу/);
    await assert.rejects(() => parseResponse(json(403, { statusCode: 403, message: 'Недостаточно прав: object.write' })), /Недостаточно прав/);
    await assert.rejects(() => parseResponse(json(400, { error: 'Неверный период закрытия' })), (e: Error) => e.message === 'Неверный период закрытия');
  });

  await t.test('429 лимитера (text/html) — обычная HTTP-ошибка, а не сбой парсера', async () => {
    // Тело в точности такое, каким его отдаёт express-rate-limit по умолчанию.
    const error = await rejection(html(429, 'Too many requests, please try again later.'));
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'Error');
    assert.equal(error.message, 'Слишком много запросов. Повторите позже.');
    assert.doesNotMatch(error.message, /is not valid JSON|Unexpected token|JSON/i);
    assert.ok(!error.message.includes('Too many requests'), 'тело ответа наружу не пробрасывается');
  });

  await t.test('Текст прокси с upstream-адресом не показывается пользователю', async () => {
    // Короткое, «безобидное на вид» тело: раньше такое уходило пользователю как есть.
    const error = await rejection(text(502, 'connect ECONNREFUSED 10.0.0.7:3001'));
    assert.equal(error!.message, 'HTTP 502');
    for (const secret of ['ECONNREFUSED', '10.0.0.7', '3001']) assert.ok(!error!.message.includes(secret), 'утечка инфраструктуры: ' + secret);
    // То же для короткого текста без адреса — произвольное тело наружу не идёт.
    assert.equal(httpErrorMessage(504, 'text/plain', 'Gateway Timeout'), 'HTTP 504');
    assert.equal(httpErrorMessage(500, 'text/plain', 'x'.repeat(5000)), 'HTTP 500');
    assert.equal(httpErrorMessage(500, 'text/plain', '<script>alert(1)</script>'), 'HTTP 500');
  });

  await t.test('HTML-страница прокси (502/504) не выводится пользователю как разметка', async () => {
    for (const status of [502, 504]) {
      const page = '<!doctype html><html><head><title>' + status + '</title></head><body><h1>' + status + ' Gateway</h1><pre>upstream 10.0.0.7:3001</pre></body></html>';
      const error = await rejection(html(status, page));
      assert.equal(error!.message, 'HTTP ' + status);
      assert.ok(!error!.message.includes('<'));
      assert.ok(!error!.message.includes('10.0.0.7'));
    }
  });

  await t.test('Неизвестный content-type и пустое тело дают честный HTTP-статус', async () => {
    await assert.rejects(() => parseResponse(new Response('boom at /srv/app/service.ts:120', { status: 500, headers: { 'content-type': 'application/octet-stream' } })), (e: Error) => e.message === 'HTTP 500');
    await assert.rejects(() => parseResponse(new Response('', { status: 503 })), (e: Error) => e.message === 'HTTP 503');
  });

  await t.test('JSON-ошибка без message и обрезанный JSON не всплывают как SyntaxError', async () => {
    await assert.rejects(() => parseResponse(json(400, { statusCode: 400 })), (e: Error) => e.message === 'HTTP 400');
    const error = await rejection(new Response('{"message":"tru', { status: 500, headers: { 'content-type': 'application/json' } }));
    assert.equal(error!.message, 'HTTP 500');
    assert.doesNotMatch(error!.message, /Unexpected token|is not valid JSON/);
  });

  await t.test('Успешный ответ без валидного JSON — понятная ошибка, а не SyntaxError', async () => {
    const error = await rejection(html(200, '<!doctype html><html></html>'));
    assert.equal(error!.name, 'Error');
    assert.match(error!.message, /Неверный ответ сервера: HTTP 200/);
    assert.doesNotMatch(error!.message, /Unexpected token/);
    assert.ok(!error!.message.includes('<'));
  });
});
