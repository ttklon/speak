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
  for (const f of FILLERS) {
    const re = new RegExp(`(\\s)${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,.!?])`, 'giu');
    out = out.replace(re, ' ');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
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
    let out = stripFillers(text);
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
  shorten(text) {
    const cleaned = OPS.clean(text);
    const sentences = repeatSentences(cleaned);
    if (sentences.length <= 1) {
      const words = cleaned.split(' ');
      if (words.length <= 8) return cleaned;
      const keep = Math.max(6, Math.round(words.length * 0.7));
      return ensurePeriod(`${words.slice(0, keep).join(' ')}`);
    }
    const keep = Math.max(1, Math.round(sentences.length * 0.7));
    return sentences.slice(0, keep).join(' ');
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

/** Попытка локальной LLM (Ollama). Возвращает null, если недоступна. */
export async function llmRewrite({ endpoint, model, system, text, timeout = 6000 }) {
  if (!endpoint || !text) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'qwen2.5:0.5b',
        prompt: `${system || 'Улучши текст, сохрани смысл, ответь только результатом:'}\n\n${text}`,
        stream: false,
        options: { temperature: 0.2, num_predict: 512 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = (data?.response || '').trim();
    return out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function runOp(opId, text, { settings, presetPrompt } = {}) {
  const offline = {
    clean: () => OPS.clean(text),
    formal: () => OPS.formal(text),
    shorten: () => OPS.shorten(text),
    bullets: () => OPS.bullets(text),
    search: () => OPS.searchQuery(text),
    terms: () => OPS.lowerTerms(text),
    summary: () => OPS.summary(text),
  };

  if (settings?.aiProcessing && settings?.aiEndpoint) {
    const promptMap = {
      formal: 'Перепиши текст в официально-деловом стиле. Ответь только текстом.',
      shorten: 'Сократи текст на 30%, сохранив смысл. Ответь только текстом.',
      summary: 'Сделай краткое резюме: тезисы, решения, задачи. Ответь только текстом.',
      terms: 'Замени сложные термины простыми пояснениями. Ответь только текстом.',
      search: 'Сформулируй короткий поисковый запрос из текста. Ответь только запросом.',
    };
    const prompt = presetPrompt || promptMap[opId];
    if (prompt) {
      const llm = await llmRewrite({
        endpoint: settings.aiEndpoint,
        model: settings.aiModel,
        system: prompt,
        text,
      });
      if (llm) return { text: OPS.clean(llm), engine: 'llm' };
    }
  }

  const fn = offline[opId] || offline.clean;
  return { text: fn(), engine: 'offline' };
}

export default OPS;
