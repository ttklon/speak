/**
 * Оговорки и поправки на лету.
 *
 * Человек диктует и поправляет себя: «встреча в четыре… то есть в три»,
 * «позвони Пете, ой, Васе», «в три, нет, в четыре часа». Движок распознавания
 * пишет это дословно, и в тексте остаются оба варианта — то, что человек
 * отменил, и то, что он имел в виду. Wispr Flow называет это авторедактурой и
 * ставит первым пунктом в рекламе; у нас до сих пор это надо было править
 * руками.
 *
 * Правило одно и осторожное: убираем только тогда, когда после поправки есть
 * чем заменить отменённое — то же слово, другое число или другое имя
 * собственное. Если замены не видно, текст остаётся как есть: «сократи, то есть
 * убери воду» — это не поправка, а уточнение, и выкидывать его нельзя.
 */

/** Слова-маркеры поправки. Порядок важен: длинные фразы проверяем раньше. */
const MARKERS = [
  'я имел в виду',
  'я имела в виду',
  'имею в виду',
  'точнее говоря',
  'вернее говоря',
  'а точнее',
  'а вернее',
  'то есть',
  'точнее',
  'вернее',
  'простите',
  'извините',
  'прошу прощения',
  'ой',
  'нет,',
];

/** Числа словами: «в три, нет, в четыре». */
const NUMBER_WORDS = new Set([
  'ноль', 'один', 'одна', 'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь',
  'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'пятнадцать',
  'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'сто', 'тысяча', 'миллион',
  'первый', 'первое', 'второй', 'второе', 'третий', 'третье', 'четвертый',
  'пятый', 'шестой', 'седьмой', 'восьмой', 'девятый', 'десятый',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'hundred', 'thousand',
]);

/** Дни недели и месяцы: «в среду, простите, в четверг» — та же роль во фразе. */
const CALENDAR_WORDS = new Set([
  'понедельник', 'вторник', 'среда', 'среду', 'среды', 'четверг', 'пятница',
  'пятницу', 'суббота', 'субботу', 'воскресенье', 'январь', 'января', 'февраль',
  'февраля', 'март', 'марта', 'апрель', 'апреля', 'май', 'мая', 'июнь', 'июня',
  'июль', 'июля', 'август', 'августа', 'сентябрь', 'сентября', 'октябрь',
  'октября', 'ноябрь', 'ноября', 'декабрь', 'декабря',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

const isNumberish = (word = '') => /^\d+([.,]\d+)?$/.test(word) || NUMBER_WORDS.has(word);
const isCalendar = (word = '') => CALENDAR_WORDS.has(word);

const isCapitalized = (word = '') => /^[A-ZА-ЯЁ]/.test(word);

/** Слово без знаков по краям: «четыре,» и «Четыре» — одно и то же слово. */
function keyOf(raw = '') {
  return String(raw)
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/ё/g, 'е');
}

/** Слова с их «сравнительным» ключом: регистр не важен, знаки по краям — тоже. */
function words(text = '') {
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, key: keyOf(raw) }))
    .filter((w) => w.key);
}

/** Знаки в конце слова: «часа.» → «.». */
function tailPunct(token = '') {
  const match = /[.,;:!?…]+$/.exec(String(token));
  return match ? match[0] : '';
}

/** Одно и то же слово, или однотипная замена (число вместо числа, имя вместо имени). */
function replaceable(a, b) {
  if (!a?.key || !b?.key) return false;
  if (a.key === b.key) return true;
  if (isNumberish(a.key) && isNumberish(b.key)) return true;
  if (isCalendar(a.key) && isCalendar(b.key)) return true;
  // Имя собственное: «Пете» и «Васе» — разные люди, но одна роль в фразе
  if (isCapitalized(a.raw) && isCapitalized(b.raw)) return true;
  return false;
}

/** Сколько слов перед поправкой можно считать отменёнными (не больше). */
const MAX_DROPPED_WORDS = 6;

/**
 * Сколько последних слов «левой» части заменяются началом «правой».
 * Возвращает 0…MAX_DROPPED_WORDS. Сравниваем именно хвост с началом: так
 * «встреча в 4, то есть в 3» теряет «в 4», а «сократи, то есть убери воду» —
 * ничего, потому что «сократи» и «убери» — разные глаголы без общей роли.
 */
export function correctionSpan(left = '', right = '') {
  const leftWords = words(left);
  const rightWords = words(right);
  if (!leftWords.length || !rightWords.length) return 0;
  const max = Math.min(MAX_DROPPED_WORDS, leftWords.length, rightWords.length);
  let best = 0;
  for (let length = 1; length <= max; length += 1) {
    const tail = leftWords.slice(-length);
    const head = rightWords.slice(0, length);
    // порядок важен: «в 4» ↔ «в 3» — пара по позициям
    const matches = tail.every((word, i) => replaceable(word, head[i]));
    // не break: короткое совпадение может не сложиться, а длинное сложиться
    // («четыре» ↔ «в» — нет, а «в четыре» ↔ «в три» — да)
    if (!matches) continue;
    // одного общего слова мало (это может быть предлог «в»): нужна либо
    // замена (в паре хоть одно слово разное), либо пара из двух и более слов
    const allSame = tail.every((word, i) => word.key === head[i].key);
    if (allSame && length < 2) continue;
    best = length;
  }
  return best;
}

/**
 * Убрать повтор: «в три в три часа» → «в три часа», «завтра завтра» → «завтра».
 * Повторяться может не только слово, но и пара слов — заминка бывает разной
 * длины, поэтому проверяем и её.
 */
export function dropStutter(text = '') {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return text;
  const out = [...tokens];
  for (let period = 1; period <= 3; period += 1) {
    for (let i = period; i < out.length; i += 1) {
      const before = out.slice(i - period, i).map(keyOf);
      const after = out.slice(i, i + period).map(keyOf);
      if (!before.length || before.length !== after.length) continue;
      if (before.some((k) => !k)) continue;
      if (before.join(' ') !== after.join(' ')) continue;
      // Знаки из отброшенной копии не теряем: точка в конце фразы остаётся.
      const punct = tailPunct(out[i + period - 1] || '');
      if (punct) out[i - 1] = `${out[i - 1].replace(/[.,;:!?…]+$/, '')}${punct}`;
      out.splice(i, period);
      i -= 1;
    }
  }
  return out.join(' ');
}

/** Найти маркер поправки: {index, length, marker} или null. */
function findMarker(text = '') {
  const lower = text.toLowerCase();
  let best = null;
  for (const marker of MARKERS) {
    const at = lower.indexOf(marker);
    if (at < 0) continue;
    // маркер должен быть отдельным словом, а не куском другого
    const before = at === 0 ? ' ' : lower[at - 1];
    const after = lower[at + marker.length] || ' ';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    if (!best || at < best.index) best = { index: at, length: marker.length, marker };
  }
  return best;
}

/** Начало фразы перед маркером: после последнего знака конца предложения. */
function clauseStart(text = '', beforeIndex = 0) {
  const head = text.slice(0, beforeIndex);
  // Многоточие границей фразы не считаем: «в 4… то есть в 3» — это заминка
  // внутри той же мысли, а не новое предложение.
  const at = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('; '),
  );
  return at >= 0 ? at + 2 : 0;
}

/**
 * Убрать отменённое. Возвращает {text, fixes}: fixes — сколько поправок
 * реально применено (это видно в диагностике).
 */
export function dropSelfCorrections(text = '') {
  let current = String(text || '');
  let fixes = 0;
  for (let guard = 0; guard < 5; guard += 1) {
    const marker = findMarker(current);
    if (!marker) break;
    const start = clauseStart(current, marker.index);
    const left = current.slice(start, marker.index);
    // Правая часть — до первой запятой или конца фразы: так в тексте с двумя
    // поправками вторая не попадает в «правую часть» первой и не теряется.
    // Запятые и тире сразу после маркера («ой, Васе») — часть маркера.
    const restRaw = current.slice(marker.index + marker.length);
    const skip = Math.max(0, restRaw.search(/[^\s,;:—–-]/u));
    const rest = restRaw.slice(skip);
    const endMatch = /[.!?…;,]/.exec(rest);
    const right = endMatch ? rest.slice(0, endMatch.index) : rest;
    if (!right.trim()) break;
    const span = correctionSpan(left, right);
    if (!span) {
      // Поправки не видно — значит это уточнение («сократи, то есть убери
      // воду»), и выкидывать его нельзя. Двигаемся дальше по тексту.
      const skip = current.slice(marker.index + marker.length);
      const nextMarkerAt = findMarker(skip);
      if (!nextMarkerAt) break;
      // продолжаем поиск со следующего маркера, не меняя текст
      const consumed = marker.index + marker.length + nextMarkerAt.index;
      const headPart = current.slice(0, consumed);
      const tailPart = current.slice(consumed);
      const nested = dropSelfCorrections(`${tailPart}`);
      if (nested.text === tailPart) break;
      current = `${headPart}${nested.text}`;
      fixes += nested.fixes;
      continue;
    }
    const leftWords = words(left);
    const dropCount = Math.min(span, leftWords.length);
    // обрезаем левую часть по словам, сохраняя то, что было до них
    const keep = leftWords.slice(0, leftWords.length - dropCount);
    const keepText = keep.length ? `${keep.map((w) => w.raw).join(' ')}` : '';
    const joinTail = keep.length ? ' ' : '';
    const rightText = right.trim();
    current = `${current.slice(0, start)}${keepText}${joinTail}${rightText}${current.slice(marker.index + marker.length + skip + right.length)}`
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:!?…])/g, '$1');
    fixes += 1;
  }
  // Повтор не обязательно запинка: «алло, алло», «очень очень» и повторённое
  // число могут быть сказаны намеренно. Без аудио удалить его безопасно нельзя.
  return { text: current.trim(), fixes };
}

export default dropSelfCorrections;
