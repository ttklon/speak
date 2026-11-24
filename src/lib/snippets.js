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
  const out = [];
  const reserved = new Set(list.filter((item) => item && typeof item === 'object' && item.id).map((item) => String(item.id)));
  const used = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const trigger = String(raw.trigger ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    const body = String(raw.body ?? '');
    const key = normalizePhrase(trigger);
    if (!key || !body.trim()) continue;
    let id = raw.id ? String(raw.id) : '';
    if (!id || used.has(id)) {
      let n = out.length + 1;
      do { id = `snip-recovered-${n++}`; } while (used.has(id) || reserved.has(id));
    }
    used.add(id);
    out.push({
      id,
      trigger,
      body,
      createdAt: Number(raw.createdAt) || Date.now(),
    });
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
  const matches = sanitizeSnippets(snippets).filter((snippet) => normalizePhrase(snippet.trigger) === phrase);
  // Унаследованные дубликаты остаются доступными для просмотра и удаления,
  // но неоднозначный триггер нельзя разворачивать произвольным образом.
  return matches.length === 1 ? { snippet: matches[0], text: matches[0].body } : null;
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
