/**
 * «Проверить диктовку» — самопроверка на этом компьютере.
 *
 * Зачем: человек нажимает кнопку и за пару секунд видит не обещание, а факт:
 * микрофон записал столько-то секунд, движок ответил за столько-то, вот текст.
 * Если что-то не так — причина словами («микрофон молчит», «движок не
 * установлен», «модель не скачана»), а не «ничего не произошло».
 *
 * Проверка ничего не вставляет в другие окна и не пишет в историю: это
 * диагностика, а не диктовка.
 */

import { startPcmRecording } from './audio/pcmRecorder.js';

/** Мост в главный процесс. Читаем каждый раз: тест подменяет window между вызовами. */
function native_pcm() {
  const native = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  return native?.transcribePcm || null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** RMS и пик по Int16 — те же пороги, по которым main решает «это тишина». */
export function analysePcm(pcm) {
  const samples = pcm?.length || 0;
  if (!samples) return { samples: 0, rms: 0, peak: 0, seconds: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = pcm[i];
    sum += v * v;
    const abs = v < 0 ? -v : v;
    if (abs > peak) peak = abs;
  }
  return { samples, rms: Math.round(Math.sqrt(sum / samples)), peak, seconds: samples / 16000 };
}

function describeMicError(err) {
  const name = String(err?.name || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Windows не дал доступ к микрофону — «Параметры → Конфиденциальность → Микрофон»';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'микрофон не найден — он отключён или выбран не тот';
  if (name === 'NotReadableError') return 'микрофон занят другой программой';
  return String(err?.message || err || 'неизвестная ошибка');
}

/** Сколько раз пробуем записать, если микрофон не отдал ни одного отсчёта. */
const RECORD_ATTEMPTS = 2;

/**
 * Сколько ждём, пока микрофон «проснётся».
 *
 * Открыть устройство и начать отдавать звук — не одно и то же: у Bluetooth-гарнитур
 * и у загруженной машины первые 1–2 секунды идут нули. Раньше отсчёт «две
 * секунды записи» начинался сразу после getUserMedia, в проверку попадала
 * тишина, и человек читал «микрофон молчит» при полностью живом микрофоне.
 */
const MIC_WAKE_TIMEOUT_MS = 3000;

/** Уровень, с которого считаем, что звук пошёл (0…1). */
const WAKE_LEVEL = 0.02;

/**
 * Один проход: записать и отдать движку.
 *
 * retry: true — запись вообще не началась (ноль отсчётов). Это не «тишина в
 * комнате», а «микрофон не успел открыться»: на загруженной машине открытие
 * занимает больше секунды, и первый раз мог не успеть. Повторяем — ровно один
 * раз, и только в этом случае.
 */
async function attemptSelfTest({ seconds, lang, model, onLevel, micOpenTimeoutMs }) {
  // Уровень нужен и интерфейсу (пульс), и нам: по нему видно, что микрофон
  // уже проснулся, — иначе две секунды записи уходят в тишину устройства.
  let seenLevel = 0;
  let levelEvents = 0;
  const trackLevel = (value) => {
    levelEvents += 1;
    const v = Number(value) || 0;
    if (v > seenLevel) seenLevel = v;
    onLevel?.(value);
  };

  let rec = null;
  try {
    rec = await startPcmRecording({ onLevel: trackLevel });
  } catch (err) {
    return { ok: false, reason: `микрофон не открылся: ${describeMicError(err)}` };
  }

  // Микрофон, который вообще не сообщает уровень, ждать бессмысленно.
  await wait(120);
  if (levelEvents > 0) {
    const awakeAt = Date.now();
    const wakeLimit = Math.max(0, Number(micOpenTimeoutMs) || MIC_WAKE_TIMEOUT_MS);
    while (seenLevel < WAKE_LEVEL && Date.now() - awakeAt < wakeLimit) {
      await wait(50);
    }
  }

  const startedAt = Date.now();
  await wait(Math.max(400, Number(seconds) * 1000));
  let stopped;
  try {
    stopped = rec.stop();
  } catch (err) {
    return { ok: false, reason: `запись сорвалась: ${String(err?.message || err)}` };
  }
  const recordMs = Date.now() - startedAt;
  const level = analysePcm(stopped?.pcm);
  if (!level.samples) {
    return {
      ok: false,
      retry: true,
      reason: 'микрофон не отдал ни одного отсчёта — запись не началась',
      recordMs,
      seconds: 0,
    };
  }
  if (level.peak < 250 || level.rms < 40) {
    return {
      ok: false,
      reason: 'микрофон молчит: уровень почти нулевой — проверьте устройство и ползунок записи в Windows',
      recordMs,
      seconds: Math.round(level.seconds * 10) / 10,
      rms: level.rms,
      peak: level.peak,
    };
  }

  const askAt = Date.now();
  let res;
  try {
    res = await native_pcm()({
      pcm: stopped.pcm,
      sampleRate: stopped.sampleRate || 16000,
      lang,
      model,
      partial: false,
      selfTest: true,
    });
  } catch (err) {
    return { ok: false, reason: `движок не ответил: ${String(err?.message || err)}`, recordMs };
  }
  const sttMs = Date.now() - askAt;
  const text = String(res?.text || '').trim();
  if (!res?.ok || !text) {
    return {
      ok: false,
      reason: res?.reason || 'движок не разобрал ни слова — попробуйте сказать фразу целиком',
      recordMs,
      sttMs,
      seconds: Math.round(level.seconds * 10) / 10,
    };
  }
  return {
    ok: true,
    text,
    recordMs,
    sttMs,
    seconds: Math.round(level.seconds * 10) / 10,
    rms: level.rms,
    peak: level.peak,
  };
}

/**
 * @param {{seconds?: number, lang?: string, model?: string, onLevel?: (v:number)=>void}} opts
 * @returns {Promise<{ok: boolean, reason?: string, text?: string, recordMs?: number,
 *   sttMs?: number, seconds?: number, rms?: number, peak?: number}>}
 */
export async function runDictationSelfTest({
  seconds = 2,
  lang = 'ru',
  model = '',
  onLevel,
  micOpenTimeoutMs = MIC_WAKE_TIMEOUT_MS,
} = {}) {
  if (!native_pcm()) {
    return { ok: false, reason: 'движок распознавания недоступен — проверка работает в приложении' };
  }
  let last = null;
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    last = await attemptSelfTest({ seconds, lang, model, onLevel, micOpenTimeoutMs });
    if (last.ok || !last.retry) break;
    last = { ...last, reason: 'микрофон не успел открыться — проверка повторилась и тоже не записала звук' };
    // микросхема микрофона уже открыта браузером: короткая пауза даёт ей
    // встать на ноги, второй попытки обычно достаточно
    if (attempt < RECORD_ATTEMPTS) await wait(400);
  }
  if (last && last.retry) {
    const { retry, ...rest } = last;
    return rest;
  }
  return last;
}

/** Одна строка итога — её показываем в «Диагностике». */
export function describeSelfTest(res) {
  if (!res) return '';
  if (!res.ok) return res.reason || 'проверка не удалась';
  return `Записано ${res.seconds} с, распознано за ${(res.sttMs / 1000).toFixed(1)} с: «${res.text}»`;
}

export default runDictationSelfTest;
