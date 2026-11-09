/**
 * Офлайн-распознавание речи через whisper.cpp.
 *
 * ZSpeakly ищет `whisper-cli.exe` (или whisper.exe / main.exe) в:
 *   1) resources/bin (рядом с установленным приложением),
 *   2) %APPDATA%\ZSpeakly\bin,
 *   3) PATH.
 * Модель — ggml-*.bin в %APPDATA%\ZSpeakly\models или resources/models.
 *
 * Если движка нет, ZSpeakly честно сообщает об этом и работает через
 * Web Speech, а в браузерном превью — через демо-движок.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const BIN_NAMES = ['whisper-cli.exe', 'whisper.exe', 'main.exe', 'whisper-cli', 'whisper'];

function candidates(...paths) {
  return paths.filter(Boolean);
}

function findBinary() {
  const roots = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'bin'),
    path.join(app.getPath('userData'), 'bin'),
    path.join(app.getAppPath(), 'bin'),
  );
  for (const dir of roots) {
    for (const name of BIN_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  // PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of BIN_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function findModel(preferred = 'small') {
  const dirs = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getAppPath(), 'models'),
  );
  const wanted = [`ggml-${preferred}.bin`, 'ggml-small.bin', 'ggml-tiny.bin', 'ggml-medium.bin'];
  for (const dir of dirs) {
    for (const name of wanted) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function status(preferredModel = 'small') {
  const bin = findBinary();
  const model = findModel(preferredModel);
  return {
    available: Boolean(bin && model),
    bin,
    model,
    reason: !bin ? 'whisper.cpp не найден' : !model ? 'модель ggml не найдена' : '',
  };
}

/**
 * Транскрипция wav-файла (16 kHz mono PCM).
 * Возвращает { ok, text, segments }.
 */
function transcribe(wavPath, { lang = 'ru', model = 'small', prompt = '', timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const bin = findBinary();
    const modelPath = findModel(model);
    if (!bin || !modelPath) {
      resolve({ ok: false, text: '', reason: 'whisper.cpp недоступен' });
      return;
    }

    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', lang || 'auto',
      '--no-timestamps',
      '-nt',
      '-otxt',
      '-of', `${wavPath}.out`,
    ];
    if (prompt) args.push('--prompt', prompt);

    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: '', reason: 'таймаут распознавания' });
    }, timeout);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: '', reason: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const txt = `${wavPath}.out.txt`;
        if (fs.existsSync(txt)) {
          const text = fs.readFileSync(txt, 'utf8').trim();
          fs.unlinkSync(txt);
          resolve({ ok: true, text, code });
          return;
        }
      } catch (err) {
        resolve({ ok: false, text: '', reason: err.message });
        return;
      }
      resolve({ ok: false, text: '', reason: stderr.slice(-400) || `код ${code}` });
    });
  });
}

module.exports = { status, transcribe, findBinary, findModel };
