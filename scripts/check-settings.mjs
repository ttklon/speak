#!/usr/bin/env node
/**
 * Проверка настроек: опечатка в ключе не должна прятаться в тишине.
 *
 * Что проверяем:
 *  1) каждое значение из DEFAULT_SETTINGS кто-то читает (иначе это настройка-пустышка);
 *  2) каждый ключ, который интерфейс читает через settings.X или пишет через
 *     updateSettings({X}), есть в DEFAULT_SETTINGS — иначе настройка молча
 *     никуда не сохраняется и «не работает»;
 *  3) каждая настройка находится поиском в настройках (есть в индексе) либо
 *     честно указана служебной.
 *
 * Запуск: node scripts/check-settings.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { TUNED_KEYS } from '../src/lib/autotune.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const verbose = process.argv.includes('--verbose');

// Служебные ключи: не настройки для человека, а состояние приложения.
const SERVICE = new Set([
  'onboardingDone',
  'lastSeenVersion',
  'lastUpdateCheck',
  'seenWhatsNew',
  'channel',
  'seenClipboard', // гаснет ли плашка «НОВОЕ» у буфера
  'voiceHotkeys', // массивы живут отдельными ключами хранилища
  'textActions',
]);

// 1.6.0: значения, которые приложение выбирает само (src/lib/autotune.js).
// Их нет в интерфейсе намеренно — «настройка, которую нельзя испортить».
for (const key of TUNED_KEYS) SERVICE.add(key);

// Настройки, которые живут не в «Настройках», а на странице «Горячие клавиши»:
// поиск по настройкам их и не должен находить.
const PAGE_LEVEL = new Set(['dictationKey', 'dictationKeys', 'useWritingStyle', 'dictionaryEnabled']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      walk(rel, out);
    } else if (/\.(js|jsx|cjs|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const configSrc = read('src/lib/config.js');
const defaultsMatch = configSrc.match(/export const DEFAULT_SETTINGS\s*=\s*\{([\s\S]*?)\n\};/);
if (!defaultsMatch) {
  console.error('не нашёл DEFAULT_SETTINGS в src/lib/config.js');
  process.exit(1);
}
const defaults = [...defaultsMatch[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]);

const files = [...walk('src'), ...walk('electron')].filter((f) => f !== 'src/lib/config.js');
const sources = new Map(files.map((f) => [f, read(f)]));
const all = [...sources.values()].join('\n');

const indexSrc = read('src/components/settings/settingsIndex.js');
const indexPath = 'src/components/settings/settingsIndex.js';

const problems = [];

// 1) настройка-пустышка
for (const key of defaults) {
  const used = files.filter((f) => new RegExp(`\\b${key}\\b`).test(sources.get(f)));
  if (!used.length) {
    problems.push(`DEFAULT_SETTINGS.${key} никто не читает — мёртвая настройка`);
  } else if (verbose) {
    console.log(`· ${key}: ${used.length} файл(ов)`);
  }
}

// 2) ключи, которых нет в DEFAULT_SETTINGS
const known = new Set(defaults);
const referenced = new Map();
for (const [file, text] of sources) {
  for (const m of text.matchAll(/\bsettings\.([A-Za-z_$][\w$]*)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], file);
  }
  for (const m of text.matchAll(/updateSettings\(\{\s*([A-Za-z_$][\w$]*)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], file);
  }
  for (const m of text.matchAll(/\bsettingsRef\.current\.([A-Za-z_$][\w$]*)/g)) {
    if (!referenced.has(m[1])) referenced.set(m[1], file);
  }
}
for (const [key, file] of referenced) {
  if (!known.has(key) && !SERVICE.has(key)) {
    problems.push(`settings.${key} (${file}) нет в DEFAULT_SETTINGS — значение не сохранится`);
  }
}

// 3) настройку можно найти поиском
for (const key of defaults) {
  if (SERVICE.has(key) || PAGE_LEVEL.has(key)) continue;
  // ключ должен встречаться в исходниках раздела настроек: либо как settings.X,
  // либо в самом индексе (индекс собирается из текстов разделов)
  const inSections = ['src/components/settings/sections', 'src/components/settings'].some((dir) =>
    files
      .filter((f) => f.startsWith(path.join(dir)) && f !== indexPath)
      .some((f) => new RegExp(`\\b${key}\\b`).test(sources.get(f))),
  );
  if (!inSections && !indexSrc.includes(key)) {
    problems.push(`настройка ${key} не встречается в разделах настроек — её не найти поиском`);
  }
}

if (problems.length) {
  console.error(`✗ Настройки: ${problems.length} проблем(ы)`);
  for (const p of problems) console.error('  •', p);
  process.exit(1);
}
console.log(`✓ Настройки в порядке: ${defaults.length} значений, все читаются и находятся поиском`);
