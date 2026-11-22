/**
 * Локальные операции над текстом — «AI-инструкции» из видео.
 *
 * Работают офлайн и без LLM: правила, регулярки, словарь.
 * Если в Настройках включён локальный Ollama, ops.polish() попробует сходить
 * в http://localhost:11434 и вернуть ответ модели, иначе останется офлайн-режим.
 */

const FILLERS = [
  'как бы', 'типа', 'в общем', 'короче', 'ну', 'вот', 'эээ', 'эм', 'ммм',
  'значит', 'собственно', 'по сути', 'так сказать', 'в принципе', 'как-то так',
];

const FORMAL_MAP = [
  ['привет', 'Здравствуйте'],
  ['здравствуй', 'Здравствуйте'],
  ['спасибо', 'Благодарю'],
  ['спс', 'Благодарю'],
  ['пока', 'Всего доброго'],
  ['плиз', 'пожалуйста'],
  ['скинь', 'направьте'],
  ['скиньте', 'направьте'],
  ['дай', 'предоставьте'],
  ['хочу', 'хотел бы'],
  ['надо', 'необходимо'],
  ['мужики', 'коллеги'],
  ['ребята', 'коллеги'],
  ['окей', 'принято'],
  ['ок', 'принято'],
  ['чё', 'что'],
  ['щас', 'сейчас'],
  ['норм', 'удовлетворительно'],
];

/** Замена целого слова с учётом кириллицы (JS \b работает только с ASCII). */
function replaceWord(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  return text.replace(re, (m, pre, hit) => {
    const startsUpper = hit && hit[0] === hit[0].toUpperCase();
    return `${pre}${startsUpper ? to[0].toUpperCase() + to.slice(1) : to}`;
  });
}

const TERMS = {
  'api': 'программный интерфейс приложения (API)',
  'sdk': 'набор инструментов разработки (SDK)',
  'sql': 'язык запросов к базе данных (SQL)',
  'ui': 'интерфейс пользователя (UI)',
  'ux': 'опыт использования (UX)',
  'llm': 'большая языковая модель (LLM)',
  'stt': 'распознавание речи (STT)',
  'tts': 'синтез речи (TTS)',
  'vad': 'детектор речи (VAD)',
  'ci/cd': 'непрерывная сборка и доставка (CI/CD)',
  'deploy': 'выкладка на сервер (deploy)',
  'бэкенд': 'серверная часть (бэкенд)',
  'фронтенд': 'клиентская часть (фронтенд)',
  'репозиторий': 'хранилище кода (репозиторий)',
  'коммит': 'сохранённое изменение кода (коммит)',
  'мердж': 'объединение ветвей кода (мердж)',
};

function stripFillers(text) {
  let out = ` ${text} `;
  // Тянущиеся междометия, которые движок пишет по-разному: «э-э», «эээ», «а-а-а»,
  // «м-м». В списке слов их не перечислить — срезаем по шаблону.
  out = out.replace(/(^|\s)(?:э|а|м|ы)(?:[-–—]?(?:э|а|м|ы))+(?=[\s,.!?…])/giu, ' ');
  // Одиночное «э» перед запятой — тоже заминка, а не слово.
  out = out.replace(/(^|\s)э{1,2}(?=\s*[,.]|\s)/giu, ' ');
  for (const f of FILLERS) {
    const re = new RegExp(`(\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.!?])`, 'giu');
    out = out.replace(re, ' ');
  }
  // после удаления слов-паразитов остаются «, , ,» и висячие запятые
  out = out
    .replace(/[,;:]\s*(?=[,;:])/g, '')
    .replace(/([,;:])\s*([.!?])/g, '$2')
    .replace(/^\s*[,;:\s]+/, '')
    .replace(/\s{2,}/g, ' ');
  return out.trim();
}

/**
 * Слова, повтор которых — почти всегда заминка, а не смысл.
 *
 * «Я я думаю», «это это не так», «и и вот» — типичный артефакт распознавания:
 * человек запнулся, движок записал оба раза. При этом «очень очень», «да да»,
 * «ну ну» повторяют намеренно, поэтому список короткий и только служебные
 * слова: лучше оставить повтор, чем выбросить смысл.
 */
const STUTTER_WORDS = new Set([
  'я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они', 'и', 'а', 'но', 'в',
  'во', 'на', 'с', 'со', 'к', 'по', 'из', 'от', 'до', 'что',
  'это', 'этот', 'эта', 'эти', 'так', 'там', 'тут', 'вот', 'же', 'ли', 'бы',
  'у', 'о', 'об', 'за', 'под', 'над', 'при', 'про', 'без', 'через', 'если',
  'когда', 'как', 'потому', 'чтобы', 'есть', 'был', 'была', 'было', 'были',
  'будет', 'меня', 'мне', 'тебя', 'его', 'её', 'ее', 'нас', 'вас', 'их',
]);

/**
 * Убрать заикание: одинаковые служебные слова подряд без знаков между ними.
 * Границы слов проверяются по кириллице — `\b` в JS работает только с ASCII.
 */
export function dropStutter(text) {
  const source = String(text || '');
  if (!source) return source;
  const re = /[\p{L}]+/gu;
  const out = [];
  let lastKept = null;
  let lastEnd = -1;
  let copiedTo = 0;
  let m = re.exec(source);
  while (m) {
    const word = m[0];
    const low = word.toLowerCase();
    const gap = source.slice(lastEnd < 0 ? m.index : lastEnd, m.index);
    const sameAsPrev =
      lastKept !== null && low === lastKept && /^\s*$/u.test(gap) && STUTTER_WORDS.has(low);
    if (sameAsPrev) {
      // слово выбрасываем, но копирование продолжаем уже за ним
      copiedTo = m.index + word.length;
      lastEnd = copiedTo;
    } else {
      out.push(source.slice(copiedTo, m.index), word);
      copiedTo = m.index + word.length;
      lastKept = low;
      lastEnd = copiedTo;
    }
    m = re.exec(source);
  }
  out.push(source.slice(copiedTo));
  return out.join('');
}

function capitalizeSentences(text) {
  return text.replace(/(^|[.!?]\s+)([а-яёa-z])/gu, (m, pre, ch) => `${pre}${ch.toUpperCase()}`);
}

function ensurePeriod(text) {
  const t = text.trim();
  if (!t) return t;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function repeatSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const OPS = {
  /** Диктовка по умолчанию: убрать паразитов, расставить точки, заглавные. */
  clean(text) {
    if (!text) return '';
    let out = stripFillers(dropStutter(text));
    // типографика: дефис, окружённый пробелами, — это тире (whisper так и пишет
    // «я пришёл - увидел», а в тексте должно быть «—»)
    out = out.replace(/\s+-\s+/g, ' — ');
    out = out.replace(/\s+([,.;:!?])/g, '$1');
    out = out.replace(/([,.;:!?])(?=[^\s\d])/g, '$1 ');
    out = capitalizeSentences(out);
    return ensurePeriod(out.replace(/\s{2,}/g, ' ').trim());
  },

  formal(text) {
    let out = OPS.clean(text);
    for (const [from, to] of FORMAL_MAP) out = replaceWord(out, from, to);
    out = out.replace(/^Здравствуйте,?\s*/i, 'Здравствуйте!\n\n');
    return capitalizeSentences(out);
  },

  /** Сокращает на ~30%: убирает вводные и оставляет первые две трети слов. */
  /**
   * Сокращение: убираем «воду» и подрезаем длинные фразы по границам слов.
   * Раньше текст обрывался на полуслове («…потому что он содержит.»).
   */
  shorten(text) {
    const cleaned = OPS.clean(text);
    const WATER = '(?:в общем|как бы|на самом деле|по сути|в принципе|собственно|короче|типа|ну)';

    // 1) выкидываем вводные-паразиты вместе с их запятой, не ломая соседние фразы
    let out = cleaned.replace(
      new RegExp(`(^|[.!?…;:]\\s+)${WATER}\\s*,?\\s*`, 'gi'),
      '$1',
    );

    // 2) длинные предложения подрезаем по последнему целому слову
    out = out
      .split(/(?<=[.!?…])\s+/)
      .map((sentence) => {
        if (sentence.length <= 120) return sentence;
        const head = sentence.slice(0, 120);
        const cut = head.lastIndexOf(' ');
        return ensurePeriod((cut > 40 ? head.slice(0, cut) : head).replace(/[,;:]\s*$/, ''));
      })
      .join(' ');

    // 3) чистим следы правок: «, .» и висячие запятые в начале
    out = out
      .replace(/\s+([,.!?…;:])/g, '$1')
      .replace(/([,;:])\s*\./g, '.')
      // запятая сразу после точки — след удалённого вводного слова
      .replace(/([.!?…])\s*[,;]\s*/g, '$1 ')
      .replace(/^\s*[,;:]\s*/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // обрубок после удаления «воды» подклеиваем к предыдущей фразе запятой
    out = out.replace(/([.!?…])\s+([а-яёa-z]{1,14}\.)$/i, (m, end, tail) => `, ${tail}`);
    // после точки — заглавная: иначе «воды. надо.» читается как ошибка
    out = out.replace(/([.!?…]\s+)([а-яёa-z])/g, (m, p, ch) => p + ch.toUpperCase());
    out = out.replace(/^([а-яёa-z])/, (m) => m.toUpperCase());

    // 4) больше двух предложений — оставляем самые информативные (первые)
    const sentences = repeatSentences(out);
    if (sentences.length > 2) {
      return sentences.slice(0, Math.max(2, Math.round(sentences.length * 0.7))).join(' ');
    }
    return out;
  },

  /** Список ключевых тезисов: по предложениям, до 5 пунктов. */
  bullets(text, max = 5) {
    const sentences = repeatSentences(OPS.clean(text));
    if (!sentences.length) return '';
    return sentences
      .slice(0, max)
      .map((s) => `• ${s.replace(/^[-•]\s*/, '')}`)
      .join('\n');
  },

  /** Поисковый запрос: убирает вежливости, оставляет ключевые слова. */
  searchQuery(text) {
    const stop = new Set([
      'найди', 'поищи', 'пожалуйста', 'мне', 'нужно', 'хочу', 'можешь', 'ли',
      'в', 'на', 'и', 'с', 'по', 'для', 'что', 'как', 'это', 'the', 'please', 'find',
    ]);
    const words = stripFillers(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w && !stop.has(w));
    return words.slice(0, 8).join(' ');
  },

  /** Понижение терминов: подставляет пояснения к аббревиатурам. */
  lowerTerms(text) {
    let out = OPS.clean(text);
    for (const [term, plain] of Object.entries(TERMS)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, (m, pre) => `${pre}${plain}`);
    }
    return out;
  },

  /** Резюме встречи: тезисы + решения + задачи. */
  summary(text) {
    const bullets = repeatSentences(OPS.clean(text));
    if (!bullets.length) return '';
    const decisions = bullets.filter((s) => /реш|договор|итог|принял|утверд/i.test(s));
    const tasks = bullets.filter((s) => /нужно|сдела|подготов|отправ|провер|позвон|задач|до пятниц|завтра/i.test(s));
    const parts = [];
    parts.push('**Кратко**');
    parts.push(repeatSentences(OPS.shorten ? '' : text).length ? '' : '');
    parts.push(bullets.slice(0, 3).map((s) => `• ${s}`).join('\n'));
    if (decisions.length) {
      parts.push('\n**Решения**');
      parts.push(decisions.slice(0, 3).map((s) => `• ${s}`).join('\n'));
    }
    if (tasks.length) {
      parts.push('\n**Задачи**');
      parts.push(tasks.slice(0, 5).map((s) => `☐ ${s}`).join('\n'));
    }
    return parts.filter(Boolean).join('\n').trim();
  },

  /** Задачи из текста — для заметок встреч. */
  todos(text) {
    const sentences = repeatSentences(text);
    return sentences
      .filter((s) => /нужно|надо|сдела|подготов|отправ|провер|позвон|напомн|до\s|завтра|созвон/i.test(s))
      .slice(0, 8)
      .map((s) => ({ text: s.replace(/^[-•]\s*/, ''), done: false }));
  },
};

/**
 * Чистка обычной диктовки, не инструкции на переписывание. OPS.clean умеет
 * удалять «значит», повторы и другие потенциально значимые слова. Без аудио
 * нельзя надёжно определить, была ли это запинка, поэтому принимаем её итог
 * только если исходная строка сохранилась (кроме регистра, пробелов и новой
 * конечной точки). Иначе оставляем строку целиком. Явные AI-инструкции по
 * сокращению и прочим преобразованиям по-прежнему используют OPS напрямую.
 */
export function cleanLines(text) {
  const comparable = (line) => line.trim().replace(/[ \t]+/g, ' ').toLowerCase();
  const lines = String(text || '')
    .split('\n')
    .map((line) => {
      const source = line.trim();
      if (!source) return '';
      const candidate = OPS.clean(source);
      const before = comparable(source);
      const after = comparable(candidate);
      const canAppendPeriod = /[\p{L}\p{N})»\]]$/u.test(before) && !/[.!?…][)»\]]$/u.test(before);
      return after === before || (canAppendPeriod && after === `${before}.`) ? candidate : source;
    });
  return lines.join('\n').trim();
}

/**
 * «Модель не отвечает» запоминаем на минуту.
 *
 * Раньше каждая AI-инструкция при выключенном Ollama висела 6–7 секунд на
 * таймауте, и только потом срабатывали офлайн-правила. Теперь первый сбой
 * включает паузу: остальные инструкции сразу идут офлайн. Любой успешный
 * ответ (или кнопка «Проверить соединение» в «Настройки → Диктовка») паузу снимает.
 */
const LLM_BACKOFF_MS = 60 * 1000;
let llmDownUntil = 0;

export function llmIsDown() {
  return Date.now() < llmDownUntil;
}

export function resetLlmBackoff() {
  llmDownUntil = 0;
}

function markLlm(ok) {
  llmDownUntil = ok ? 0 : Date.now() + LLM_BACKOFF_MS;
}

/** Попытка локальной LLM (Ollama). Возвращает null, если недоступна. */
/**
 * Правдоподобен ли ответ модели для диктовки: она должна править, а не
 * пересказывать. Отсекаем «модель выкинула половину», «модель дописала от
 * себя» и «модель потеряла числа» — вместо такого ответа остаются офлайн-правила.
 */
export function saneRewrite(source, out) {
  const a = String(source || '').trim();
  let b = String(out || '').trim();
  if (!a || !b) return null;
  // модель любит обернуть ответ в кавычки или приписать «Вот исправленный текст:»
  b = b.replace(/^(вот\s+)?(исправленный|готовый|итоговый)\s+текст\s*:\s*/i, '');
  b = b.replace(/^["'«„]+|["'»“]+$/g, '').trim();
  if (!b) return null;
  if (b.length < a.length * 0.5) return null;
  if (b.length > a.length * 2.2) return null;
  // При диктовке неверно добавленное «не», изменённое имя, число или термин
  // опаснее пропущенной стилистической правки. Разрешаем только регистр и
  // пунктуацию: все слова и числа должны остаться в исходном порядке и числе.
  // Это ограничение, а не доказательство сохранения смысла: пунктуация тоже
  // может влиять на него. При сомнении возвращаем исходный текст.
  const tokens = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+|[%‰+−=<>×÷-]/gu) || []);
  const before = tokens(a);
  const after = tokens(b);
  if (before.length !== after.length || before.some((token, i) => token !== after[i])) return null;

  // Слова сами по себе не сохраняют смысл: «1,5» и «1.5», адреса,
  // математические знаки и уже сказанная пунктуация тоже имеют значение.
  // Сверяем знаки между одинаковыми словами на своих местах; новые обычные
  // знаки допускаем только там, где их не было, но не между двумя числами.
  const parts = (text) => {
    const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
    const gaps = [];
    let end = 0;
    for (const match of matches) {
      gaps.push(text.slice(end, match.index));
      end = match.index + match[0].length;
    }
    gaps.push(text.slice(end));
    return { words: matches.map((match) => match[0]), gaps };
  };
  const original = parts(a);
  const proposed = parts(b);
  if (original.words.length !== proposed.words.length) return null;
  for (let i = 0; i < original.gaps.length; i += 1) {
    const oldGap = original.gaps[i];
    const newGap = proposed.gaps[i];
    const oldMarks = oldGap.replace(/\s/gu, '');
    const newMarks = newGap.replace(/\s/gu, '');
    if (oldMarks && (oldMarks !== newMarks || (!/\s/u.test(oldGap) && /\s/u.test(newGap)))) return null;
    if (!oldMarks && newMarks && !/^[,.;:!?…]+$/u.test(newMarks)) return null;
    if (i > 0 && i < original.words.length && /^\d+$/u.test(original.words[i - 1]) && /^\d+$/u.test(original.words[i]) && oldMarks !== newMarks) return null;
  }
  return b;
}

/** Промпт для форматирования диктовки без изменения сказанных слов. */
export const DICTATION_PROMPT =
  'Ты редактор расшифровки речи. Расставь знаки препинания и заглавные буквы. ' +
  'Сохрани все слова, повторы, числа и имена в прежнем порядке; не добавляй ' +
  'ничего от себя, не пересказывай и не переводи. Ответь только исправленным ' +
  'текстом, без пояснений.';

/**
 * Вторая стадия чистки диктовки — локальная модель.
 *
 * Работает при включённой «Умной полировке» и заданном адресе Ollama.
 * Если модель меняет слова, числа или порядок, возвращается null и остаётся
 * результат офлайн-правил. Пунктуация всё ещё может влиять на смысл.
 */
export async function polishDictation(text, settings = {}, { timeout = 6000 } = {}) {
  if (!text || !settings.aiEndpoint) return null;
  if (settings.aiDictationRewrite !== true) return null;
  if (settings.aiProcessing === false) return null;
  const out = await llmRewrite({
    endpoint: settings.aiEndpoint,
    model: settings.aiModel,
    system: DICTATION_PROMPT,
    text,
    timeout,
  });
  return saneRewrite(text, out);
}

export async function llmRewrite({ endpoint, model, system, text, timeout = 6000, signal }) {
  if (!endpoint || !text || signal?.aborted) return null;
  // недавно уже не ответила — не тратим время человека
  if (llmIsDown()) return null;
  const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
  const body = {
    model: model || 'qwen2.5:0.5b',
    prompt: `${system || 'Улучши текст, сохрани смысл, ответь только результатом:'}\n\n${text}`,
    stream: false,
    options: { temperature: 0.2, num_predict: 512 },
  };

  // В окне Electron запрос делает главный процесс: CSP страницы пускает
  // только localhost:11434, а сервер пользователя может быть на другом порту.
  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  if (bridge?.httpPost) {
    try {
      const res = await bridge.httpPost({ url, body, timeout });
      if (signal?.aborted) return null;
      if (!res?.ok) {
        markLlm(false);
        return null;
      }
      const out = String(res.data?.response || '').trim();
      markLlm(Boolean(out));
      return out || null;
    } catch {
      if (!signal?.aborted) markLlm(false);
      return null;
    }
  }

  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  signal?.addEventListener('abort', abortExternal, { once: true });
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (signal?.aborted) return null;
    if (!res.ok) {
      markLlm(false);
      return null;
    }
    const data = await res.json();
    if (signal?.aborted) return null;
    const out = (data?.response || '').trim();
    markLlm(Boolean(out));
    return out || null;
  } catch {
    if (!signal?.aborted) markLlm(false);
    return null;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', abortExternal);
  }
}

export default OPS;
