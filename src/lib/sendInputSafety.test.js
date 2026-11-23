import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { sendUnicodeText } = require('../../electron/sendInput.cjs');

function run({ out = '', code = 1, error = null } = {}) {
  return sendUnicodeText({ text: 'тест', platform: 'win32', execFile: () => {
    const child = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.stdout = new EventEmitter();
    queueMicrotask(() => {
      if (out) child.stdout.emit('data', Buffer.from(out));
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
    return child;
  } });
}

describe('подтверждение одноразового SendInput', () => {
  it('потеря вывода и ошибка процесса не означают нулевой ввод', async () => {
    expect(await run()).toMatchObject({ ok: false, sent: 0, uncertain: true });
    expect(await run({ error: new Error('connection lost') })).toMatchObject({ ok: false, sent: 0, uncertain: true });
    expect(await run({ out: 'err:sendinput 5\np:0\n', code: 2 })).toMatchObject({ ok: false, sent: 0, uncertain: true });
  });
  it('явная ошибка пустого ввода и полный ответ различимы', async () => {
    expect(await run({ out: 'err:empty\n', code: 3 })).toMatchObject({ ok: false, sent: 0, uncertain: false });
    expect(await run({ out: 'ok:4\n', code: 0 })).toMatchObject({ ok: true, sent: 4, uncertain: false });
  });
});
