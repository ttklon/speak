/**
 * «Файл в текст»: правила для расшифровки готовой записи (не диктовки).
 *
 * Здесь нет ни микрофона, ни интерфейса — только арифметика и честные пределы.
 * Так это можно проверить тестами: окна нарезки, осторожная склейка кусков,
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
 * Ограничения размера и длительности не ограничивают пиковую память кодека:
 * некоторые форматы сначала полностью декодируются. Есть также оценочный
 * предел рабочих буферов после декодирования; это не гарантия против OOM.
 */
export const FILE_LIMITS = {
  bytes: 300 * 1024 * 1024,
  durationMs: 2 * 60 * 60 * 1000,
  workingBytes: 768 * 1024 * 1024,
  // Длина ответа одного окна в UTF-16: выше — остановка и ручная проверка, не обрезка.
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

/** Склеить куски; повторы на перекрытиях могут остаться или быть удалены ошибочно. */
export function mergeFileText(parts = [], { preserve = false } = {}) {
  let text = '';
  for (const raw of parts) {
    const part = String(raw || '').trim();
    if (!part) continue;
    text = text ? mergeOverlap(text, part, { preserve }) : part;
  }
  return text.trim();
}

/** Сохраняем границы отказов в самом тексте: запись можно открыть позже,
 * скопировать или выгрузить без отдельных метаданных. Только соседние
 * успешные окна имеют право склеиваться по перекрытию. null — ошибка,
 * пустая строка — окно без текста. Тайминги приблизительны и перекрываются.
 */
export function assembleFileParts(parts = [], windows = [], transform = (text) => text, { preserve = false } = {}) {
  const sections = [];
  const speech = [];
  let group = '';
  const flush = () => {
    if (group) {
      const text = transform(group).trim();
      if (text) { sections.push(text); speech.push(text); }
      group = '';
    }
  };
  const time = (ms) => {
    const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  parts.forEach((part, i) => {
    if (part === null) {
      flush();
      const win = windows[i] || {};
      sections.push(`[Не удалось распознать фрагмент ${i + 1}: ${time(win.fromMs)}–${time(win.toMs)}]`);
    } else {
      const text = String(part || '').trim();
      if (!text) flush();
      else group = group ? mergeOverlap(group, text, { preserve }) : text;
    }
  });
  flush();
  return { text: sections.join('\n'), speechText: speech.join('\n') };
}

/** Проверка ответа одного окна после IPC. Большой текст не усекать и не
 * считать подтверждённым распознаванием; вызывающий предлагает его отдельно. */
export function classifyFileResponse(res) {
  if (res?.ok === true) {
    if (typeof res.text !== 'string') return { kind: 'failed' };
    if (res.text.length > FILE_LIMITS.chunkChars) return { kind: 'oversized', text: res.text };
    return { kind: 'text', text: res.text.trim() };
  }
  return res?.ok === false && res.code === 'silent' ? { kind: 'silent' } : { kind: 'failed' };
}

/** Только модели успешных окон из ответов main; отказанное окно ничего не доказывает. */
export function summarizeFileModels(results = []) {
  const seen = new Set();
  let other = false;
  let unknown = false;
  for (const result of results) {
    if (result?.ok !== true) continue;
    const name = typeof result.model === 'string' ? result.model.trim() : '';
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(name)) { unknown = true; continue; }
    if (seen.has(name)) continue;
    if (seen.size < 4) seen.add(name);
    else other = true;
  }
  if (!seen.size && !other) unknown = true;
  return { sttModel: [...seen, ...(other ? ['другие'] : []), ...(unknown ? ['неизвестно'] : [])].join(', '), sttModelSource: 'file-responses-v1' };
}

/** Старые файлы сохраняли выбранную Whisper, а не фактически использованную модель. */
export function fileModelLabel(item = {}) {
  const model = typeof item.sttModel === 'string' ? item.sttModel : '';
  if (item.source !== 'file') return model.replace(/^ggml-/, '').replace(/\.bin$/, '');
  if (item.sttModelSource === 'file-responses-v1') return `Модели успешных фрагментов: ${model || 'неизвестно'}`;
  return model ? `Выбранная модель: ${model}; фактическая неизвестна` : 'Фактическая модель неизвестна';
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
      message: `Запись длиннее ${formatDuration(limits.durationMs)}. Разделите её и расшифруйте по частям.`,
    };
  }
  return { ok: true, reason: '', message: '' };
}

/** Почему файл не превратился в текст — и что с этим делать. */
export const FILE_ERRORS = {
  'no-engine': {
    title: 'Файлы расшифровывает только приложение',
    description:
      'В этом окне движка распознавания нет. Откройте установленную ZSpeakly: там кнопка работает офлайн.',
  },
  decode: {
    title: 'Формат не читается',
    description:
      'Не удалось разобрать звук в этом файле. Подойдут WAV, MP3, M4A, OGG, FLAC и WEBM — конвертируйте в WAV, если формат редкий.',
  },
  'too-much-memory': {
    title: 'Запись требует слишком много памяти',
    description: 'Разделите файл на короткие части и расшифруйте их по очереди. Оценка не учитывает всю память декодера и модели.',
  },
  empty: {
    title: 'В файле нет речи',
    description: 'Движок не нашёл в записи слов: возможно, там музыка, шум или очень тихий звук.',
  },
  failed: {
    title: 'Не получилось расшифровать файл',
    description: 'Попробуйте ещё раз. Если повторяется — проверьте модель в «Настройки → Диктовка».',
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
  assembleFileParts,
  validateAudioFile,
  FILE_ERRORS,
  progressLabel,
};
