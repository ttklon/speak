/**
 * Настоящий тест движка распознавания: запускает whisper.cpp (whisper-cli)
 * на сгенерированном WAV и проверяет контракт, который ждёт main-процесс.
 *
 * Зачем: остальные проверки подменяли движок заглушкой и потому не видели,
 * что реальный whisper-cli запускается не так, как ожидает приложение.
 *
 * Запуск:
 *   ZS_WHISPER_BIN=/путь/whisper-cli ZS_WHISPER_MODEL=/путь/ggml-*.bin node scripts/test-whisper-live.mjs
 * Без переменных окружения тест ищет whisper-cli в PATH и модели в models/.
 * Если движка нет — тест честно пропускается (код 0), чтобы не ломать CI.
 */

import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-whisper-'));
fs.mkdirSync(path.join(userData, 'bin'), { recursive: true });
fs.mkdirSync(path.join(userData, 'models'), { recursive: true });

// ── подмена electron: whisper.cjs использует только app.getPath ─────────────
const electronStub = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
    getAppPath: () => path.join(process.cwd(), 'app'),
    isPackaged: false,
  },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};

/** Длительность/частота WAV — для проверки, что движок читает файл. */
function writeSilenceWav(file, seconds = 3, sampleRate = 16000) {
  const samples = seconds * sampleRate;
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const results = [];
const check = (ok, label, extra = '') => {
  results.push({ ok, label, extra });
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const whisper = require('../electron/whisper.cjs');

// ── движок: env или PATH; модель: env или models/ ──────────────────────────
const binEnv = process.env.ZS_WHISPER_BIN || '';
let bin = binEnv && fs.existsSync(binEnv) ? binEnv : null;
if (!bin) {
  const found = whisper.findBinary();
  if (found) bin = found;
}
let model = process.env.ZS_WHISPER_MODEL || '';
if (!model || !fs.existsSync(model)) {
  const foundModel = whisper.findModel('tiny');
  model = foundModel || '';
}

if (!bin || !model) {
  console.log('  · whisper-cli или модель не найдены — тест движка пропущен');
  console.log(`    bin=${bin || 'нет'} model=${model || 'нет'}`);
  process.exit(0);
}

// Кладём по путям, которые ищет приложение: userData/bin и userData/models
const binName = path.basename(bin);
fs.copyFileSync(bin, path.join(userData, 'bin', binName));
// имя модели должно быть каноническим: приложение ищет ggml-<id>.bin
const modelId = path.basename(model).replace(/^for-tests-/, '').replace(/^ggml-/, '').replace(/\.bin$/, '');
fs.copyFileSync(model, path.join(userData, 'models', `ggml-${modelId}.bin`));
// рядом с whisper-cli могут быть .so/.dll — без них он не запустится
for (const file of fs.readdirSync(path.dirname(bin))) {
  if (/\.(so|dll|dylib)/.test(file) || /\.so\./.test(file)) {
    try {
      fs.copyFileSync(path.join(path.dirname(bin), file), path.join(userData, 'bin', file));
    } catch {
      /* симлинк уже скопирован или занят */
    }
  }
}

const wav = path.join(userData, 'probe.wav');
writeSilenceWav(wav, 3);

const status = whisper.status('tiny');
check(status.available === true, 'движок и модель найдены', path.basename(status.model || ''));

const started = Date.now();
const res = await whisper.transcribe(wav, { lang: 'ru', model: modelId, timeout: 120000 });
const ms = Date.now() - started;
check(typeof res === 'object' && 'ok' in res, 'контракт ответа соблюдён', `ok=${res.ok} ms=${ms}`);
check(
  res.ok === true || ['empty', 'cancelled', 'timeout'].includes(res.code),
  'пустой результат помечен кодом, а не «успехом»',
  `code=${res.code || '—'} reason=${String(res.reason || '').slice(0, 40)}`,
);
check(!fs.existsSync(`${wav}.out.txt`), 'служебный .out.txt удалён после прохода');

// ── отмена ────────────────────────────────────────────────────────────────
const longWav = path.join(userData, 'long.wav');
writeSilenceWav(longWav, 40);
const running = whisper.transcribe(longWav, { lang: 'ru', model: 'tiny', timeout: 120000 });
await new Promise((r) => setTimeout(r, 900));
const cancelled = whisper.cancel('тест');
const stopped = await Promise.race([
  running,
  new Promise((r) => setTimeout(() => r({ ok: null, code: 'still-running' }), 5000)),
]);
check(cancelled === true, 'отмена принята');
check(stopped?.code === 'cancelled', 'проход завершился по отмене', `code=${stopped?.code}`);
check(stopped?.ok === false, 'отменённый проход не выдаёт текст');

fs.rmSync(userData, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? '✗' : '✓'} Движок распознавания: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
