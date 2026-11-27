/** Настоящий Electron: синтетическое окно → UI записи → файл → декодированный кадр.
 * Запускается только в изолированном Windows CI и никогда не сохраняет кадры в лог. */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.ZS_SCREEN_E2E !== '1' || !process.env.ZS_SCREEN_VIDEO_DIR) {
  throw new Error('Проверка захвата разрешена только в изолированном Windows тесте');
}
const videoDir = process.env.ZS_SCREEN_VIDEO_DIR;
app.setPath('videos', videoDir);
require('./electron-entry.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await wait(150);
  }
  throw new Error(`Не дождались: ${label}`);
}
function fail(error) {
  console.error('SCREEN_E2E_FAILURE', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => fail(new Error('Таймаут проверки записи экрана')), 90000);
  timer.unref();
  let win;
  await until(async () => {
    win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    if (!win || win.webContents.isLoading()) return false;
    return win.webContents.executeJavaScript('Boolean(window.zspeakly?.native && document.querySelector(".app-window"))');
  }, 'интерфейс');
  const evaluate = (code) => win.webContents.executeJavaScript(code, true);
  await evaluate("location.hash = '#/clipboard'");
  await until(() => evaluate('Boolean(document.querySelector(\'.clip-hotkey[title^="Запись экрана"]\'))'), 'страница буфера');
  // Только диагностика: немедленно вызываем настоящий getDisplayMedia и
  // сохраняем имя/сообщение ошибки; поток и результат не подменяются.
  await evaluate(`(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.getDisplayMedia) return;
    const original = devices.getDisplayMedia.bind(devices);
    Object.defineProperty(devices, 'getDisplayMedia', { configurable: true, value: (...args) => {
      const attempt = { audioRequested: Boolean(args[0]?.audio), audioTracks: null };
      (window.__screenCaptureAttempts ||= []).push(attempt);
      try {
        return original(...args).then((stream) => {
          attempt.audioTracks = stream.getAudioTracks().length;
          return stream;
        }).catch((error) => {
          attempt.error = window.__screenCaptureError = { name: error?.name || '', message: String(error?.message || '').slice(0, 300) };
          throw error;
        });
      } catch (error) {
        attempt.error = window.__screenCaptureError = { name: error?.name || '', message: String(error?.message || '').slice(0, 300) };
        throw error;
      }
    } });
  })()`);
  win.show();
  win.focus();

  // Не запускаем захват, если невозможно однозначно закрыть единственный
  // экран синтетическим окном. Тест выполняется только на изолированном CI.
  if (screen.getAllDisplays().length !== 1) throw new Error('Для проверки нужен один изолированный экран');
  const bounds = screen.getPrimaryDisplay().bounds;
  const target = new BrowserWindow({ ...bounds, frame: false, show: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00ff00', webPreferences: { backgroundThrottling: false } });
  await target.loadURL('data:text/html,<html><body style="margin:0;background:%2300ff00"></body></html>');
  target.showInactive();
  target.setAlwaysOnTop(true, 'screen-saver');
  await wait(1500);

  const click = `(() => { const b = document.querySelector('.clip-hotkey[title^="Запись экрана"]'); if (!b) return false; b.click(); return true; })()`;
  if (!(await evaluate(click))) throw new Error('Не найдена кнопка записи');
  const readStatus = () => evaluate(`(() => {
    const error = [...document.querySelectorAll('.toast')].find(e => /Не удалось начать запись|Запись экрана недоступна/.test(e.innerText));
    return { running: Boolean([...document.querySelectorAll('.clip-hotkey__title')].find(e => /Остановить/.test(e.innerText))),
      failed: Boolean(error), description: error?.querySelector('.toast__desc')?.innerText?.slice(0, 300) || '',
      focus: document.hasFocus(), visibility: document.visibilityState, activation: navigator.userActivation?.isActive ?? null,
      captureError: window.__screenCaptureError || null, attempts: window.__screenCaptureAttempts || [],
      noAudioWarning: document.body.innerText.includes('Запись идёт без системного звука') };
  })()`);
  let status;
  await until(async () => { status = await readStatus(); return status.running || status.failed; }, 'первый запрос записи');
  let usedNoAudio = false;
  if (!status.running) {
    if (status.captureError?.name !== 'NotReadableError') throw new Error(`Настоящий getDisplayMedia не запустился: ${JSON.stringify({ ...status, windowFocused: win.isFocused(), windowVisible: win.isVisible() })}`);
    const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('.toast__action')].find(e => /Записать без звука/.test(e.innerText)); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) throw new Error('Ошибка источника не предложила явную запись без звука');
    usedNoAudio = true;
    await until(async () => {
      status = await readStatus();
      if (status.attempts[1]?.error) throw new Error(`Запись без звука не запустилась: ${JSON.stringify(status)}`);
      return status.running;
    }, 'старт записи без звука');
  }
  const lastAttempt = status.attempts.at(-1);
  if (!lastAttempt || lastAttempt.audioTracks === null || (usedNoAudio && (lastAttempt.audioRequested || lastAttempt.audioTracks !== 0)) || (lastAttempt.audioTracks === 0 && !status.noAudioWarning)) {
    throw new Error(`Неверное состояние звука: ${JSON.stringify(status)}`);
  }
  const audioMode = lastAttempt.audioTracks ? 'audio-track' : 'no-audio';
  await wait(4000);
  if (!(await evaluate(click))) throw new Error('Не найдена кнопка остановки');
  await until(async () => {
    const status = await evaluate(`({ saved: document.body.innerText.includes('Запись сохранена'), failed: /Не удалось сохранить запись|Запись не сохранена|Не удалось обработать запись|Не удалось остановить запись|Запись пустая|Запись могла прерваться|Запись остановлена по ограничению/.test(document.body.innerText) })`);
    if (status.failed) throw new Error('UI сообщил об отказе записи файла');
    return status.saved;
  }, 'сохранение записи', 45000);

  const names = fs.readdirSync(videoDir).filter((name) => name.endsWith('.webm'));
  if (names.length !== 1) throw new Error(`Ожидался один видеофайл, получено ${names.length}`);
  const file = path.join(videoDir, names[0]);
  const data = fs.readFileSync(file);
  if (data.length < 1024 || data.subarray(0, 4).toString('hex') !== '1a45dfa3') throw new Error('Файл не похож на непустой WebM');
  if (data.length > 16 * 1024 * 1024) throw new Error('Короткая тестовая запись неожиданно велика');

  // Проверяем байты файла, прочитанного с диска, через Blob того же origin:
  // file://-политика иначе может запретить canvas независимо от декодирования.
  const base64 = data.toString('base64');
  const video = await evaluate(`(async () => {
    const raw = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.src = url;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Таймаут декодирования WebM')), 15000));
    try {
      await Promise.race([new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('Ошибка декодирования WebM'));
      }), timeout]);
      await Promise.race([video.play(), timeout]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 64, 64);
      const pixels = ctx.getImageData(0, 0, 64, 64).data;
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 90 && pixels[i + 1] > 170 && pixels[i + 2] < 90) green++;
      return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, green };
    } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
  })()`);
  if (video.width < 32 || video.height < 32 || video.currentTime <= 0 || video.green < 400) {
    throw new Error(`Видео не воспроизвело синтетический экран: ${JSON.stringify(video)}`);
  }
  console.log(`SCREEN_E2E_OK mode=${audioMode} retry=${usedNoAudio} bytes=${data.length} frame=${video.width}x${video.height} green=${video.green} time=${video.currentTime.toFixed(2)}`);
  target.destroy();
  app.quit();
}).catch(fail);
