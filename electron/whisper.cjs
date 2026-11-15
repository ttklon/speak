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

/**
 * Модель VAD (Silero, ggml) — «гейт» перед распознаванием. Живёт рядом с
 * моделями; весит меньше мегабайта. С ней whisper не тратит время на тишину
 * и паузы, а на пустом звуке не выдумывает фразы.
 */
const VAD_NAMES = ['ggml-silero-v6.2.0.bin', 'ggml-silero-v5.1.2.bin', 'for-tests-silero-v6.2.0-ggml.bin'];

function findVadModel() {
  const dirs = candidates(
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(app.getPath('userData'), 'models'),
    path.join(app.getAppPath(), 'models'),
  );
  for (const dir of dirs) {
    for (const name of VAD_NAMES) {
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
    // Имя может отличаться версией Silero: подходит любой *silero*.bin.
    try {
      const hit = fs
        .readdirSync(dir)
        .filter((f) => /silero/i.test(f) && /\.bin$/i.test(f))
        .sort()
        .pop();
      if (hit) return path.join(dir, hit);
    } catch {
      /* папки может не быть */
    }
  }
  return null;
}

/**
 * Аргументы whisper-cli. Вынесены отдельно, чтобы их можно было проверить
 * тестом: раньше набор флагов жил внутри transcribe() и нигде не проверялся.
 *
 * -mc 0 — не тянуть контекст предыдущего прохода: каждая диктовка независима,
 *         иначе whisper «додумывает» продолжение прошлой фразы;
 * -bs 1 — жадное декодирование: быстрее beam search, для диктовки разницы
 *         в тексте практически нет;
 * --vad — Silero отсекает тишину: 30 секунд записи с паузами не гоняют
 *         модель на пустом звуке.
 */
function cliArgs({
  modelPath,
  wavPath,
  lang = 'ru',
  threads = 4,
  prompt = '',
  vadModel = '',
  outBase = '',
  noContext = true,
  beamSize = 1,
} = {}) {
  const args = [
    '-m', String(modelPath || ''),
    '-f', String(wavPath || ''),
    '-l', String(lang || 'auto'),
    '-t', String(Math.max(1, Number(threads) || 4)),
    '--no-timestamps',
    '-nt',
    '-np',
    '-sns',
    '-otxt',
    '-of', String(outBase || `${wavPath}.out`),
  ];
  if (noContext) args.push('-mc', '0');
  if (Number(beamSize) > 0) args.push('-bs', String(Number(beamSize)));
  if (vadModel) {
    args.push(
      '--vad',
      '-vm', String(vadModel),
      // порог уверенности и минимальная тишина: пауза в полсекунды — уже граница
      '-vt', '0.5',
      '-vsd', '500',
      '-vp', '100',
    );
  }
  if (prompt) args.push('--prompt', String(prompt));
  return args;
}

function status(preferredModel = 'small') {
  const bin = findBinary();
  const model = findModel(preferredModel);
  const vadPath = findVadModel();
  return {
    available: Boolean(bin && model),
    bin,
    model,
    // чего именно не хватает — чтобы интерфейс мог объяснить это словами
    missing: !bin ? 'bin' : !model ? 'model' : '',
    reason: !bin ? 'whisper.cpp не найден' : !model ? 'модель ggml не найдена' : '',
    modelName: model ? path.basename(model) : '',
    // с VAD движок не тратит время на тишину: интерфейс может так и написать
    vad: vadPath || '',
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

/**
 * Запустить whisper-server и дождаться готовности. Возвращает state или null;
 * повторный вызов (без VAD-флагов) нужен, если сборка whisper.cpp не знает --vad.
 */
async function startServer(bin, args, { port, modelPath }) {
  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch {
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
  // 8 секунд: если сервер не поднялся, человек не должен ждать впустую —
  // уходим в обычный whisper-cli.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    const ping = await httpJson({ port, urlPath: '/', timeout: 1500 });
    if (ping.status) return state;
    await sleep(250);
  }
  if (serverState === state) stopServer();
  return null;
}

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
  const baseArgs = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-t', String(threads), '-nt', '-sns'];
  // Тот же VAD-гейт, что и в CLI: сервер не тратит время на тишину.
  const vadModel = findVadModel();
  const vadArgs = vadModel ? ['--vad', '-vm', vadModel, '-vt', '0.5', '-vsd', '500', '-vp', '100'] : [];
  const state = await startServer(bin, [...baseArgs, ...vadArgs], { port, modelPath });
  if (state) return state;
  // не поднялся: если виноват VAD-флаг (старая сборка), пробуем ещё раз без него
  if (vadArgs.length) {
    const retry = await startServer(bin, baseArgs, { port, modelPath });
    if (retry) return retry;
  }
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
 * Текущий проход распознавания. Нужен, чтобы:
 *  - отменить долгий проход по кнопке «Отменить»;
 *  - не держать два whisper-процесса одновременно: каждый ест сотни
 *    мегабайт под модель, и на слабой машине это выглядело как «зажрал
 *    оперативку и ничего не распознал».
 */
let activeRun = null;

function isBusy() {
  return Boolean(activeRun);
}

/**
 * Отменить активный проход. Возвращает true, если что-то действительно
 * прервали. Ожидающий промис transcribe() завершится с code:'cancelled'.
 */
function cancel(reason = 'распознавание отменено') {
  const run = activeRun;
  if (!run) return false;
  activeRun = null;
  run.cancelled = true;
  try {
    run.child?.kill();
  } catch {
    /* ignore */
  }
  try {
    run.req?.destroy();
  } catch {
    /* ignore */
  }
  try {
    run.finish({ ok: false, text: '', code: 'cancelled', reason });
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Транскрипция wav-файла (16 kHz mono PCM).
 * Возвращает { ok, text, segments }.
 */
function transcribe(wavPath, { lang = 'ru', model = 'small', prompt = '', timeout = 120000, keepLoaded = false, vad = '', useVad = true } = {}) {
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
        // Пустой ответ сервера — это тоже ответ: повторять тот же проход через
        // whisper-cli значило бы ждать вдвое дольше и грузить модель второй раз.
        if (fast) resolve({ ok: Boolean(fast.text), text: fast.text || '', mode: 'server', code: fast.text ? undefined : 'empty' });
        else runCli();
      });
      return;
    }
    runCli();

    function runCli() {

    // Набор флагов живёт в cliArgs(): его проверяют тесты, а не «на глаз».
    // -np: без служебного вывода, -sns: подавляем токены «не речь».
    const vadModel = useVad === false ? '' : vad || findVadModel() || '';
    const args = cliArgs({
      modelPath,
      wavPath,
      lang,
      threads,
      prompt,
      vadModel,
      outBase: `${wavPath}.out`,
    });

    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let settled = false;
    const run = { child, finish: null, cancelled: false };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRun === run) activeRun = null;
      resolve(value);
    };
    run.finish = finish;
    activeRun = run;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, text: '', code: 'timeout', reason: 'таймаут распознавания' });
    }, timeout);

    // Один повтор без VAD: флаг поддержан не всеми сборками whisper.cpp.
    function retryWithoutVad() {
      clearTimeout(timer);
      if (activeRun === run) activeRun = null;
      const again = cliArgs({ modelPath, wavPath, lang, threads, prompt, vadModel: '', outBase: `${wavPath}.out` });
      const child2 = spawn(bin, again, { windowsHide: true });
      let err2 = '';
      child2.stderr?.on('data', (d) => {
        err2 += d.toString();
        if (err2.length > 8000) err2 = err2.slice(-8000);
      });
      child2.on('error', (err) => finish({ ok: false, text: '', reason: err.message }));
      child2.on('close', (code2) => {
        try {
          const txt = `${wavPath}.out.txt`;
          if (fs.existsSync(txt)) {
            const text = fs.readFileSync(txt, 'utf8').trim();
            fs.unlinkSync(txt);
            if (text) {
              finish({ ok: true, text, code: code2 });
              return;
            }
          }
        } catch {
          /* файл мог не появиться */
        }
        finish({ ok: false, text: '', code: 'empty', reason: err2.slice(-400) || `код ${code2}` });
      });
    }

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
              !/^\s*(warning|using|processing|auto-detected)/i.test(line) &&
              // служебные строки whisper-cli: read_audio_data: …, miniaudio, …
              !/read_audio_data|miniaudio|trying to|failed to|audio data/i.test(line) &&
              // общий признак лога «идентификатор_с_подчёркиванием: текст»
              !/^[a-z0-9]*_[a-z0-9_]*\s*:/i.test(line),
          )
          .join(' ')
          .trim();
      const text = fromLog(stdout) || fromLog(stderr);
      if (text) {
        finish({ ok: true, text, code });
        return;
      }
      if (run.cancelled) {
        finish({ ok: false, text: '', code: 'cancelled', reason: 'распознавание отменено' });
        return;
      }
      const reason = (stderr || stdout).slice(-400).trim();
      // Старая сборка whisper.cpp не знает про --vad: не оставляем человека
      // без диктовки, повторяем проход без распознавания тишины.
      // Флаги VAD могут быть незнакомы старой сборке, а формат VAD-модели —
      // не совпасть с ней же. В обоих случаях повторяем проход без VAD.
      const vadTrouble =
        /unknown argument|invalid argument|unrecognized/i.test(reason) ||
        (/vad/i.test(reason) && /(fail|wrong shape|invalid|error)/i.test(reason));
      if (vadModel && !run.cancelled && vadTrouble) {
        retryWithoutVad();
        return;
      }
      finish({
        ok: false,
        text: '',
        code: 'empty',
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

/**
 * Режет запись на фрагменты по длинным паузам (простой VAD по громкости).
 *
 * Зачем: whisper обрабатывает файл целиком и на длинной диктовке хуже держит
 * конец и путает фразы через паузу в несколько секунд. Режем по паузам длиннее
 * `minPauseMs`, каждый фрагмент распознаём отдельно и склеиваем текстом.
 * Тишина внутри фразы (обычная пауза между словами) границей не считается.
 */
function splitBySilence(raw, sampleRate = 16000, { minPauseMs = 700, maxSeconds = 25, threshold = 200 } = {}) {
  const total = Math.floor(raw.length / 2);
  if (!total) return [raw];
  const frameMs = 20;
  const frame = Math.round((sampleRate * frameMs) / 1000);
  if (!frame) return [raw];
  const frames = Math.floor(total / frame);
  if (frames < 2) return [raw];

  const voiced = new Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let peak = 0;
    const start = f * frame;
    for (let i = start; i < start + frame; i += 1) {
      const abs = Math.abs(raw.readInt16LE(i * 2));
      if (abs > peak) peak = abs;
    }
    voiced[f] = peak > threshold;
  }

  const pauseFrames = Math.max(2, Math.round(minPauseMs / frameMs));
  const speech = [];
  let from = -1;
  let lastVoiced = -1;
  for (let f = 0; f < frames; f += 1) {
    if (voiced[f]) {
      if (from < 0) from = f;
      lastVoiced = f;
    } else if (from >= 0 && f - lastVoiced >= pauseFrames) {
      speech.push([from, lastVoiced]);
      from = -1;
      lastVoiced = -1;
    }
  }
  if (from >= 0) speech.push([from, lastVoiced]);
  if (!speech.length) return [raw];

  // запас по краям, чтобы не срезать начало и конец слова
  const leadFrames = Math.round(300 / frameMs);
  const tailFrames = Math.round(400 / frameMs);
  const maxFrames = Math.max(1, Math.round((maxSeconds * 1000) / frameMs));
  const parts = [];
  for (const [a, b] of speech) {
    let start = Math.max(0, a - leadFrames);
    const end = Math.min(frames, b + tailFrames);
    while (end - start > maxFrames) {
      parts.push([start, start + maxFrames]);
      start += maxFrames;
    }
    parts.push([start, end]);
  }
  if (parts.length < 2) return [raw];
  const out = [];
  for (const [a, b] of parts) {
    const slice = raw.subarray(a * frame * 2, Math.min(total, b * frame) * 2);
    if (slice.length >= frame * 2) out.push(slice);
  }
  return out.length ? out : [raw];
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
  cliArgs,
  findVadModel,
  cancel,
  isBusy,
  findBinary,
  findModel,
  analysePcm,
  trimSilence,
  splitBySilence,
  isPhantom,
  serverStatus,
  stopServer,
  warm,
  multipart,
  transcribeViaServer,
};
