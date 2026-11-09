/**
 * Диагностика: обещание «без личных данных» должно быть проверяемым.
 * Тесты держат три вещи, которые легко сломать незаметно:
 *  1) в отправку не попадают текст диктовки, буфер, почта и домашние пути;
 *  2) выключенный тумблер = ни одного сетевого запроса;
 *  3) воркер-приёмник повторно вычищает запрещённые поля.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const logger = (await import('../electron/logger.cjs')).logger;
const { redact, scrub } = await import('../electron/logger.cjs');
const worker = await import('../server/worker.mjs');

describe('logger: редакция личных данных', () => {
  it('маскирует почту, домашний путь Windows и токены', () => {
    const out = redact(
      'письмо на ivan.petrov@mail.ru, файл C:\\Users\\Ivan\\Documents\\a.txt, токен ghp_abcdefghijklmnop',
    );
    expect(out).not.toContain('ivan.petrov');
    expect(out).not.toContain('Ivan');
    expect(out).not.toContain('ghp_abcdefghijklmnop');
    expect(out).toContain('[почта]');
  });

  it('выбрасывает текст диктовки даже если он случайно попал в поле', () => {
    const clean = scrub({
      text: 'секретная фраза',
      transcript: 'секретная фраза',
      pcm: [1, 2, 3],
      ok: true,
      bytes: 96000,
    });
    expect(clean).toEqual({ ok: true, bytes: 96000 });
  });
});

describe('logger: отправка', () => {
  beforeEach(() => {
    logger.init({ dir: '', enabled: true, context: { version: '1.4.1' } });
    logger.setSilent(true);
  });

  it('при выключенной отправке не делает сетевых запросов', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    logger.setEnabled(false);
    logger.error('stt', 'проверка');
    const res = await logger.sendNow();
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    logger.setEnabled(true);
    spy.mockRestore();
  });

  it('статус честно показывает, выключена ли отправка', () => {
    logger.setEnabled(false);
    expect(logger.status().enabled).toBe(false);
    logger.setEnabled(true);
    expect(logger.status().enabled).toBe(true);
  });

  it('ошибки хранятся в буфере и доступны в интерфейсе', () => {
    logger.clear();
    logger.error('engine', 'движок не найден');
    const recent = logger.recent();
    expect(recent.some((e) => e.message.includes('движок не найден'))).toBe(true);
  });
});

describe('воркер: приёмник журналов', () => {
  it('вычищает запрещённые поля и личные данные', () => {
    const [event] = worker.parseBatch({
      events: [
        {
          level: 'error',
          scope: 'stt',
          message: 'сбой у user@example.com',
          data: { text: 'диктовка', prompt: 'промпт', ms: 1200 },
        },
      ],
    });
    expect(event.message).toContain('<email>');
    expect(event.data).toEqual({ ms: 1200 });
  });

  it('не принимает мусор вместо событий', () => {
    expect(worker.parseBatch({ events: [{ level: 'error' }] })).toEqual([]);
    expect(worker.parseBatch(null)).toEqual([]);
  });

  it('хранит события без внешней базы и отдаёт их списком', async () => {
    // state без SQLite → срабатывает резервный путь на обычном хранилище
    const kv = new Map();
    const state = {
      storage: {
        get: async (k) => kv.get(k),
        put: async (k, v) => kv.set(k, v),
      },
    };
    const store = new worker.LogStore(state, {});
    const append = await store.fetch(
      new Request('https://log-store/append', {
        method: 'POST',
        body: JSON.stringify({
          installId: 'abc',
          app: { version: '1.4.1' },
          events: [{ at: 1, level: 'error', scope: 'stt', message: 'сбой' }],
        }),
      }),
    );
    expect((await append.json()).stored).toBe(1);

    const list = await store.fetch(new Request('https://log-store/list?limit=10'));
    const data = await list.json();
    expect(data.events[0].message).toBe('сбой');
    expect(data.events[0].version).toBe('1.4.1');
  });

  it('страница /admin закрыта ключом, если ключ задан', async () => {
    const res = await worker.default.fetch(new Request('https://logs.test/admin'), { LOGS_SECRET: 'k' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Неверный ключ');
  });

  it('отдаёт health-ответ без обращения к репозиторию', async () => {
    const res = await worker.default.fetch(new Request('https://logs.test/health'), {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('zspeakly-logs');
  });

  it('закрыт секретом, если секрет задан', async () => {
    const req = new Request('https://logs.test/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    const res = await worker.default.fetch(req, { LOGS_SECRET: 's3cret' });
    expect(res.status).toBe(401);
  });
});
