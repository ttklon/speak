/**
 * Подсказки в интерфейсе обязаны называть реально существующие разделы.
 *
 * Человек читает «Настройки → Распознавание», идёт туда и не находит такого
 * раздела — после этого он не верит и остальным подсказкам. Такие тексты
 * появляются незаметно: раздел переименовали, строку в другом файле забыли.
 * Поэтому проверяем не файл с ошибками, а весь исходник интерфейса.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTION_LABELS, hintSections } from './settingsSections.js';

const ROOT = path.resolve(process.cwd(), 'src');

function sourceFiles(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|dist|__snapshots__/.test(full)) sourceFiles(full, acc);
      continue;
    }
    if (!/\.(js|jsx)$/.test(entry.name)) continue;
    if (/\.test\.jsx?$/.test(entry.name)) continue;
    if (/settingsSections\.js$/.test(entry.name)) continue; // там сами названия
    acc.push(full);
  }
  return acc;
}

// «Настройки → X» в любом виде кавычек, включая «Настройки → Функции → Модель…»
const SECTION_PATTERN = /Настройки\s*→\s*([^»"'`,;.)\n]+)/gu;
// «Раздел» — это шаблон в подсказке поиска («Настройки → Раздел»), а не раздел.
const TEMPLATE_LABELS = new Set(['Раздел', 'Такой-то раздел']);

/** Строки комментариев не показываются человеку — их не проверяем. */
function codeLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^(\*|\/\/|\/\*|\{\/\*)/.test(line));
}

describe('тексты интерфейса ведут в существующие разделы настроек', () => {
  const files = sourceFiles();

  it('файлы интерфейса вообще находятся', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('ни одна строка не отправляет в несуществующий раздел', () => {
    const broken = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(SECTION_PATTERN)) {
        const label = String(match[1]).trim();
        if (TEMPLATE_LABELS.has(label)) continue;
        if (!SETTINGS_SECTION_LABELS.some((known) => label.startsWith(known))) {
          broken.push(`${path.relative(ROOT, file)}: «${label}»`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('разбор подсказки из исходника находит только настоящие разделы', () => {
    const found = new Set();
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(SECTION_PATTERN)) {
        if (TEMPLATE_LABELS.has(String(match[1]).trim())) continue;
        for (const label of hintSections(match[0])) found.add(label);
      }
    }
    for (const label of found) expect(SETTINGS_SECTION_LABELS).toContain(label);
    // подсказки действительно есть — тест не «зелёный по пустоте»
    expect(found.size).toBeGreaterThan(1);
  });
});

describe('подсказки называют реально существующие строки настроек', () => {
  // «Настройки → Приложение → Тест микрофона» бесполезно, если строки «Тест
  // микрофона» там нет: раздел человек найдёт, а дальше — тупик. Поэтому
  // проверяем не только раздел, но и последнюю часть пути.
  const TAIL_PATTERN = /Настройки\s*→\s*[^»→\n]+→\s*([^»\n]+)/gu;
  // «Модель распознавания: скачайте…» — в цели только название.
  const cutTail = (tail) =>
    String(tail)
      .replace(/[«»"']/g, '')
      .split(/[:—–,.;]/)[0]
      .trim();

  const normalize = (text) =>
    String(text)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/<[^>]*>/g, ' ')
      .replace(/[^а-яa-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** Всё, что реально нарисовано в настройках: строки, группы, кнопки. */
  function settingsCorpus() {
    const dir = path.join(ROOT, 'components', 'settings');
    const parts = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(dir);
    return normalize(parts.join('\n'));
  }

  it('каждый шаг после второго «→» находится в настройках', () => {
    const corpus = settingsCorpus();
    const broken = [];
    const checked = [];
    for (const file of sourceFiles()) {
      for (const line of codeLines(fs.readFileSync(file, 'utf8'))) {
        for (const match of line.matchAll(TAIL_PATTERN)) {
          const tail = cutTail(match[1]);
          const needle = normalize(tail);
          if (needle.length < 3) continue;
          checked.push(tail);
          if (!corpus.includes(needle)) {
            broken.push(`${path.relative(ROOT, file)}: «${tail}»`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
    // тест не «зелёный по пустоте»: составные подсказки в проекте есть
    expect(checked.length).toBeGreaterThan(2);
  });
});

describe('в текстах интерфейса нет жаргона', () => {
  // «8× realtime», «Web Speech», «whisper.cpp установлен» — это имена из мира
  // разработки. Человек, который хочет говорить и получать текст, читает их и
  // не понимает, что делать. Технические имена остаются только в «Диагностике»
  // и в «О программе» — там их место.
  //
  // Границы слов важны: realtimeFactor и hasWebSpeech — это код, а не текст.
  const JARGON = [
    { re: /(?<![A-Za-z])realtime(?![A-Za-z])/i, what: 'realtime' },
    // в коде это ещё и литерал регулярки (/Web Speech/) — такой не считаем
    { re: /Web Speech(?!\/)/, what: 'Web Speech' },
    { re: /whisper\.cpp (установлен|не найден|не распознал)/, what: 'whisper.cpp как подпись действия' },
    { re: /(?<![A-Za-z])RAM(?![A-Za-z])/, what: 'RAM' },
  ];
  // Исключения: «Диагностика» и «О программе» — там технические имена уместны.
  const ALLOWED = /DiagnosticsSection\.jsx$|AboutSection\.jsx$|settingsIndex\.js$|config\.js$|recognition\/engine\.js$/;

  const jargonIn = (line) => JARGON.filter((rule) => rule.re.test(line)).map((rule) => rule.what);

  it('проверка ловит жаргон, а не только пустоту', () => {
    expect(jargonIn('{m.size} · RAM {m.ram} · {m.speed} realtime · точность {m.quality}')).toEqual([
      'realtime',
      'RAM',
    ]);
    expect(jargonIn('Это окно в браузере: распознавание идёт через Web Speech')).toEqual(['Web Speech']);
    // и не срабатывает на код
    expect(jargonIn('const realtimeFactor = f; hasWebSpeech(); const ramGb = 8;')).toEqual([]);
    expect(jargonIn("const engineHint = /Web Speech/.test(engine)")).toEqual([]);
  });

  it('ни один видимый текст не требует знать название технологии', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      // Один формат пути для Windows и POSIX, иначе исключение движка не работает.
      if (ALLOWED.test(file.replace(/\\/g, '/'))) continue;
      for (const line of codeLines(fs.readFileSync(file, 'utf8'))) {
        for (const what of jargonIn(line)) {
          offenders.push(`${path.relative(ROOT, file)}: ${what} — ${line.slice(0, 70)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('в текстах интерфейса нет моделей из старого каталога', () => {
  // В интерфейсе три режима (lib/modelTiers.js). Подписи вроде «Модель base
  // распознаёт быстрее» остались от прежнего каталога и отправляли человека
  // искать модель, которой в настройках уже нет.
  const STALE = /модел[ьи]\s*\**\s*(base|small|tiny|medium)\b/iu;

  it('старые имена моделей не встречаются в видимых строках', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      for (const line of codeLines(fs.readFileSync(file, 'utf8'))) {
        const match = line.match(STALE);
        if (match) offenders.push(`${path.relative(ROOT, file)}: «${match[0]}»`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
