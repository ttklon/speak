/**
 * Быстрые блоки: фраза-триггер разворачивается в готовый текст.
 *
 * Зачем: подпись, адрес, реквизиты, шаблон ответа, заготовка письма — всё это
 * люди диктуют заново каждый раз или копируют из блокнота. Сказал «моя
 * подпись» — вставилось. Это фишка Wispr Flow (snippets) и Dragon (Auto-Texts);
 * у нас её не было.
 *
 * Главное правило — предсказуемость. Блок срабатывает, только если человек
 * сказал ровно триггер и ничего больше: «моя подпись». Фраза «поставь мою
 * подпись в конце» останется текстом, потому что догадываться, где кончается
 * команда, а где начинается речь, — верный способ испортить диктовку.
 *
 * Сравнение нечувствительно к регистру, «ё» и знакам препинания: движок может
 * вернуть «Моя подпись.» — это тот же триггер.
 */

/** Пределы, чтобы один блок не превратился в хранилище документов. */
export const SNIPPET_LIMITS = {
  trigger: 60,
  body: 4000,
  count: 200,
};

/**
 * Привести фразу к виду для сравнения: регистр, «ё», знаки, лишние пробелы.
 * @param {string} text
 */
export function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Проверить и почистить список блоков (из хранилища или резервной копии).
 * @param {unknown} list
 */
export function sanitizeSnippets(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const trigger = String(raw.trigger ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, SNIPPET_LIMITS.trigger);
    const body = String(raw.body ?? '').slice(0, SNIPPET_LIMITS.body);
    const key = normalizePhrase(trigger);
    if (!key || !body.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(raw.id || `snip-${out.length + 1}`),
      trigger,
      body,
      createdAt: Number(raw.createdAt) || Date.now(),
    });
    if (out.length >= SNIPPET_LIMITS.count) break;
  }
  return out;
}

/**
 * Найти блок, который человек произнёс целиком.
 *
 * @param {string} text распознанный текст
 * @param {Array<{ trigger: string, body: string }>} snippets
 * @returns {{ snippet: object, text: string } | null}
 */
export function matchSnippet(text, snippets) {
  const phrase = normalizePhrase(text);
  if (!phrase) return null;
  for (const snippet of sanitizeSnippets(snippets)) {
    if (normalizePhrase(snippet.trigger) === phrase) {
      // Точка в конце сказанного не должна попасть в блок: это пунктуация
      // фразы, а не часть подписи.
      return { snippet, text: snippet.body };
    }
  }
  return null;
}

/**
 * Развернуть блок, если он прозвучал целиком, иначе вернуть текст как есть.
 * @param {string} text
 * @param {Array} snippets
 * @returns {{ text: string, snippet: object | null }}
 */
export function expandSnippet(text, snippets) {
  const hit = matchSnippet(text, snippets);
  if (!hit) return { text, snippet: null };
  return { text: hit.text, snippet: hit.snippet };
}

/**
 * Подсказка для интерфейса: какие триггеры есть, чтобы человек не гадал,
 * что именно произносить.
 * @param {Array} snippets
 * @param {number} [limit]
 */
export function snippetExamples(snippets, limit = 3) {
  return sanitizeSnippets(snippets)
    .slice(0, Math.max(0, limit))
    .map((snippet) => `«${snippet.trigger}»`);
}
