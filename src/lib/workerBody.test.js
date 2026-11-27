// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import worker from '../../server/worker.mjs';

const LIMIT = 256 * 1024;
const url = 'https://logs.test/v1/events';

function streamedRequest(chunks, headers = {}) {
  let read = 0;
  const cancel = vi.fn();
  const body = new ReadableStream({
    pull(controller) {
      if (read === chunks.length) return controller.close();
      controller.enqueue(chunks[read++]);
    },
    cancel,
  }, { highWaterMark: 0 });
  const request = new Request(url, { method: 'POST', headers, body, duplex: 'half' });
  return { request, cancel, reads: () => read };
}

describe('сервер журналов: ограничение тела', () => {
  it('принимает ровно 256 КБ и отказывает при превышении даже на байт', async () => {
    const prefix = '{"events":[],"padding":"';
    const suffix = '"}';
    const payload = prefix + 'a'.repeat(LIMIT - prefix.length - suffix.length) + suffix;
    for (const [body, expected] of [[payload, 200], [payload + ' ', 413]]) {
      const response = await worker.fetch(new Request(url, { method: 'POST', body }), {});
      expect(response.status).toBe(expected);
    }
  });

  it('считает байты UTF-8, а не число символов, даже при заниженном Content-Length', async () => {
    const body = JSON.stringify({ events: [], padding: 'я'.repeat(140000) });
    expect(body.length).toBeLessThan(LIMIT);
    const response = await worker.fetch(new Request(url, {
      method: 'POST', headers: { 'content-length': '1' }, body,
    }), {});
    expect(response.status).toBe(413);
  });

  it('останавливает поток при превышении, не читая оставшиеся части', async () => {
    const input = streamedRequest([new Uint8Array(LIMIT), new Uint8Array(1), new Uint8Array(10)]);
    const response = await worker.fetch(input.request, {});
    expect(response.status).toBe(413);
    expect(input.reads()).toBe(2);
    expect(input.cancel).toHaveBeenCalledOnce();
  });

  it('отклоняет большой Content-Length до чтения и проверяет секрет прежде тела', async () => {
    const input = streamedRequest([new Uint8Array(1)], { 'content-length': String(LIMIT + 1) });
    expect((await worker.fetch(input.request, {})).status).toBe(413);
    expect(input.reads()).toBe(0);
    const denied = streamedRequest([new Uint8Array(1)]);
    expect((await worker.fetch(denied.request, { LOGS_SECRET: 'secret' })).status).toBe(401);
    expect(denied.reads()).toBe(0);
  });

  it('отдаёт 400, если входной поток оборвался', async () => {
    const body = new ReadableStream({ pull(controller) { controller.error(new Error('network failed')); } });
    const request = new Request(url, { method: 'POST', body, duplex: 'half' });
    const response = await worker.fetch(request, {});
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('network failed');
  });

  it('декодирует UTF-8, разделённый между частями, и обрабатывает плохой JSON', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ events: [{ message: 'ёж' }] }));
    const where = encoded.indexOf(0xd1); // вторая часть слова начинается с двухбайтовой буквы
    const input = streamedRequest([encoded.slice(0, where + 1), encoded.slice(where + 1)]);
    const saved = vi.fn(async (_url, init) => new Response(JSON.stringify({ ok: true, backend: 'test', batch: JSON.parse(init.body) })));
    const env = { LOGS: { idFromName: () => 'room', get: () => ({ fetch: saved }) } };
    expect((await worker.fetch(input.request, env)).status).toBe(200);
    expect(JSON.parse(saved.mock.calls[0][1].body).events[0].message).toBe('ёж');
    const invalid = await worker.fetch(new Request(url, { method: 'POST', body: '{' }), {});
    expect(invalid.status).toBe(400);
  });
});
