/**
 * «Как распозналось» — сырой текст движка рядом с готовым.
 *
 * Зачем: приложение меняет текст после распознавания (словарь, голосовые
 * команды, чистка, оформление под окно). Пока правки были невидимы, человек не
 * мог отличить ошибку движка от правки приложения — и не мог вернуть то, что
 * сказал. Храним сырой вариант только когда он действительно отличается, и
 * только в разумных пределах: история и так живёт в бюджете профиля.
 */

/** Длиннее этого сырой текст не храним: это уже не «фраза», а расшифровка. */
export const RAW_TEXT_LIMIT = 2000;

/**
 * @param {string} raw что вернул движок
 * @param {string} final что в итоге попало в текст
 * @returns {string|undefined} сырой текст для истории или ничего
 */
export function rawTextFor(raw, final) {
  const engineText = String(raw ?? '').trim();
  const finalText = String(final ?? '').trim();
  if (!engineText || !finalText) return undefined;
  if (engineText === finalText) return undefined;
  if (engineText.length > RAW_TEXT_LIMIT) return undefined;
  return engineText;
}

/** Есть ли что показывать в истории: поле заполнено и отличается от текста. */
export function hasRawText(item) {
  const raw = typeof item?.rawText === 'string' ? item.rawText.trim() : '';
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  return Boolean(raw) && raw !== text;
}

/**
 * Что именно изменилось: разница по словам, а не по символам.
 *
 * Зачем: «как распозналось» показывает исходный текст, но человек всё равно
 * глазами ищет, где приложение вмешалось. Подсветка отвечает на этот вопрос
 * сразу. Сравниваем по словам и без учёта регистра: «привет» → «Привет,» — это
 * не правка смысла, а знак и заглавная, и подсвечивать там нечего.
 */

const TOKEN_RE = /[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*|[^\s]/gu;

/** Слово в сравнимом виде: регистр, ё, без знаков. */
function tokenKey(token) {
  return token.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}

function tokenize(text) {
  return String(text || '').match(TOKEN_RE) || [];
}

/**
 * @param {string} raw что вернул движок
 * @param {string} final что вставили
 * @returns {Array<{text: string, changed: boolean}>} куски готового текста
 */
export function diffWords(raw, final) {
  const target = String(final ?? '');
  // Длинные тексты не диффим: подсветка там бесполезна, а цена — квадрат
  if (!target) return [];
  if (target.length > RAW_TEXT_LIMIT || String(raw ?? '').length > RAW_TEXT_LIMIT) {
    return [{ text: target, changed: false }];
  }
  const a = tokenize(raw).map(tokenKey).filter(Boolean);
  const bTokens = tokenize(target);
  const b = bTokens.map((t) => tokenKey(t) || t);
  if (!a.length) return [{ text: target, changed: false }];

  // LCS по словам: всё, что в готовом тексте не нашлось в исходном, — правка.
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changed = new Array(cols).fill(false);
  let i = 0;
  let j = 0;
  while (j < cols) {
    if (i < rows && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (i < rows && table[i + 1][j] >= table[i][j + 1]) {
      // слово исходника выброшено: подсвечивать нечего, оно не в готовом тексте
      i += 1;
    } else {
      changed[j] = true;
      j += 1;
    }
  }

  // Склеиваем куски и пробелы: подсветка не должна разрезать слово на буквы
  const out = [];
  let offset = 0;
  for (let k = 0; k < bTokens.length; k += 1) {
    const token = bTokens[k];
    const isSpace = !tokenKey(token);
    const at = target.indexOf(token, offset);
    const text = at > offset ? target.slice(offset, at) + token : token;
    offset = (at >= 0 ? at : offset) + token.length;
    const flag = isSpace ? false : changed[k];
    const last = out[out.length - 1];
    if (last && last.changed === flag) last.text += text;
    else out.push({ text, changed: flag });
  }
  if (offset < target.length) {
    const tail = target.slice(offset);
    const last = out[out.length - 1];
    if (last) last.text += tail;
    else out.push({ text: tail, changed: false });
  }
  return out;
}
