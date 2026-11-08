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

const MODELS = {
  tiny: { file: 'ggml-tiny.bin', mb: 75 },
  small: { file: 'ggml-small.bin', mb: 466 },
  medium: { file: 'ggml-medium.bin', mb: 1500 },
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
      actualMb: exists ? Math.round(fs.statSync(p).size / (1024 * 1024)) : 0,
    };
  }
  const bin = ['whisper-cli.exe', 'whisper.exe', 'main.exe', 'whisper-cli'].some((n) =>
    fs.existsSync(path.join(d.bin, n)),
  );
  return { models: out, bin };
}

/** Скачивание с редиректами и прогрессом. */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('слишком много редиректов'));
      return;
    }
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'ZSpeakly', Accept: '*/*' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const tmp = `${dest}.part`;
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) onProgress?.(Math.round((received / total) * 100), received, total);
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve({ bytes: received });
          });
        });
        file.on('error', (err) => {
          fs.rmSync(tmp, { force: true });
          reject(err);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy(new Error('таймаут загрузки'));
    });
  });
}

async function downloadModel(id, onProgress) {
  const meta = MODELS[id];
  if (!meta) return { ok: false, reason: `неизвестная модель ${id}` };
  const d = ensureDirs();
  const dest = path.join(d.models, meta.file);
  if (fs.existsSync(dest)) return { ok: true, already: true, path: dest };
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${meta.file}`;
  try {
    await download(url, dest, onProgress);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Движок whisper.cpp: берём последний релиз ggml-org/whisper.cpp,
 * asset whisper-bin-x64.zip, распаковываем .exe/.dll в userData\bin.
 */
async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'ZSpeakly', Accept: 'application/vnd.github+json' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

/** Новейший релиз, в котором реально есть whisper-bin-x64.zip. */
async function findEngineAsset() {
  const want = ['whisper-bin-x64.zip', 'whisper-bin-Win32.zip'];
  const releases = await fetchJson('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30');
  for (const rel of Array.isArray(releases) ? releases : []) {
    for (const name of want) {
      const asset = (rel.assets || []).find((a) => a.name === name);
      if (asset) return { asset, release: rel.tag_name };
    }
  }
  return null;
}

async function downloadEngine(onProgress) {
  const d = ensureDirs();
  if (modelStatus().bin) return { ok: true, already: true, path: d.bin };

  let found;
  try {
    found = await findEngineAsset();
  } catch (err) {
    return { ok: false, reason: `GitHub недоступен: ${err.message}` };
  }
  if (!found) return { ok: false, reason: 'не нашёл сборку whisper.cpp для Windows x64' };
  const asset = found.asset;

  const zip = path.join(d.bin, 'whisper-bin-x64.zip');
  try {
    await download(asset.browser_download_url, zip, (p) => onProgress?.(Math.round(p * 0.7)));
  } catch (err) {
    return { ok: false, reason: `не скачался архив: ${err.message}` };
  }

  // Распаковка без внешних зависимостей: PowerShell Expand-Archive на Windows
  const { execFile } = require('node:child_process');
  const out = path.join(d.bin, '_unpacked');
  fs.rmSync(out, { recursive: true, force: true });
  const ok = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`,
      ],
      { windowsHide: true, timeout: 120000 },
      (err) => resolve(!err),
    );
  });
  if (!ok) return { ok: false, reason: 'не удалось распаковать архив' };

  onProgress?.(85);
  // копируем все exe/dll из подпапок (в архиве есть Release/)
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(exe|dll)$/i.test(entry.name)) {
        fs.copyFileSync(full, path.join(d.bin, entry.name));
      }
    }
  };
  walk(out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
  onProgress?.(100);
  return { ok: true, path: d.bin, bin: modelStatus().bin };
}

module.exports = { modelStatus, downloadModel, downloadEngine, MODELS };
