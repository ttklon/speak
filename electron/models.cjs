/**
 * Загрузка моделей whisper.cpp и самого движка прямо из приложения.
 *
 * Всё скачивается по HTTPS с официальных адресов (GitHub / Hugging Face) в
 * %APPDATA%\ZSpeakly\models и \bin. Прогресс уходит в окно событиями
 * `model:progress`, чтобы кнопка в настройках показывала проценты.
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { app } = require('electron');
const whisper = require('./whisper.cjs');

// Реальные файлы из ggml-org/whisper.cpp на Hugging Face (те же имена, что в
// официальном download-ggml-model.sh). mb — ожидаемый размер для прогресса.
const MODELS = {
  tiny: { file: 'ggml-tiny.bin', mb: 75 },
  // Квантованные веса: то же качество почти без потерь, но в 2–3 раза меньше
  // файл и заметно быстрее на CPU. Именно так работают быстрые диктовочные
  // приложения: int8/q5 вместо fp16.
  'tiny-q5_1': { file: 'ggml-tiny-q5_1.bin', mb: 32 },
  base: { file: 'ggml-base.bin', mb: 142 },
  'base-q5_1': { file: 'ggml-base-q5_1.bin', mb: 60 },
  small: { file: 'ggml-small.bin', mb: 466 },
  'small-q5_1': { file: 'ggml-small-q5_1.bin', mb: 190 },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1549 },
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547 },
  'large-v3-turbo-q8_0': { file: 'ggml-large-v3-turbo-q8_0.bin', mb: 874 },
  medium: { file: 'ggml-medium.bin', mb: 1530 },
};

/**
 * VAD (Silero v6.2, ggml, меньше мегабайта): whisper запускается с `--vad`,
 * тишина и паузы не гоняются через модель. Это тот самый «гейт» из быстрых
 * диктовочных приложений: он и ускоряет ответ, и убирает выдуманные фразы
 * на пустом звуке.
 */
const VAD = {
  file: 'ggml-silero-v6.2.0.bin',
  mb: 1,
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
};

function dirs() {
  const root = app.getPath('userData');
  return {
    models: path.join(root, 'models'),
    bin: path.join(root, 'bin'),
  };
}

function ensureDirs() {
  const d = dirs();
  for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
  return d;
}

function modelStatus() {
  const d = dirs();
  const out = {};
  for (const [id, meta] of Object.entries(MODELS)) {
    const p = path.join(d.models, meta.file);
    const exists = fs.existsSync(p);
    out[id] = {
      id,
      file: meta.file,
      path: p,
      sizeMb: meta.mb,
      downloaded: exists,
      // В комплекте тоже может быть модель. Удаление доступно только для
      // файла профиля, но распознавание может использовать оба расположения.
      available: Boolean(whisper.findExactModel(id)),
      actualMb: exists ? Math.round(fs.statSync(p).size / (1024 * 1024)) : 0,
    };
  }
  // Используем те же пути, что и реальное распознавание: в том числе
  // resources установщика и PATH, а не только скачанное в профиль.
  const bin = Boolean(whisper.findBinary());
  const server = whisper.serverStatus().available;
  const vadPath = whisper.findVadModel() || '';
  const availableModel = Object.values(out).some((model) => model.available) || Boolean(whisper.findModel(''));
  return { models: out, availableModel, bin, server, vad: Boolean(vadPath), vadPath, vadSizeMb: VAD.mb };
}

// Одна подготовка Whisper/VAD/движка; блокировка включает поиск и распаковку.
const { createDownloadManager, removeTemporary } = require('./whisperDownload.cjs');
const { download, cancelDownload, runExclusive, isBusy } = createDownloadManager();
const busyResult = () => ({ ok: false, reason: 'другая операция подготовки уже выполняется' });

async function downloadModel(id, onProgress) {
  const meta = MODELS[id];
  if (!meta) return { ok: false, reason: `неизвестная модель ${id}` };
  if (isBusy()) return busyResult();
  const d = ensureDirs();
  const dest = path.join(d.models, meta.file);
  const existing = whisper.findExactModel(id);
  if (existing) return { ok: true, already: true, path: existing };
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${meta.file}`;
  try {
    await download(url, dest, onProgress);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, reason: err.message, ...(err.cleanupFailed ? { cleanupFailed: true } : {}), ...(err.message === 'скачивание отменено' ? { canceled: true } : {}) };
  }
}

/**
 * Удаление скачанной модели. Раньше «скачал несколько — старые не убрать»:
 * файлы лежали в профиле навсегда (base 142 МБ, small 466 МБ, turbo 1,5 ГБ).
 * Возвращаем освобождённые мегабайты, чтобы интерфейс сказал это словами.
 */
function deleteModel(id) {
  const meta = MODELS[id];
  if (!meta) return { ok: false, reason: `неизвестная модель ${id}` };
  // Проверка и удаление синхронны, поэтому другая операция не успеет
  // захватить блокировку между ними в главном потоке.
  if (isBusy()) return busyResult();
  const d = ensureDirs();
  const file = path.join(d.models, meta.file);
  if (!fs.existsSync(file)) return { ok: false, reason: 'модель не скачана' };
  let mb = meta.mb;
  try {
    mb = Math.round((fs.statSync(file).size / (1024 * 1024)) * 10) / 10;
    fs.rmSync(file, { force: true });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, freedMb: mb, id };
}

/**
 * VAD-модель: маленькая (0,9 МБ), но именно она отсекает тишину. Качаем без
 * прогресса — файл настолько мал, что проценты только мешают.
 */
async function downloadVad() {
  if (isBusy()) return busyResult();
  const d = ensureDirs();
  const dest = path.join(d.models, VAD.file);
  const existing = whisper.findVadModel();
  if (existing) return { ok: true, already: true, path: existing };
  try {
    await download(VAD.url, dest, undefined);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, reason: err.message, ...(err.cleanupFailed ? { cleanupFailed: true } : {}), ...(err.message === 'скачивание отменено' ? { canceled: true } : {}) };
  }
}

/**
 * Движок whisper.cpp: берём последний релиз ggml-org/whisper.cpp,
 * asset whisper-bin-x64.zip, распаковываем .exe/.dll в userData\bin.
 */
async function fetchJson(url, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ZSpeakly', Accept: 'application/vnd.github+json' },
      timeout: 120000,
      signal,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.on('error', () => {});
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          res.destroy(new Error('список сборок слишком большой'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('соединение прервано')));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('таймаут запроса')));
    req.on('error', reject);
  });
}

/** Новейший релиз, в котором реально есть whisper-bin-x64.zip. */
async function findEngineAsset(signal) {
  const want = ['whisper-bin-x64.zip', 'whisper-bin-Win32.zip'];
  const releases = await fetchJson('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30', signal);
  for (const rel of Array.isArray(releases) ? releases : []) {
    for (const name of want) {
      const asset = (rel.assets || []).find((a) => a.name === name);
      if (asset) return { asset, release: rel.tag_name };
    }
  }
  return null;
}

// execFile может вызвать callback при AbortError раньше, чем процесс закроется.
// Дожидаемся close, прежде чем удалять архив и каталог распаковки на Windows.
function unpackArchive(zip, out, signal) {
  const { execFile } = require('node:child_process');
  const quote = (value) => value.replace(/'/g, "''");
  return new Promise((resolve, reject) => {
    let failure;
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${quote(zip)}', '${quote(out)}')`],
      { windowsHide: true, timeout: 120000, signal },
      (err) => { failure = err; },
    );
    child.once('close', () => failure ? reject(failure) : resolve());
  });
}

async function downloadEngine(onProgress, { force = false } = {}) {
  if (isBusy()) return busyResult();
  const d = ensureDirs();
  // force — «движок есть, но сервера распознавания в нём нет».
  const existing = whisper.findBinary();
  if (existing && !force) return { ok: true, already: true, path: path.dirname(existing) };

  try {
    return await runExclusive(async ({ signal, download: downloadArchive }) => {
      let found;
      try { found = await findEngineAsset(signal); }
      catch (err) { throw new Error(`GitHub недоступен: ${err.message}`); }
      if (!found) throw new Error('не нашёл сборку whisper.cpp для Windows x64');
      const asset = found.asset;
      try {
        const address = new URL(asset.browser_download_url);
        if (address.protocol !== 'https:' || address.username || address.password) throw new Error();
      } catch { throw new Error('неверный адрес архива'); }
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('не указан размер архива');
      if (asset.digest != null && !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
        throw new Error('неизвестный хеш архива');
      }

      const zip = path.join(d.bin, 'whisper-bin-x64.zip');
      const out = path.join(d.bin, '_unpacked');
      try {
        try { await downloadArchive(asset.browser_download_url, zip, (p) => onProgress?.(Math.round(p * 0.7)), { maxBytes: asset.size }); }
        catch (err) {
          if (err.cleanupFailed) throw err;
          throw new Error(`не скачался архив: ${err.message}`);
        }
        if (fs.statSync(zip).size !== asset.size) throw new Error('неверный размер архива');
        if (asset.digest) {
          // Хеш получен из ответа GitHub, а не из закреплённого манифеста.
          const { hashFile } = require('./modelDownload.cjs');
          const actual = await hashFile(zip, signal);
          if (actual !== asset.digest.slice(7).toLowerCase()) throw new Error('архив пришёл повреждённым');
        }
        fs.rmSync(out, { recursive: true, force: true });
        try { await unpackArchive(zip, out, signal); }
        catch { throw new Error('не удалось распаковать архив'); }
        if (signal.aborted) throw new Error('скачивание отменено');

        onProgress?.(85);
        const files = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) files.push(full);
          }
        };
        walk(out);
        if (!files.some((file) => /^(whisper-cli|whisper|main)\.exe$/i.test(path.basename(file)))) {
          throw new Error('в архиве нет программы распознавания');
        }
        require('./installEngine.cjs').installEngineFiles(files, d.bin);
        onProgress?.(100);
        const after = modelStatus();
        return { ok: true, path: d.bin, bin: after.bin, server: after.server };
      } finally {
        removeTemporary([
          [out, { recursive: true, force: true }],
          [zip, { force: true }],
        ]);
      }
    });
  } catch (err) {
    return { ok: false, reason: err.message, ...(err.cleanupFailed ? { cleanupFailed: true } : {}), ...(err.message === 'скачивание отменено' ? { canceled: true } : {}) };
  }
}

/**
 * Подхватить модель, скачанную вручную (например, из Hugging Face в «Загрузки»).
 * Копируем в userData\models под правильным именем ggml-*.bin.
 */
async function importModel(sourcePath, onProgress) {
  let file = sourcePath;
  if (!file) {
    const { dialog } = require('electron');
    const picked = await dialog.showOpenDialog({
      title: 'Выберите файл модели ggml',
      properties: ['openFile'],
      filters: [{ name: 'Модель whisper.cpp', extensions: ['bin'] }],
    });
    if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
    file = picked.filePaths[0];
  }

  try {
    return await runExclusive(async ({ signal }) => {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        return { ok: false, reason: `файл не читается: ${err.message}` };
      }
      if (stat.size < 20 * 1024 * 1024) {
        return { ok: false, reason: 'это не похоже на модель whisper.cpp (меньше 20 МБ)' };
      }

      // whisper.cpp записывает 0x67676d6c в порядке little-endian, то есть «lmgg».
      // Это только проверка заголовка, а не доказательство целостности всей модели.
      try {
        const head = Buffer.alloc(4);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, head, 0, 4, 0); }
        finally { fs.closeSync(fd); }
        const magic = head.toString('latin1');
        if (magic !== 'lmgg') {
          return {
            ok: false,
            reason: 'файл не в формате ggml — скачайте модель ggml-*.bin (whisper.cpp / Hugging Face)',
          };
        }
      } catch (err) {
        return { ok: false, reason: `не удалось прочитать начало файла: ${err.message}` };
      }

      // Имя берём из названия файла, если оно совпадает с известной моделью,
      // иначе — по размеру (размеры различаются в разы, спутать сложно).
      const mb = stat.size / (1024 * 1024);
      const byName = /ggml-([a-z0-9._-]+)\.bin$/i.exec(path.basename(file));
      const known = byName && MODELS[byName[1]] ? byName[1] : '';
      const guess =
        known ||
        Object.entries(MODELS)
          .map(([id, meta]) => ({ id, diff: Math.abs(meta.mb - mb) }))
          .sort((a, b) => a.diff - b.diff)[0].id;
      const target = path.join(ensureDirs().models, `ggml-${guess}.bin`);

      try {
        // Тот же файл уже лежит на месте — не копируем гигабайты сами в себя.
        const canonical = (p) => {
          const real = fs.realpathSync(p);
          return process.platform === 'win32' ? real.toLowerCase() : real;
        };
        if (!fs.existsSync(target) || canonical(file) !== canonical(target)) {
          // Сначала копия на том же диске; старая модель не затрагивается, пока
          // полная копия не готова. Импорт и загрузка используют общую блокировку.
          const staging = fs.mkdtempSync(path.join(path.dirname(target), '.import-'));
          try {
            const temporary = path.join(staging, 'model.bin');
            // Копирование больших моделей выполняется вне главного потока.
            // Операцию копирования нельзя прервать, но после отмены её результат
            // не заменит прежнюю модель.
            await fs.promises.copyFile(file, temporary);
            if (signal.aborted) throw new Error('скачивание отменено');
            fs.renameSync(temporary, target);
          } finally {
            removeTemporary([[staging, { recursive: true, force: true }]]);
          }
        }
      } catch (err) {
        if (signal.aborted || err.cleanupFailed) throw err;
        return { ok: false, reason: `не удалось скопировать: ${err.message}` };
      }
      onProgress?.(100);
      return { ok: true, id: guess, path: target, sizeMb: Math.round(mb) };
    });
  } catch (err) {
    return { ok: false, reason: err.message, ...(err.cleanupFailed ? { cleanupFailed: true } : {}), ...(err.message === 'скачивание отменено' ? { canceled: true } : {}) };
  }
}

module.exports = { modelStatus, downloadModel, downloadVad, downloadEngine, deleteModel, importModel, cancelDownload, MODELS, VAD };
