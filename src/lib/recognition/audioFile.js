/**
 * «Файл в текст»: правила для расшифровки готовой записи (не диктовки).
 *
 * Здесь нет ни микрофона, ни интерфейса — только арифметика и честные пределы.
 * Так это можно проверить тестами: окна нарезки, склейка кусков без повторов,
 * отказы с понятной причиной.
 *
 * Зачем вообще: диктовка и расшифровка файла — разные задачи. У MacWhisper,
 * Otter и Whisperstream это отдельная кнопка, и человек ждёт её и от нас:
 * записал встречу на телефон — получил текст.
 */

import { mergeOverlap } from './chunks.js';

/** Частота, с которой работает движок распознавания. */
export const SAMPLE_RATE = 16000;

/** Что принимает выбор файла. */
export const AUDIO_ACCEPT = '.wav,.mp3,.m4a,.aac,.ogg,.opus,.flac,.webm,audio/*';

/**
 * Пределы. Не для красоты: два часа — это ~460 МБ звука в памяти после
 * распаковки, дальше на слабом ноутбуке приложение начнёт свопиться и
 * «зависнет» вместо честного «файл слишком длинный».
 */
export const FILE_LIMITS = {
  bytes: 300 * 1024 * 1024,
  durationMs: 2 * 60 * 60 * 1000,
  // сколько символов текста принимаем от одного куска (защита от мусора)
  chunkChars: 20000,
};

/** Куски по 30 с: whisper на длинном куске теряет конец фразы и путает слова. */
export const FILE_WINDOW_MS = 30_000;
/** Перекрытие на стыке: слово, разрезанное границей, должно попасть целиком. */
export const FILE_OVERLAP_MS = 800;

const EXT = /\.([a-z0-9]+)$/iu;

/** Расширение файла без точки, в нижнем регистре: нужно для подписи и отказа. */
export function fileExt(name = '') {
  const match = EXT.exec(String(name || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** Имя файла без расширения — так его видно в истории. */
export function fileTitle(name = '', limit = 60) {
  const base = String(name || '').trim().replace(EXT, '').trim() || 'Запись';
  return base.length > limit ? `${base.slice(0, limit - 1)}…` : base;
}

/** Размер по-человечески: «12 МБ», «300 МБ». */
export function formatBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace('.', ',')} МБ`;
}

/** Длительность файла по-человечески: «1 ч 04 мин», «3 мин 20 с». */
export function formatDuration(ms = 0) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  if (m) return `${m} мин ${String(s).padStart(2, '0')} с`;
  return `${s} с`;
}

/**
 * Окна нарезки. Последнее окно не дублирует предыдущее: перекрытие нужно
 * только там, где есть стык, — иначе короткий файл превратился бы в два
 * прохода с одним и тем же звуком.
 */
export function planWindows(durationMs = 0, opts = {}) {
  const total = Math.max(0, Math.round(Number(durationMs) || 0));
  const windowMs = Math.max(1000, Number(opts.windowMs) || FILE_WINDOW_MS);
  const overlapMs = Math.max(0, Math.min(windowMs / 2, Number(opts.overlapMs ?? FILE_OVERLAP_MS) || 0));
  if (!total) return [];
  const windows = [];
  let start = 0;
  while (start < total) {
    const end = Math.min(total, start + windowMs);
    windows.push({ fromMs: start, toMs: end });
    if (end >= total) break;
    start = end - overlapMs;
  }
  // Хвост короче пятой части окна — это не отдельный проход, а его стоимость:
  // движок всё равно загружает модель на каждый вызов. Приклеиваем к прошлому.
  if (windows.length > 1) {
    const last = windows[windows.length - 1];
    if (last.toMs - last.fromMs < windowMs * 0.2) {
      windows.pop();
      windows[windows.length - 1].toMs = total;
    }
  }
  return windows;
}

/** Вырезать кусок звука по времени. Индексы за пределами — обрезаются. */
export function slicePcm(pcm, { fromMs = 0, toMs = 0, sampleRate = SAMPLE_RATE } = {}) {
  const rate = Number(sampleRate) || SAMPLE_RATE;
  const total = pcm?.length || 0;
  if (!total) return pcm?.subarray ? pcm.subarray(0, 0) : new Int16Array(0);
  const from = Math.max(0, Math.min(total, Math.round((Number(fromMs) || 0) * rate / 1000)));
  const to = Math.max(from, Math.min(total, Math.round((Number(toMs) || 0) * rate / 1000)));
  return pcm.subarray(from, to);
}

/** Склеить куски в один текст: стыки идут с перекрытием, повторы убираем. */
export function mergeFileText(parts = []) {
  let text = '';
  for (const raw of parts) {
    const part = String(raw || '').trim();
    if (!part) continue;
    text = text ? mergeOverlap(text, part) : part;
  }
  return text.trim();
}

/**
 * Годится ли файл. Возвращает {ok, reason, message}: reason — для тестов и
 * журнала, message — то, что увидит человек, и оно обязано называть выход.
 */
export function validateAudioFile({ name = '', size = 0, durationMs = 0, limits = FILE_LIMITS } = {}) {
  if (!name) {
    return { ok: false, reason: 'no-file', message: 'Файл не выбран.' };
  }
  if (Number(size) > limits.bytes) {
    return {
      ok: false,
      reason: 'too-big',
      message: `Файл больше ${formatBytes(limits.bytes)}. Разделите запись на части — так надёжнее, чем один огромный файл.`,
    };
  }
  if (Number(durationMs) > limits.durationMs) {
    return {
      ok: false,
      reason: 'too-long',
      message: `Запись длиннее ${formatDuration(limits.durationMs)}. Расшифруйте по частям — так приложение не съест всю память.`,
    };
  }
  return { ok: true, reason: '', message: '' };
}

/** Почему файл не превратился в текст — и что с этим делать. */
export const FILE_ERRORS = {
  'no-engine': {
    title: 'Файлы расшифровывает только приложение',
    message:
      'В этом окне движка распознавания нет. Откройте установленную ZSpeakly: там кнопка работает офлайн.',
  },
  decode: {
    title: 'Формат не читается',
    message:
      'Не удалось разобрать звук в этом файле. Подойдут WAV, MP3, M4A, OGG, FLAC и WEBM — конвертируйте в WAV, если формат редкий.',
  },
  empty: {
    title: 'В файле нет речи',
    message: 'Движок не нашёл в записи слов: возможно, там музыка, шум или очень тихий звук.',
  },
  failed: {
    title: 'Не получилось расшифровать файл',
    message: 'Попробуйте ещё раз. Если повторяется — проверьте модель в «Настройки → Диктовка».',
  },
};

/** Что показать в строке прогресса: «Фрагмент 2 из 9». */
export function progressLabel(done = 0, total = 0) {
  const all = Math.max(0, Number(total) || 0);
  if (!all) return '';
  const now = Math.min(all, Math.max(0, Number(done) || 0));
  return `Фрагмент ${now} из ${all}`;
}

export default {
  AUDIO_ACCEPT,
  FILE_LIMITS,
  SAMPLE_RATE,
  fileExt,
  fileTitle,
  formatBytes,
  formatDuration,
  planWindows,
  slicePcm,
  mergeFileText,
  validateAudioFile,
  FILE_ERRORS,
  progressLabel,
};
