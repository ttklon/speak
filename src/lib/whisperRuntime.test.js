// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const cp = require('node:child_process');
const http = require('node:http');
const originalLoad = Module._load, originalSpawn = cp.spawn, originalRequest = http.request;
let root;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => root, getAppPath: () => join(root, 'app') } };
  return originalLoad.call(this, name, ...args);
};
let whisper;
cp.spawn = fakeChild;
try { whisper = require('../../electron/whisper.cjs'); }
finally { Module._load = originalLoad; cp.spawn = originalSpawn; }
let model, wav, children, requests, mode, cliMode, serverMode, pending;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(task, ms = 1500) {
  let timer;
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('операция зависла')), ms); })]); }
  finally { clearTimeout(timer); }
}
function fakeChild(file, args) {
  const isCli = !String(file).includes('whisper-server');
  const cliCount = children.filter((item) => !String(item.file).includes('whisper-server')).length;
  if (isCli && (cliMode === 'throw-first' || (cliMode === 'throw-retry' && cliCount === 1))) throw new Error('не удалось запустить процесс');
  const outFile = `${args[args.indexOf('-of') + 1]}.txt`;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { if (child.exitCode !== null) return false; child.exitCode = 1; queueMicrotask(() => child.emit('close', 1)); return true; };
  children.push({ file, args, child });
  if (String(file).includes('whisper-server') && serverMode === 'first-fails' && children.filter((item) => String(item.file).includes('whisper-server')).length === 1) child.exitCode = 1;
  if (!String(file).includes('whisper-server')) {
    const n = children.filter((item) => !String(item.file).includes('whisper-server')).length;
    if (['vad-fallback', 'throw-retry', 'vad-retry-failed'].includes(cliMode) && n === 1) queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('error: unknown argument --vad'));
      child.exitCode = 1;
      child.emit('close', 1);
    });
    else if (['failed-file', 'failed-log', 'failed-signal', 'failed-empty', 'vad-retry-failed'].includes(cliMode)) queueMicrotask(() => {
      if (cliMode === 'failed-file' || cliMode === 'vad-retry-failed' || cliMode === 'failed-signal') writeFileSync(outFile, 'частичный текст');
      if (cliMode === 'failed-log') child.stdout.emit('data', Buffer.from('частичный текст'));
      child.stderr.emit('data', Buffer.from('error: искусственный сбой'));
      child.exitCode = cliMode === 'failed-signal' ? null : 1;
      child.emit('close', child.exitCode, cliMode === 'failed-signal' ? 'SIGKILL' : null);
    });
    else if (['long-stdout', 'long-stderr', 'long-with-file', 'split-utf8', 'vad-long-retry', 'long-error', 'long-logs-only', 'stdout-boundary', 'retry-stdout', 'retry-read-error'].includes(cliMode)) queueMicrotask(() => {
      if ((cliMode === 'vad-long-retry' || cliMode === 'retry-stdout' || cliMode === 'retry-read-error') && n === 1) {
        child.stderr.emit('data', Buffer.from('error: unknown argument --vad'));
        child.exitCode = 1; child.emit('close', 1); return;
      }
      if (cliMode === 'split-utf8') {
        const bytes = Buffer.from('Привет мир');
        child.stdout.emit('data', bytes.subarray(0, 1)); child.stdout.emit('data', bytes.subarray(1));
      } else if (cliMode === 'stdout-boundary') {
        child.stdout.emit('data', Buffer.from('x'.repeat(40000)));
      } else if (cliMode === 'retry-stdout' || cliMode === 'retry-read-error') {
        child.stdout.emit('data', Buffer.from('готовый ответ'));
        if (cliMode === 'retry-read-error') mkdirSync(outFile);
      } else if (cliMode === 'long-logs-only') {
        child.stderr.emit('data', Buffer.from('whisper_info: ' + 'a'.repeat(21000)));
      } else {
        const stream = cliMode === 'long-stderr' ? child.stderr : child.stdout;
        stream.emit('data', Buffer.from('начало ' + 'а'.repeat(41000) + ' конец'));
        if (cliMode === 'long-with-file') writeFileSync(outFile, 'полный текст из файла');
      }
      child.exitCode = cliMode === 'long-error' ? 1 : 0; child.emit('close', child.exitCode);
    });
    else if (cliMode !== 'hold' && cliMode !== 'vad-fallback') queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('новая модель'));
      child.exitCode = 0;
      child.emit('close', 0);
    });
  }
  return child;
}
function fakeRequest(options, callback) {
  const req = new EventEmitter();
  req.write = () => true;
  req.destroy = () => { queueMicrotask(() => req.emit('error', new Error('отменено'))); };
  req.end = () => {
    requests.push({ method: options.method, path: options.path });
    req.reply = () => {
      const res = new EventEmitter();
      res.statusCode = options.method === 'POST' && mode === 'warm-fail' ? 503 : 200;
      queueMicrotask(() => {
        callback(res);
        const data = options.method === 'POST' ? (mode === 'empty' ? { text: '' } : mode === 'no-text' ? { status: 'ok' } : mode === 'json-null' ? null : mode === 'json-string' ? 'готовый текст' : { text: 'старая модель' }) : {};
        res.emit('data', Buffer.from(options.method === 'POST' && mode === 'plain' ? 'обычный текст' : JSON.stringify(data)));
        if (options.method === 'POST' && mode === 'broken-body') res.emit('aborted');
        else res.emit('end');
      });
    };
    if ((options.method === 'POST' && mode === 'hold') || (options.method === 'GET' && mode === 'hold-ready')) { pending = req; return; }
    req.reply();
  };
  return req;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zs-runtime-'));
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'models'));
  writeFileSync(join(root, 'bin', 'whisper-cli.exe'), 'cli');
  writeFileSync(join(root, 'bin', 'whisper-server.exe'), 'server');
  model = join(root, 'models', 'ggml-small.bin'); writeFileSync(model, 'старые веса');
  wav = join(root, 'voice.wav'); writeFileSync(wav, Buffer.alloc(32044));
  children = []; requests = []; mode = 'ok'; cliMode = 'ok'; serverMode = 'ok'; pending = null;
  cp.spawn = fakeChild; http.request = fakeRequest;
});
afterEach(async () => {
  whisper.cancel();
  whisper.stopServer();
  if (pending) pending.destroy();
  await wait(10);
  cp.spawn = originalSpawn; http.request = originalRequest;
  rmSync(root, { recursive: true, force: true });
});

describe('жизненный цикл прогретого Whisper', () => {
  it('отменяет серверное распознавание и позволяет повторить без перезапуска CLI', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'hold';
    const task = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (!pending) await wait(5); })());
    const busy = whisper.isBusy();
    const cancelled = whisper.cancel();
    if (!cancelled) { pending.destroy(); await task; }
    expect(busy).toBe(true);
    expect(cancelled).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
    expect(whisper.isBusy()).toBe(false);
    mode = 'ok'; pending = null;
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'server' });
  });

  it('параллельные серверные фрагменты отменяются вместе, CLI рядом не запускается', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'hold';
    const first = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (!pending) await wait(5); })());
    const firstReq = pending;
    const second = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (pending === firstReq) await wait(5); })());
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: false }))).toMatchObject({ ok: false, code: 'busy' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(3);
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(Promise.all([first, second]))).toEqual([expect.objectContaining({ code: 'cancelled' }), expect.objectContaining({ code: 'cancelled' })]);
    expect(whisper.isBusy()).toBe(false);
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
  });

  it('сбой одного фрагмента не запускает CLI рядом с другим, следующая диктовка возможна', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'hold';
    const first = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (!pending) await wait(5); })());
    const firstReq = pending;
    const second = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (pending === firstReq) await wait(5); })());
    const secondReq = pending;
    mode = 'broken-body'; firstReq.reply();
    expect(await bounded(first)).toMatchObject({ ok: false, code: 'busy' });
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
    mode = 'ok'; secondReq.reply();
    expect(await bounded(second)).toMatchObject({ ok: true });
    expect(await bounded(whisper.transcribe(wav, { model: 'small' }))).toMatchObject({ ok: true, mode: 'cli' });
    expect(whisper.isBusy()).toBe(false);
  });

  it('сохраняет оба результата параллельных фрагментов', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'hold';
    const first = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (!pending) await wait(5); })());
    const firstReq = pending;
    const second = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (pending === firstReq) await wait(5); })());
    const secondReq = pending;
    secondReq.reply(); firstReq.reply();
    expect(await bounded(Promise.all([first, second]))).toEqual([
      expect.objectContaining({ ok: true, mode: 'server', text: 'старая модель' }),
      expect.objectContaining({ ok: true, mode: 'server', text: 'старая модель' }),
    ]);
    expect(whisper.isBusy()).toBe(false);
  });

  it.each(['empty', 'no-text', 'json-null'])('JSON %s без текста не становится вставляемым ответом', async (response) => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = response;
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: false, text: '', code: 'empty', mode: 'server' });
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
  });

  it.each([['json-string', 'готовый текст'], ['plain', 'обычный текст']])('читает строковый ответ %s без оболочки JSON', async (response, expected) => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = response;
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, text: expected, mode: 'server' });
  });

  it('не зависает при оборванном ответе сервера и переходит на CLI', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'broken-body';
    const task = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    expect(await bounded(task, 500)).toMatchObject({ ok: true, mode: 'cli', text: 'новая модель' });
  });

  it('после замены весов на том же пути не использует сервер со старыми весами', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    writeFileSync(model, 'новые другие веса модели');
    const result = await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }));
    expect(result).toMatchObject({ ok: true, text: 'новая модель', mode: 'cli' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1); // только предварительный прогрев
  });

  it('пробует следующий вариант запуска, если первый сервер сразу завершился', async () => {
    serverMode = 'first-fails';
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    expect(children.filter((item) => String(item.file).includes('whisper-server'))).toHaveLength(2);
  });

  it('замена модели во время запроса не обрывает текущую фразу, но следующий проход не берёт старые веса', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    mode = 'hold';
    const first = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded((async () => { while (!pending) await wait(5); })());
    const replacement = join(root, 'replacement.bin');
    writeFileSync(replacement, 'новые веса после переименования');
    renameSync(replacement, model);
    pending.reply();
    expect(await bounded(first)).toMatchObject({ ok: true, mode: 'server', text: 'старая модель' });
    mode = 'ok'; pending = null;
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'cli', text: 'новая модель' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('не выдаёт за готовую модель, заменённую во время запуска сервера', async () => {
    mode = 'hold-ready';
    const task = whisper.warm('small');
    await bounded((async () => { while (!pending) await wait(5); })());
    writeFileSync(model, 'изменившиеся веса модели');
    pending.reply();
    expect(await bounded(task)).toMatchObject({ ok: false });
    expect(whisper.serverStatus().running).toBe(false);
  });

  it('не сообщает об успешном пробном проходе, если сервер вернул ошибку', async () => {
    mode = 'warm-fail';
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: false });
    mode = 'ok';
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('пока сервер ещё запускается, не отправляет ему распознавание', async () => {
    mode = 'hold-ready';
    const warming = whisper.warm('small');
    await bounded((async () => { while (!pending) await wait(5); })());
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'cli' });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    whisper.stopServer();
    pending.destroy();
    expect(await bounded(warming)).toMatchObject({ ok: false });
  });

  it('немедленная отмена до переключения на CLI не запускает процесс', async () => {
    rmSync(join(root, 'bin', 'whisper-server.exe'));
    const task = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'cancelled' });
    await wait(20);
    expect(children).toHaveLength(0);
  });

  it('остановка отменяет отложенный прогрев', async () => {
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'cli' });
    whisper.stopServer();
    await wait(450);
    expect(children.filter((item) => String(item.file).includes('whisper-server'))).toHaveLength(0);
  });

  it('не сообщает об успешном прогреве, если сервер остановлен во время запроса', async () => {
    mode = 'hold';
    const task = whisper.warm('small');
    await bounded((async () => { while (!pending) await wait(5); })());
    whisper.stopServer();
    pending.destroy();
    expect(await bounded(task)).toMatchObject({ ok: false });
    expect(whisper.serverStatus().running).toBe(false);
  });

  it('остановленный во время запуска сервер не возвращается в фоне', async () => {
    mode = 'hold-ready';
    const task = whisper.warm('small');
    await bounded((async () => { while (!pending) await wait(5); })());
    whisper.stopServer();
    mode = 'ok';
    pending.destroy();
    expect(await bounded(task)).toMatchObject({ ok: false });
    expect(children.filter((item) => String(item.file).includes('whisper-server'))).toHaveLength(1);
    expect(whisper.serverStatus().running).toBe(false);
  });

  it('после замены сервера прогревает новый исполняемый файл', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    const serverFile = join(root, 'bin', 'whisper-server.exe');
    writeFileSync(`${serverFile}.new`, 'другая версия');
    renameSync(`${serverFile}.new`, serverFile);
    expect(whisper.serverStatus().ready).toBe(false);
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    expect(children.filter((item) => String(item.file).includes('whisper-server'))).toHaveLength(2);
  });

  it('после установки сервера запускает сервер и CLI из одного профиля', async () => {
    const oldResources = process.resourcesPath;
    const resources = join(root, 'resources');
    mkdirSync(join(resources, 'bin'), { recursive: true });
    writeFileSync(join(resources, 'bin', 'whisper-cli.exe'), 'встроенный старый CLI');
    process.resourcesPath = resources;
    try {
      expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
      expect(children[0].file).toBe(join(root, 'bin', 'whisper-server.exe'));
      expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: false }))).toMatchObject({ ok: true, mode: 'cli' });
      expect(children[1].file).toBe(join(root, 'bin', 'whisper-cli.exe'));
    } finally {
      if (oldResources === undefined) delete process.resourcesPath; else process.resourcesPath = oldResources;
    }
  });

  it('ошибка запуска CLI после серверного fallback возвращается, не зависая', async () => {
    rmSync(join(root, 'bin', 'whisper-server.exe'));
    cliMode = 'throw-first';
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }), 500)).toMatchObject({ ok: false, reason: 'не удалось запустить процесс' });
    expect(whisper.isBusy()).toBe(false);
  });

  it.each(['long-stdout', 'long-stderr', 'vad-long-retry'])('не выдаёт усечённый вывод %s за готовую расшифровку', async (kind) => {
    cliMode = kind;
    if (kind === 'vad-long-retry') writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    const res = await bounded(whisper.transcribe(wav, { model: 'small', timeout: 10000 }));
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-output-truncated' });
    expect(res.partialText).toMatch(/конец/);
    expect(res.partialText).toMatch(/обрезан/i);
  });

  it('не прячет обрезку при ненулевом выходе', async () => {
    cliMode = 'long-error';
    const res = await bounded(whisper.transcribe(wav, { model: 'small' }));
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-failed' });
    expect(res.partialText).toMatch(/обрезан/);
    expect(res.partialText).toMatch(/конец/);
  });

  it('не выдаёт пустой фильтрованный длинный журнал за полную тишину', async () => {
    cliMode = 'long-logs-only';
    const res = await bounded(whisper.transcribe(wav, { model: 'small' }));
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-output-truncated' });
  });

  it('точная граница stdout не считается обрезкой', async () => {
    cliMode = 'stdout-boundary';
    const res = await bounded(whisper.transcribe(wav, { model: 'small' }));
    expect(res.ok).toBe(true);
    expect(res.text).toHaveLength(40000);
  });

  it('повтор без VAD без файла не выдаёт журнал за готовую расшифровку', async () => {
    cliMode = 'retry-stdout';
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    expect(await bounded(whisper.transcribe(wav, { model: 'small' }))).toMatchObject({ ok: false, text: '', code: 'empty' });
    expect(children).toHaveLength(2);
  });

  it('ошибка чтения файла повтора не подменяется успешным журналом', async () => {
    cliMode = 'retry-read-error';
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    const res = await bounded(whisper.transcribe(wav, { model: 'small' }));
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-failed' });
  });

  it('полный файл предпочтительнее длинного журнала', async () => {
    cliMode = 'long-with-file';
    expect(await bounded(whisper.transcribe(wav, { model: 'small' }))).toMatchObject({ ok: true, text: 'полный текст из файла' });
  });

  it('сохраняет символ UTF-8, разделённый между событиями stdout', async () => {
    cliMode = 'split-utf8';
    expect(await bounded(whisper.transcribe(wav, { model: 'small' }))).toMatchObject({ ok: true, text: 'Привет мир' });
  });

  it('позднее закрытие отменённого CLI не читает и не удаляет вывод нового запуска того же WAV', async () => {
    cliMode = 'hold';
    const first = whisper.transcribe(wav, { model: 'small', timeout: 10000 });
    const oldChild = children[0].child;
    const oldPath = `${children[0].args[children[0].args.indexOf('-of') + 1]}.txt`;
    oldChild.kill = () => true; // процесс завершается позже ответа отмены
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(first)).toMatchObject({ ok: false, code: 'cancelled' });
    const second = whisper.transcribe(wav, { model: 'small', timeout: 10000 });
    const newChild = children[1].child;
    const newPath = `${children[1].args[children[1].args.indexOf('-of') + 1]}.txt`;
    expect(newPath).not.toBe(oldPath);
    writeFileSync(newPath, 'новый результат');
    writeFileSync(oldPath, 'устаревший результат');
    oldChild.emit('close', 0);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    newChild.emit('close', 0);
    expect(await bounded(second)).toMatchObject({ ok: true, text: 'новый результат' });
    expect(existsSync(newPath)).toBe(false);
  });

  it('после таймаута удаляет вывод, появившийся до позднего закрытия CLI', async () => {
    cliMode = 'hold';
    const task = whisper.transcribe(wav, { model: 'small', timeout: 40 });
    const child = children[0].child;
    child.kill = () => true;
    const out = `${children[0].args[children[0].args.indexOf('-of') + 1]}.txt`;
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'timeout' });
    writeFileSync(out, 'временный вывод');
    child.emit('close', 0);
    expect(existsSync(out)).toBe(false);
  });

  it('после отмены повтора без VAD удаляет его поздний вывод', async () => {
    cliMode = 'vad-fallback';
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    const task = whisper.transcribe(wav, { model: 'small', timeout: 10000 });
    await bounded((async () => { while (children.length < 2) await wait(5); })());
    const child = children[1].child;
    const out = `${children[1].args[children[1].args.indexOf('-of') + 1]}.txt`;
    child.kill = () => true;
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'cancelled' });
    writeFileSync(out, 'поздний вывод повтора');
    child.emit('close', 0);
    expect(existsSync(out)).toBe(false);
  });

  it('не принимает оставшийся от прежнего запуска файл за новый результат', async () => {
    writeFileSync(`${wav}.out.txt`, 'старый чужой результат');
    cliMode = 'failed-empty';
    const res = await bounded(whisper.transcribe(wav, { model: 'small', timeout: 10000 }));
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-failed' });
    expect(res.partialText).toBeUndefined();
    expect(existsSync(`${wav}.out.txt`)).toBe(true); // чужой/старый файл не трогаем
  });

  it.each(['failed-file', 'failed-log', 'failed-signal', 'failed-empty', 'vad-retry-failed'])(
    'ошибка CLI (%s) не выдаёт неполный вывод за успешный результат', async (kind) => {
      cliMode = kind;
      if (kind === 'vad-retry-failed') writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
      const res = await bounded(whisper.transcribe(wav, { model: 'small', timeout: 10000 }));
      expect(res).toMatchObject({ ok: false, text: '', code: 'cli-failed' });
      if (kind !== 'failed-empty') expect(res.partialText).toBe('частичный текст');
      expect(existsSync(`${children.at(-1).args[children.at(-1).args.indexOf('-of') + 1]}.txt`)).toBe(false);
      expect(whisper.isBusy()).toBe(false);
      expect(children).toHaveLength(kind === 'vad-retry-failed' ? 2 : 1);
    },
  );

  it('ошибка запуска повтора без VAD освобождает состояние занятости', async () => {
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    cliMode = 'throw-retry';
    expect(await bounded(whisper.transcribe(wav, { model: 'small', timeout: 10000 }), 500)).toMatchObject({ ok: false, reason: 'не удалось запустить процесс' });
    expect(whisper.isBusy()).toBe(false);
  });

  it('повтор без VAD сохраняет параметры тщательного прохода', async () => {
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    cliMode = 'vad-fallback';
    const task = whisper.transcribe(wav, { model: 'small', thorough: true, timeout: 10000 });
    await bounded((async () => { while (children.length < 2) await wait(5); })());
    const args = children[1].args;
    expect(args).not.toContain('--vad');
    expect(args).not.toContain('-nf');
    expect(args).not.toContain('-ac');
    expect(args[args.indexOf('-bs') + 1]).toBe('5');
    expect(args).toContain('-et');
    whisper.cancel(); await bounded(task);
  });

  it('таймаут действует и на повтор без VAD', async () => {
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    cliMode = 'vad-fallback';
    const task = whisper.transcribe(wav, { model: 'small', timeout: 50 });
    const result = await bounded(task, 500);
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    expect(children).toHaveLength(2);
    expect(children.at(-1).child.exitCode).not.toBeNull();
    expect(whisper.isBusy()).toBe(false);
  });

  it('отменяет повтор без VAD и завершает его без зависания', async () => {
    writeFileSync(join(root, 'models', 'ggml-silero-v6.2.0.bin'), 'vad');
    cliMode = 'vad-fallback';
    const task = whisper.transcribe(wav, { model: 'small', keepLoaded: false, timeout: 10000 });
    await bounded((async () => { while (children.length < 2) await wait(5); })());
    const busy = whisper.isBusy();
    const cancelled = whisper.cancel();
    if (!cancelled) { children.at(-1).child.emit('close', 1); await task; }
    expect(busy).toBe(true);
    expect(cancelled).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'cancelled' });
    expect(children.at(-1).child.exitCode).not.toBeNull();
  });
});
