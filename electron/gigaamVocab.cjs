/**
 * Словарь русской модели GigaAM v3.
 *
 * Файл словаря — по кусочку (пиису) на строку: сам кусочек, пробел, номер.
 * Символ `▁` отмечает начало слова — так SentencePiece несёт пробелы внутри
 * токенов. Пустой токен (`<blk>`) — разделитель в RNN-T, его номер нужен
 * декодеру, а в текст он не попадает.
 *
 * Зачем отдельным модулем: склейка токенов — это не `join('')`. Модель выдаёт
 * `▁Привет`, `▁как`, `▁дела`, `.` — и если склеить наивно, получится
 * «Привет как дела .» с пробелом перед точкой. Правила склейки проверяются
 * тестом, потому что именно они решают, будет ли текст читаемым.
 */

const WORD_START = '\u2581'; // ▁

/**
 * Разобрать файл словаря.
 * @param {string} text содержимое `v3_e2e_rnnt_vocab.txt`
 * @returns {{ pieces: Map<number, string>, blankId: number }}
 */
function parseVocabulary(text) {
  const pieces = new Map();
  const lines = String(text || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    // Кусочек не содержит пробелов, поэтому номер идёт после последнего.
    const separator = line.lastIndexOf(' ');
    if (separator <= 0) throw new Error('словарь модели повреждён: нет номера у кусочка');
    const id = Number(line.slice(separator + 1));
    if (!Number.isInteger(id) || id < 0) throw new Error('словарь модели повреждён: номер не число');
    if (pieces.has(id)) throw new Error('словарь модели повреждён: номер повторяется');
    pieces.set(id, line.slice(0, separator));
  }
  let blankId = -1;
  for (const [id, piece] of pieces) {
    if (piece === '<blk>') {
      blankId = id;
      break;
    }
  }
  if (blankId < 0) throw new Error('словарь модели повреждён: нет пустого токена');
  return { pieces, blankId };
}

/**
 * Разложить пробелы и убрать лишние.
 *
 * Правила: несколько пробелов — один; перед закрывающей пунктуацией пробела
 * нет; после открывающей — нет. Длинное тире и кавычки-ёлочки пробел
 * сохраняют: «Европа — континент», «„слово“» без склеек.
 */
function normalizeSpacing(text) {
  return String(text || '')
    .replace(/\s+/gu, ' ')
    .replace(/ +([.,!?:;…»)\]]+)/gu, '$1')
    .replace(/([«(["]) +/gu, '$1')
    .trim();
}

/**
 * Токены → читаемый текст.
 * @param {{ pieces: Map<number, string> }} vocab
 * @param {Iterable<number>} tokens номера токенов по порядку
 */
function tokensToText(vocab, tokens) {
  let joined = '';
  for (const token of tokens) {
    const piece = vocab.pieces.get(token);
    if (piece === undefined) continue;
    joined += piece;
  }
  return normalizeSpacing(joined.split(WORD_START).join(' '));
}

module.exports = { WORD_START, normalizeSpacing, parseVocabulary, tokensToText };
