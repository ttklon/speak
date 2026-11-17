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
    .filter((line) => !/^(\*|\/\/|\/\*)/.test(line));
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
