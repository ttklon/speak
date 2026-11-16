/**
 * Голосовая пунктуация и команды форматирования.
 *
 * Зачем: человек диктует так, как говорит, — «привет запятая как дела точка
 * с новой строки надо встретиться». Раньше всё это попадало в текст словами:
 * приходилось останавливаться, лезть в клавиатуру и править руками, то есть
 * диктовка экономила время только до первого знака препинания.
 *
 * Теперь распознанная фраза проходит через разбор команд:
 *  - знаки: «запятая», «точка», «двоеточие», «точка с запятой», «тире»,
 *    «многоточие», «вопросительный знак», «восклицательный знак»;
 *  - кавычки и скобки: «открыть кавычки» … «закрыть кавычки»;
 *  - структура: «с новой строки», «новый абзац»;
 *  - правка: «удалить последнее слово», «удалить последнее предложение»,
 *    «с большой буквы».
 *
 * Осторожность важнее полноты: «точка» — обычное слово («точка зрения»,
 * «точка входа», «до этой точки»), поэтому одиночная «точка» превращается в
 * знак только там, где рядом нет слов, с которыми она образует оборот.
 * Лучше оставить слово словом, чем испортить текст.
 *
 * Команды понимаются всегда и не настраиваются: это часть диктовки, а не
 * тумблер. Английские команды включаются только для английской диктовки,
 * чтобы «period» в русском тексте остался словом.
 */

/** Слова и одиночные символы: пробелы не токены, их расставляет сборка. */
const TOKEN_RE = /[\p{L}\p{N}]+(?:[’'‑-][\p{L}\p{N}]+)*|[^\s]/gu;

/** Пунктуация, которая «прилипает» к предыдущему слову. */
const TAIL_PUNCT = new Set([',', '.', ';', ':', '!', '?', '…', '—', '–', '-', '%', '»', ')', ']']);
/** Открывающие символы: пробел перед, но не после. */
const OPEN_PUNCT = new Set(['«', '(', '[']);

/** Мусорная пунктуация рядом с командой: «запятая,» — это всё ещё запятая. */
const DUMB_PUNCT = /^[,.;:!?…—–-]$/;

// «Точка» — слово. Эти слова рядом означают, что человек говорит про точку,
// а не диктует знак препинания.
const DOT_BLOCK_AFTER = new Set([
  'зрения', 'входа', 'отсчёта', 'отсчета', 'роста', 'опоры', 'кипения',
  'невозврата', 'назначения', 'продажи', 'обмена', 'доступа', 'обзора',
  'контакта', 'сборки', 'пересечения', 'прицела', 'росы', 'в', 'на', 'до',
  'из', 'от', 'по', 'к', 'над', 'под', 'между', 'и', 'или',
]);
const DOT_BLOCK_BEFORE = new Set([
  'в', 'во', 'на', 'до', 'из', 'от', 'по', 'к', 'над', 'под', 'эту', 'этой',
  'эта', 'это', 'этот', 'той', 'ту', 'каждой', 'каждую', 'любой', 'любую',
  'своей', 'свою', 'одной', 'одну', 'последней', 'последнюю', 'крайней',
  'верхней', 'нижней', 'белой', 'мёртвой', 'мертвой', 'такой', 'такая',
]);

/**
 * Команды в порядке приоритета: длинные фразы проверяются раньше коротких,
 * иначе «точка с запятой» распалась бы на «точку» и мусор.
 */
const RU_COMMANDS = [
  { words: ['с', 'новой', 'строки'], act: { kind: 'break', value: '\n' } },
  { words: ['с', 'новой', 'строчки'], act: { kind: 'break', value: '\n' } },
  { words: ['с', 'нового', 'абзаца'], act: { kind: 'break', value: '\n\n' } },
  { words: ['новый', 'абзац'], act: { kind: 'break', value: '\n\n' } },
  { words: ['новым', 'абзацем'], act: { kind: 'break', value: '\n\n' } },
  { words: ['новая', 'строка'], act: { kind: 'break', value: '\n' } },
  { words: ['новую', 'строку'], act: { kind: 'break', value: '\n' } },
  { words: ['перевод', 'строки'], act: { kind: 'break', value: '\n' } },
  { words: ['точка', 'с', 'запятой'], act: { kind: 'tail', value: ';' } },
  { words: ['вопросительный', 'знак'], act: { kind: 'tail', value: '?' } },
  { words: ['восклицательный', 'знак'], act: { kind: 'tail', value: '!' } },
  { words: ['открыть', 'кавычки'], act: { kind: 'open', value: '«' } },
  { words: ['открыть', 'кавычку'], act: { kind: 'open', value: '«' } },
  { words: ['открывающая', 'кавычка'], act: { kind: 'open', value: '«' } },
  { words: ['закрыть', 'кавычки'], act: { kind: 'close', value: '»' } },
  { words: ['закрыть', 'кавычку'], act: { kind: 'close', value: '»' } },
  { words: ['закрывающая', 'кавычка'], act: { kind: 'close', value: '»' } },
  { words: ['открыть', 'скобку'], act: { kind: 'open', value: '(' } },
  { words: ['открывающая', 'скобка'], act: { kind: 'open', value: '(' } },
  { words: ['закрыть', 'скобку'], act: { kind: 'close', value: ')' } },
  { words: ['закрывающая', 'скобка'], act: { kind: 'close', value: ')' } },
  { words: ['с', 'большой', 'буквы'], act: { kind: 'capitalizeNext' } },
  { words: ['с', 'заглавной', 'буквы'], act: { kind: 'capitalizeNext' } },
  { words: ['заглавная', 'буква'], act: { kind: 'capitalizeNext' } },
  { words: ['многоточие'], act: { kind: 'tail', value: '…' } },
  { words: ['двоеточие'], act: { kind: 'tail', value: ':' } },
  { words: ['тире'], act: { kind: 'tail', value: '—' } },
  { words: ['дефис'], act: { kind: 'tail', value: '-' } },
  { words: ['запятая'], act: { kind: 'tail', value: ',' } },
  { words: ['точка'], act: { kind: 'tail', value: '.', guard: 'dot' } },
];

/** «удалить последнее слово» и родственные формы. */
const DELETE_VERBS = ['удалить', 'удали', 'убери', 'убрать', 'стереть', 'сотри'];
const DELETE_NOUNS = {
  слово: 'deleteWord',
  слова: 'deleteWord',
  фразу: 'deleteWord',
  фраза: 'deleteWord',
  предложение: 'deleteSentence',
  строчку: 'deleteSentence',
  строку: 'deleteSentence',
};
for (const verb of DELETE_VERBS) {
  for (const [noun, kind] of Object.entries(DELETE_NOUNS)) {
    RU_COMMANDS.push({ words: [verb, 'последнее', noun], act: { kind } });
    RU_COMMANDS.push({ words: [verb, 'последний', noun], act: { kind } });
    RU_COMMANDS.push({ words: [verb, 'последнюю', noun], act: { kind } });
  }
}

const EN_COMMANDS = [
  { words: ['new', 'paragraph'], act: { kind: 'break', value: '\n\n' } },
  { words: ['new', 'line'], act: { kind: 'break', value: '\n' } },
  { words: ['next', 'line'], act: { kind: 'break', value: '\n' } },
  { words: ['question', 'mark'], act: { kind: 'tail', value: '?' } },
  { words: ['exclamation', 'mark'], act: { kind: 'tail', value: '!' } },
  { words: ['exclamation', 'point'], act: { kind: 'tail', value: '!' } },
  { words: ['open', 'quote'], act: { kind: 'open', value: '«' } },
  { words: ['close', 'quote'], act: { kind: 'close', value: '»' } },
  { words: ['open', 'bracket'], act: { kind: 'open', value: '(' } },
  { words: ['close', 'bracket'], act: { kind: 'close', value: ')' } },
  { words: ['semicolon'], act: { kind: 'tail', value: ';' } },
  { words: ['comma'], act: { kind: 'tail', value: ',' } },
  { words: ['period'], act: { kind: 'tail', value: '.' } },
  { words: ['colon'], act: { kind: 'tail', value: ':' } },
  { words: ['delete', 'last', 'word'], act: { kind: 'deleteWord' } },
  { words: ['delete', 'last', 'sentence'], act: { kind: 'deleteSentence' } },
];

/** Команды для языка диктовки: русские — всегда, английские — для английской. */
export function commandsFor(language = 'ru') {
  const lang = String(language || 'ru').toLowerCase();
  const base = RU_COMMANDS.map((c) => ({ ...c, words: [...c.words] }));
  if (lang.startsWith('en')) base.push(...EN_COMMANDS);
  // длинные фразы — первыми: «точка с запятой» раньше «точки»
  return base.sort((a, b) => b.words.length - a.words.length);
}

function tokenize(text) {
  const tokens = [];
  const re = new RegExp(TOKEN_RE.source, 'gu');
  let m = re.exec(text);
  while (m) {
    const raw = m[0];
    tokens.push({ raw, low: raw.toLowerCase(), word: /^[\p{L}\p{N}]/u.test(raw) });
    m = re.exec(text);
  }
  return tokens;
}

/** Ближайшее слово до/после позиции (знаки и пробелы пропускаем). */
function neighborWord(tokens, from, step) {
  for (let i = from; i >= 0 && i < tokens.length; i += step) {
    if (tokens[i].word) return tokens[i].low;
  }
  return '';
}

/** Прилагательное перед «точкой» означает, что говорят про точку, а не диктуют знак. */
const ADJECTIVE_END = /(ая|яя|ой|ей|ые|ых|ую|юю|ым|им|ого|его)$/u;

/** Можно ли считать «точку» знаком препинания в этом месте. */
function dotAllowed(tokens, start, end) {
  const prev = neighborWord(tokens, start - 1, -1);
  const next = neighborWord(tokens, end, 1);
  if (!next) return true; // «…и всё, точка» — в конце фразы это знак
  if (DOT_BLOCK_AFTER.has(next)) return false;
  if (DOT_BLOCK_BEFORE.has(prev)) return false;
  // «финальная точка», «болевая точка», «ключевой точкой» — это существительное
  if (prev.length > 3 && ADJECTIVE_END.test(prev)) return false;
  return true;
}

function pushTail(parts, value) {
  // «Привет, запятая, как дела»: старая запятая и новая — одна и та же
  while (parts.length && (parts[parts.length - 1].kind === 'tail' || parts[parts.length - 1].kind === 'close')) {
    // закрывающую кавычку/скобку не выбрасываем: она часть текста
    if (parts[parts.length - 1].kind === 'close') break;
    parts.pop();
  }
  parts.push({ kind: value === '»' || value === ')' || value === ']' ? 'close' : 'tail', text: value });
}

/** Слова, которые после удаления остаются висеть в конце: «купить хлеб и». */
const TRAILING_GLUE = new Set([
  'и', 'а', 'но', 'или', 'в', 'во', 'на', 'с', 'со', 'к', 'по', 'из', 'от',
  'до', 'для', 'что', 'же', 'ли', 'не', 'ни', 'у', 'о', 'об', 'за', 'под',
  'над', 'при', 'про', 'без', 'через', 'это', 'этот', 'эта', 'эти',
]);

function deleteLastWord(parts) {
  let i = parts.length - 1;
  while (i >= 0 && parts[i].kind !== 'word') i -= 1;
  if (i < 0) return;
  parts.splice(i, 1);
  // предлог или союз, оставшийся последним, — тоже мусор: «купить хлеб и»
  let j = parts.length - 1;
  while (j >= 0 && parts[j].kind !== 'word') j -= 1;
  if (j >= 0 && TRAILING_GLUE.has(parts[j].text.toLowerCase())) parts.splice(j, 1);
  // хвостовая пунктуация после удалённого слова тоже лишняя
  while (parts.length > i && parts[parts.length - 1].kind !== 'word') {
    const last = parts[parts.length - 1];
    if (last.kind === 'open') break;
    parts.pop();
  }
}

function deleteLastSentence(parts) {
  // убираем всё до ближайшего конца предложения включительно
  while (parts.length) {
    const last = parts.pop();
    if (last.kind === 'tail' && /[.!?…]/.test(last.text)) return;
  }
}

/** Сборка текста из частей: пробелы, кавычки и переносы — по правилам. */
function render(parts) {
  let s = '';
  for (const p of parts) {
    if (p.kind === 'break') {
      s = s.replace(/[ \t]+$/, '');
      // один перенос и абзац не должны схлопываться в один и тот же
      const tail = p.value === '\n\n' ? '\n\n' : '\n';
      if (!s.endsWith(tail)) s += p.value;
      continue;
    }
    if (p.kind === 'tail' || p.kind === 'close') {
      s = s.replace(/[ \t]+$/, '');
      s += p.text;
      continue;
    }
    if (p.kind === 'open') {
      s = s.replace(/[ \t]+$/, '');
      if (s && !s.endsWith('\n')) s += ' ';
      s += p.text;
      continue;
    }
    // слово
    // после дефиса пробел не нужен: «сине-зелёный»; после точки в числе — тоже:
    // «3.5» не должно стать «3. 5»
    const decimal = /\d[.,]$/.test(s) && /^\d/.test(p.text);
    if (s && !decimal && !s.endsWith(' ') && !s.endsWith('\n') && !s.endsWith('-') && !OPEN_PUNCT.has(s.slice(-1))) {
      s += ' ';
    }
    s += p.text;
  }
  return s;
}

function finishLine(line) {
  let l = line.replace(/[ \t]+/g, ' ').trim();
  if (!l) return '';
  l = l.replace(/^[,;:.!?…—–-]+/, '');
  l = l.replace(/\s+([,.;:!?…])/g, '$1');
  l = l.replace(/([,.;:!?…])(?=[^\s\d])/gu, '$1 ');
  l = l.replace(/\s*—\s*/g, ' — ');
  l = l.replace(/[ \t]{2,}/g, ' ').trim();
  // висячий знак в конце (сказали «запятая» и замолчали) — точнее точка
  l = l.replace(/[,;:—–-]+$/, (m) => (m.includes('—') || /-/.test(m) ? '' : '.'));
  l = l.replace(/\.{2,}$/, '.');
  // точка нужна и после закрывающей скобки/кавычки: «Смотри (важно).»
  if (/[\p{L}\p{N})»\]]$/u.test(l) && !/[.!?…][)»\]]$/.test(l)) l += '.';
  // заглавная в начале и после точки: «привет. как дела» → «Привет. Как дела»
  l = l.replace(/(^|[.!?…]\s+|«)([а-яёa-z])/gu, (m, pre, ch) => `${pre}${ch.toUpperCase()}`);
  return l;
}

/**
 * Применить голосовые команды к распознанному тексту.
 *
 * @param {string} text — что вернул движок
 * @param {{language?: string}} [opts]
 * @returns {string} текст со знаками, переносами и выполненными правками
 */
export function applyVoiceCommands(text, { language = 'ru' } = {}) {
  const source = String(text || '');
  if (!source.trim()) return '';
  const commands = commandsFor(language);
  const tokens = tokenize(source);
  const parts = [];
  let capitalizeNext = false;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    let matched = null;
    if (token.word) {
      for (const cmd of commands) {
        if (i + cmd.words.length > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < cmd.words.length; k += 1) {
          const t = tokens[i + k];
          if (!t?.word || t.low !== cmd.words[k]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (cmd.act.guard === 'dot' && !dotAllowed(tokens, i, i + cmd.words.length)) continue;
        // «это не запятая, а точка» — человек говорит о знаках, а не диктует их
        if (cmd.act.kind === 'tail' && cmd.words.length === 1) {
          if (neighborWord(tokens, i - 1, -1) === 'не') continue;
        }
        matched = cmd;
        break;
      }
    }

    if (matched) {
      const end = i + matched.words.length;
      const act = matched.act;
      if (act.kind === 'tail') pushTail(parts, act.value);
      else if (act.kind === 'open') parts.push({ kind: 'open', text: act.value });
      else if (act.kind === 'close') parts.push({ kind: 'close', text: act.value });
      else if (act.kind === 'break') parts.push({ kind: 'break', value: act.value });
      else if (act.kind === 'deleteWord') deleteLastWord(parts);
      else if (act.kind === 'deleteSentence') deleteLastSentence(parts);
      else if (act.kind === 'capitalizeNext') {
        // человек говорит «иван с большой буквы» уже после слова — поднимаем
        // предыдущее слово; если его нет, то следующее
        let w = parts.length - 1;
        while (w >= 0 && parts[w].kind !== 'word') w -= 1;
        if (w >= 0) {
          const t = parts[w].text;
          parts[w] = { kind: 'word', text: t[0].toUpperCase() + t.slice(1) };
        } else {
          capitalizeNext = true;
        }
      }
      // мусорная пунктуация сразу после команды («запятая,») — не текст
      i = end;
      while (i < tokens.length && !tokens[i].word && DUMB_PUNCT.test(tokens[i].raw)) i += 1;
      continue;
    }

    if (token.word) {
      const text_ = capitalizeNext ? token.raw[0].toUpperCase() + token.raw.slice(1) : token.raw;
      capitalizeNext = false;
      parts.push({ kind: 'word', text: text_ });
    } else if (OPEN_PUNCT.has(token.raw)) {
      parts.push({ kind: 'open', text: token.raw });
    } else if (TAIL_PUNCT.has(token.raw)) {
      parts.push({ kind: token.raw === '»' || token.raw === ')' || token.raw === ']' ? 'close' : 'tail', text: token.raw });
    } else {
      parts.push({ kind: 'word', text: token.raw });
    }
    i += 1;
  }

  const lines = render(parts)
    .replace(/ ?\n ?/g, '\n')
    .split('\n')
    .map(finishLine);
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return out;
}

/** Подсказка для интерфейса: что можно говорить вместо клавиатуры. */
export const VOICE_COMMAND_TIP =
  'Знаки можно не печатать: скажите «запятая», «точка», «с новой строки», «удалить последнее слово».';

export default applyVoiceCommands;
