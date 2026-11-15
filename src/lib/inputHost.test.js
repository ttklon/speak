import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { InputHost, buildHostScript, encodeCommand } = require('../../electron/inputHost.cjs');

/**
 * Фальшивый процесс помощника: принимает строки, отвечает тем, что велит тест.
 * Так проверяется именно протокол и поведение при сбоях, без Windows.
 */
function fakeProcess({ onCommand } = {}) {
  const proc = new EventEmitter();
  const written = [];
  const replies = [];
  proc.stdout = {
    setEncoding() {},
    on(_event, fn) {
      proc._out = fn;
    },
  };
  proc.stdin = {
    write(line) {
      const command = String(line).trim();
      written.push(command);
      const answer = onCommand?.(command, proc) ?? null;
      replies.push(answer);
      // ответ приходит асинхронно, как от настоящего PowerShell
      if (answer) setTimeout(() => proc.reply(answer), 0);
    },
    end() {},
  };
  proc.kill = () => proc.emit('exit', 0);
  proc.reply = (payload) => proc._out?.(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
  proc.written = written;
  return proc;
}

describe('помощник ввода', () => {
  it('поднимается один раз и отвечает на PING', async () => {
    let spawned = 0;
    const proc = fakeProcess({
      onCommand: (command) => {
        if (command === 'PING') return { ok: true };
        return null;
      },
    });
    const host = new InputHost({
      launch: () => {
        spawned += 1;
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    expect(host.start()).toBe(true);
    expect(host.start()).toBe(true); // второй процесс не запускаем
    const res = await host.request('PING');
    expect(res).toEqual({ ok: true });
    expect(spawned).toBe(1);
    expect(host.status()).toMatchObject({ running: true, ready: true, spawned: 1, requests: 1 });
    host.stop();
  });

  it('вставляет через PASTE и печатает через TYPE без нового процесса', async () => {
    let spawned = 0;
    const proc = fakeProcess({
      onCommand: (command) => {
        if (command === 'PASTE') return { ok: true };
        if (command.startsWith('TYPE ')) {
          const text = Buffer.from(command.slice(5), 'base64').toString('utf8');
          return { ok: true, typed: text.length };
        }
        return null;
      },
    });
    const host = new InputHost({
      launch: () => {
        spawned += 1;
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    expect(await host.paste()).toEqual({ ok: true });
    const typed = await host.type('привет, мир');
    expect(typed).toMatchObject({ ok: true, typed: 11, total: 11 });
    expect(spawned).toBe(1);
    // текст уходит в base64: в командной строке процесса его не видно
    const typeLine = proc.written.find((c) => c.startsWith('TYPE '));
    expect(typeLine).not.toContain('привет');
    expect(Buffer.from(typeLine.slice(5), 'base64').toString('utf8')).toBe('привет, мир');
    host.stop();
  });

  it('ответы сопоставляются в порядке запросов', async () => {
    const proc = fakeProcess({
      onCommand: (command) => {
        if (command.startsWith('TYPE ')) return { ok: true, typed: 2 };
        return { ok: true };
      },
    });
    const host = new InputHost({
      launch: () => {
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    const [first, second] = await Promise.all([host.paste(), host.type('ок')]);
    expect(first).toEqual({ ok: true });
    expect(second.ok).toBe(true);
    host.stop();
  });

  it('частичный ввод не выдаётся за успех', async () => {
    const proc = fakeProcess({
      onCommand: (command) => (command.startsWith('TYPE ') ? { ok: false, typed: 3 } : { ok: true }),
    });
    const host = new InputHost({
      launch: () => {
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    const res = await host.type('abcdef');
    expect(res.ok).toBe(false);
    expect(res.typed).toBe(3);
    expect(res.total).toBe(6);
    host.stop();
  });

  it('падение процесса не оставляет запросы висеть', async () => {
    let kills = 0;
    const proc = fakeProcess({ onCommand: () => null });
    const host = new InputHost({
      launch: () => {
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    const pending = host.paste();
    await new Promise((r) => setTimeout(r, 10));
    kills += 1;
    proc.emit('exit', 1);
    const res = await pending;
    expect(res).toEqual({ ok: false, reason: 'host-exited' });
    expect(host.status().running).toBe(false);
    // сразу после падения новый процесс не плодим
    expect(host.start()).toBe(false);
    expect(kills).toBe(1);
    host.stop();
  });

  it('молчащий помощник не подвешивает вставку', async () => {
    vi.useFakeTimers();
    const proc = fakeProcess({ onCommand: () => null });
    const host = new InputHost({
      timeoutMs: 100,
      launch: () => {
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    try {
      host.start();
      await vi.advanceTimersByTimeAsync(5);
      const promise = host.paste();
      await vi.advanceTimersByTimeAsync(150);
      expect(await promise).toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
      host.stop();
    }
  });

  it('на не-Windows помощник честно говорит, что недоступен', async () => {
    const host = new InputHost({ platform: 'linux' });
    expect(host.available()).toBe(false);
    expect(await host.paste()).toEqual({ ok: false, reason: 'host-not-started' });
  });

  it('отдаёт заголовок активного окна — без нового процесса на фразу', async () => {
    const title = 'Документ — Word';
    const proc = fakeProcess({
      onCommand: (command) =>
        command === 'TARGET'
          ? { ok: true, title64: Buffer.from(title, 'utf8').toString('base64') }
          : { ok: true },
    });
    const host = new InputHost({
      launch: () => {
        setTimeout(() => proc.reply({ ok: true, ready: true }), 0);
        return proc;
      },
    });
    const res = await host.target();
    expect(res).toEqual({ ok: true, title });
    expect(proc.written).toContain('TARGET');
    host.stop();
  });

  it('скрипт помощника действительно зовёт SendInput и живёт в цикле', () => {
    const script = buildHostScript();
    expect(script).toContain('SendInput');
    expect(script).toContain('KEYEVENTF_UNICODE');
    expect(script).toContain('while ($true)');
    expect(script).toContain("'PASTE'");
    expect(script).toContain("'TYPE'");
    expect(script).toContain("'TARGET'");
    expect(script).toContain('GetForegroundWindow');
    // PowerShell принимает скрипт в base64 от UTF-16LE
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le');
    expect(decoded).toContain('ZsInput');
  });
});
