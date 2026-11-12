/**
 * Офлайн-распознавание речи через whisper.cpp.
 *
 * ZSpeakly ищет `whisper-cli.exe` (или whisper.exe / main.exe) в:
 *   1) resources/bin (рядом с установленным приложением),
 *   2) %APPDATA%\ZSpeakly\bin,
 *   3) PATH.
 * Модель — ggml-*.bin в %APPDATA%\ZSpeakly\models или resources/models.
 *
 * Если движка нет, ZSpeakly честно сообщает об этом: в приложении остаётся
 * Web Speech, а в браузерном превью — только его возможности.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const BIN_NAMES = ['whisper-cli.exe', 'whisper.exe', 'main.exe', 'whisper-cli', 'whisper'];
const SERVER_NAMES = ['whisper-server.exe', 'whisper-server'];

function candidates(...paths) {
  return paths.filter(Boolean);
}

function findBinary(names = BIN_NAMES) {
  const roots = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'bin'),
    path.join(app.getPath('userData'), 'bin'),
    path.join(app.getAppPath(), 'bin'),
  );
  for (const dir of roots) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  // PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of names) {
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

// Порядок, в котором модели устраивают диктовку: сначала то, что выбрал
// человек, потом разумные замены (turbo → small → base → tiny → medium).
const FALLBACK_ORDER = [
  'large-v3-turbo',
  'large-v3-turbo-q5_0',
  'small',
  'base',
  'tiny',
  'medium',
  'large-v3',
];

function findModel(preferred = 'small') {
  const dirs = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getAppPath(), 'models'),
  );
  const wanted = [];
  const push = (id) => {
    const name = `ggml-${id}.bin`;
    if (!wanted.includes(name)) wanted.push(name);
  };
  if (preferred) push(preferred);
  // выбранная модель может быть не скачана — тогда берём любую подходящую,
  // иначе диктовка «молча не работает» при наличии рабочей модели на диске
  FALLBACK_ORDER.forEach(push);
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
    // чего именно не хватает — чтобы интерфейс мог объяснить это словами
    missing: !bin ? 'bin' : !model ? 'model' : '',
    reason: !bin ? 'whisper.cpp не найден' : !model ? 'модель ggml не найдена' : '',
    modelName: model ? path.basename(model) : '',
    server: serverStatus(),
  };
}

// ── Серверный режим: модель остаётся в памяти между диктовками ──────────────
//
// whisper-cli каждый раз заново грузит модель: для turbo это 1–3 секунды до
// первого слова. Локальные диктовочные приложения держат модель загруженной —
// в комплекте whisper.cpp есть whisper-server, который это умеет. Включается
// настройкой «Держать модель в памяти»; если сервера в комплекте нет или он не
// поднялся, всё честно возвращается к обычному запуску whisper-cli.

let serverState = null; // { proc, port, modelPath, readyAt }
let serverCooldownUntil = 0;

function serverBinary() {
  return findBinary(SERVER_NAMES);
}

function serverStatus() {
  return {
    available: Boolean(serverBinary()),
    running: Boolean(serverState && serverState.proc && serverState.proc.exitCode === null),
    port: serverState?.port || 0,
  };
}

function stopServer() {
  if (!serverState) return;
  const { proc } = serverState;
  serverState = null;
  try {
    proc?.kill();
  } catch {
    /* ignore */
  }
}

function httpJson({ port, method = 'GET', urlPath, body, headers = {}, timeout = 60000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('таймаут сервера распознавания')));
    req.on('error', (err) => resolve({ ok: false, status: 0, text: '', data: null, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Поднять whisper-server на свободном порту и дождаться готовности. */
async function ensureServer(modelPath, { threads = 4 } = {}) {
  if (Date.now() < serverCooldownUntil) return null;
  const bin = serverBinary();
  if (!bin) return null;
  if (serverState && serverState.modelPath === modelPath && serverState.proc?.exitCode === null) {
    return serverState;
  }
  stopServer();
  const port = 17800 + Math.floor(Math.random() * 400);
  let proc;
  try {
    proc = spawn(
      bin,
      ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-nt', '-sns'],
      { windowsHide: true },
    );
  } catch {
    serverCooldownUntil = Date.now() + 5 * 60 * 1000;
    return null;
  }
  const state = { proc, port, modelPath };
  serverState = state;
  let stderr = '';
  proc.stderr?.on('data', (d) => {
    stderr += String(d);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.on('error', () => {
    if (serverState === state) serverState = null;
  });

  // Готовность: сервер начинает отвечать на GET /. Модель грузится секунды.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const ping = await httpJson({ port, urlPath: '/', timeout: 1500 });
    if (ping.status) return state;
    await sleep(250);
  }
  // не поднялся: не блокируем диктовку на каждой попытке
  if (serverState === state) stopServer();
  serverCooldownUntil = Date.now() + 5 * 60 * 1000;
  return null;
}

/**
 * Прогрев: заранее поднять whisper-server с моделью, чтобы первая диктовка
 * после запуска приложения не платила за загрузку модели.
 */
async function warm(model) {
  const modelPath = findModel(model);
  if (!modelPath) return { ok: false, reason: 'модель не найдена' };
  if (!serverBinary()) return { ok: false, reason: 'в комплекте нет whisper-server' };
  const threads = Math.max(1, Math.min(8, require('node:os').cpus().length || 4));
  const server = await ensureServer(modelPath, { threads });
  return server ? { ok: true, port: server.port } : { ok: false, reason: 'whisper-server не поднялся' };
}

function multipart(fields, fileField) {
  const boundary = `----zspeakly${Date.now().toString(16)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
        'Content-Type: audio/wav\r\n\r\n',
    ),
  );
  parts.push(fileField.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Один запрос к уже поднятому серверу. Возвращает текст или null. */
async function transcribeViaServer(wavPath, { lang = 'ru', prompt = '', timeout = 120000, threads = 4, modelPath } = {}) {
  const server = await ensureServer(modelPath, { threads });
  if (!server) return null;
  const audio = fs.readFileSync(wavPath);
  const { body, contentType } = multipart(
    {
      language: lang || 'auto',
      prompt: prompt || '',
      temperature: '0.0',
      response_format: 'json',
      'no_timestamps': 'true',
    },
    { name: 'file', filename: path.basename(wavPath), buffer: audio },
  );
  const res = await httpJson({
    port: server.port,
    method: 'POST',
    urlPath: '/inference',
    body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    timeout,
  });
  if (!res.ok) {
    // сервер мог упасть — следующий раз пойдём обычным путём
    if (!res.status) {
      stopServer();
      serverCooldownUntil = Date.now() + 60 * 1000;
    }
    return null;
  }
  const text = String(res.data?.text || res.text || '').trim();
  return { text };
}

/**
 * Транскрипция wav-файла (16 kHz mono PCM).
 * Возвращает { ok, text, segments }.
 */
function transcribe(wavPath, { lang = 'ru', model = 'small', prompt = '', timeout = 120000, keepLoaded = false } = {}) {
  return new Promise((resolve) => {
    const bin = findBinary();
    const modelPath = findModel(model);
    if (!bin || !modelPath) {
      resolve({ ok: false, text: '', reason: 'whisper.cpp недоступен' });
      return;
    }
    const threads = Math.max(1, Math.min(8, require('node:os').cpus().length || 4));

    // Серверный режим: модель уже в памяти — текст приходит без холодного старта.
    if (keepLoaded) {
      transcribeViaServer(wavPath, { lang, prompt, timeout, threads, modelPath }).then((fast) => {
        if (fast && fast.text) resolve({ ok: true, text: fast.text, mode: 'server' });
        else runCli();
      });
      return;
    }
    runCli();

    function runCli() {

    // -t: все ядра, -np: без служебного вывода, -sns: подавляем токены
    // «не речь» (музыка, [MUSIC], аплодисменты) — иначе на тишине whisper
    // любит выдумывать «Спасибо за просмотр» и «Продолжение следует».
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', lang || 'auto',
      '-t', String(threads),
      '--no-timestamps',
      '-nt',
      '-np',
      '-sns',
      '-otxt',
      '-of', `${wavPath}.out`,
    ];
    if (prompt) args.push('--prompt', prompt);

    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, text: '', reason: 'таймаут распознавания' });
    }, timeout);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // старые сборки whisper.cpp пишут расшифровку в stderr, а не в файл
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 40000) stdout = stdout.slice(-40000);
    });
    child.on('error', (err) => {
      finish({ ok: false, text: '', reason: err.message });
    });
    child.on('close', (code) => {
      // 1) файл -otxt, если сборка его пишет
      try {
        const txt = `${wavPath}.out.txt`;
        if (fs.existsSync(txt)) {
          const text = fs.readFileSync(txt, 'utf8').trim();
          fs.unlinkSync(txt);
          if (text) {
            finish({ ok: true, text, code });
            return;
          }
        }
      } catch (err) {
        finish({ ok: false, text: '', reason: err.message });
        return;
      }
      // 2) вывод процесса: убираем служебные строки whisper.cpp
      const fromLog = (blob) =>
        blob
          .split(/\r?\n/)
          .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
          .filter((line) => line)
          .filter(
            (line) =>
              !/^(whisper_|ggml_|system_info|main:|output_|load_|mem_|init:)/i.test(line) &&
              !/^error:/i.test(line) &&
              !/^\s*(warning|using|processing|auto-detected)/i.test(line),
          )
          .join(' ')
          .trim();
      const text = fromLog(stdout) || fromLog(stderr);
      if (text) {
        finish({ ok: true, text, code });
        return;
      }
      const reason = (stderr || stdout).slice(-400).trim();
      finish({
        ok: false,
        text: '',
        reason: reason || `whisper.cpp завершился с кодом ${code}`,
      });
    });
    }
  });
}

/**
 * Быстрая оценка записи по сырому PCM (16 бит, моно). Нужна, чтобы не гонять
 * whisper на тишине: он в таком случае выдаёт «Спасибо за просмотр» или
 * «Продолжение следует». Возвращает громкость в тех же единицах, что и сэмплы.
 */
function analysePcm(raw, sampleRate = 16000) {
  const total = Math.floor(raw.length / 2);
  if (!total) return { samples: 0, seconds: 0, rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  let count = 0;
  // каждый четвёртый сэмпл — этого достаточно для оценки громкости
  const step = 4;
  for (let i = 0; i < total; i += step) {
    const v = raw.readInt16LE(i * 2);
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    sum += v * v;
    count += 1;
  }
  return {
    samples: total,
    seconds: total / sampleRate,
    rms: Math.round(Math.sqrt(sum / Math.max(1, count))),
    peak,
  };
}

/**
 * Обрезает тишину по краям записи, оставляя небольшой запас до и после речи.
 * Whisper хуже распознаёт, когда половина файла — пауза: на длинных хвостах он
 * «додумывает» фразы. Заодно меньше работы движку.
 */
function trimSilence(raw, sampleRate = 16000, { threshold = 200, leadMs = 150, tailMs = 250 } = {}) {
  const total = Math.floor(raw.length / 2);
  if (!total) return raw;
  let first = -1;
  let last = -1;
  for (let i = 0; i < total; i += 1) {
    if (Math.abs(raw.readInt16LE(i * 2)) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return raw; // речи нет — пусть решает analysePcm
  const lead = Math.round((sampleRate * leadMs) / 1000);
  const tail = Math.round((sampleRate * tailMs) / 1000);
  const from = Math.max(0, first - lead);
  const to = Math.min(total, last + tail);
  if (from === 0 && to === total) return raw;
  return raw.subarray(from * 2, to * 2);
}

// Что whisper любит «слышать» в тишине и на музыке. Убираем только целые
// фразы-галлюцинации: если человек правда сказал «спасибо за просмотр» вместе
// с остальным текстом — фраза не совпадёт целиком и останется.
const PHANTOM_PHRASES = [
  /^(продолжение следует|конец|спасибо за (просмотр|внимание)|подписывайтесь на канал|ставьте лайки|субтитры (сделал|сделаны|подготовил|редактор))[.\s!…]*$/i,
  /^(thank you for watching|thanks for watching|subscribe to (my|the) channel|like and subscribe|subtitles by)[.\s!…]*$/i,
];
function isPhantom(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 120) return false;
  return PHANTOM_PHRASES.some((re) => re.test(clean));
}

module.exports = {
  status,
  transcribe,
  findBinary,
  findModel,
  analysePcm,
  trimSilence,
  isPhantom,
  serverStatus,
  stopServer,
  warm,
  multipart,
  transcribeViaServer,
};
