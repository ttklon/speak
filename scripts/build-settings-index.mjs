/**
 * Собирает индекс настроек для поиска: «название строки → раздел».
 *
 * Зачем: поиск по настройкам раньше искал только 6 названий разделов, поэтому
 * «звук» или «уведомления» давали пустой экран. Индекс генерируется из самих
 * секций, чтобы не разъезжаться с кодом.
 *
 * Запуск: node scripts/build-settings-index.mjs [--check]
 *   --check  только проверить, что индекс актуален (для CI)
 */

import fs from 'node:fs';
import path from 'node:path';

const SECTIONS_DIR = 'src/components/settings/sections';
const OUT = 'src/components/settings/settingsIndex.js';

/** Секции, которые реально показываются в настройках, и их подписи. */
const SECTION_LABELS = {
  account: 'Аккаунт',
  app: 'Приложение',
  features: 'Функции',
  data: 'Данные и разрешения',
  diagnostics: 'Диагностика',
  network: 'Сеть',
  about: 'О программе',
};

const SECTION_FILES = {
  account: 'AccountSection.jsx',
  app: 'AppSection.jsx',
  features: 'FeaturesSection.jsx',
  data: 'DataSection.jsx',
  diagnostics: 'DiagnosticsSection.jsx',
  network: 'NetworkSection.jsx',
  about: 'AboutSection.jsx',
};

/** Вытащить пары «заголовок строки — описание» из JSX секции. */
function extractRows(source) {
  const rows = [];
  const rowRe = /<div className="setting-row">([\s\S]*?)<\/div>\s*(?=<Select|<Toggle|<Button|<input|<div className="setting-row"|<div className="settings-group"|<\/div>)/g;
  for (const chunk of source.matchAll(rowRe)) {
    const body = chunk[1];
    const label = body.match(/className="setting-row__label"[^>]*>\s*([^<>\n{][^<>\n]*)/);
    const desc = body.match(/className="setting-row__desc"[^>]*>\s*([^<>\n{][^<>\n]*)/);
    if (!label) continue;
    // описание с JSX-выражением — это код, а не текст: в поиске он бесполезен
    const rawDesc = (desc?.[1] || '').trim().replace(/\s+/g, ' ');
    const descDone = /[{}<>]/.test(rawDesc) ? '' : rawDesc;
    rows.push({
      title: label[1].trim().replace(/\s+/g, ' '),
      desc: descDone,
    });
  }
  return rows;
}

/** Строки раздела «О программе» размечены иначе — берём подписи из info-строк. */
function extractInfoRows(source) {
  const rows = [];
  const infoRe = /<span className="kv-row__key">([^<>{]+)<\/span>/g;
  for (const m of source.matchAll(infoRe)) {
    rows.push({ title: m[1].trim().replace(/\s+/g, ' '), desc: '' });
  }
  return rows;
}

function build() {
  const entries = [];
  for (const [id, file] of Object.entries(SECTION_FILES)) {
    const full = path.join(SECTIONS_DIR, file);
    if (!fs.existsSync(full)) continue;
    const source = fs.readFileSync(full, 'utf8');
    for (const row of extractRows(source)) {
      // мусорные обрезки типа «Как» пропускаем: настоящий заголовок длиннее 3 букв
      if (row.title.length < 4) continue;
      entries.push({ section: id, sectionLabel: SECTION_LABELS[id], title: row.title, desc: row.desc });
    }
  }
  // «О программе» — отдельная разметка
  const aboutFile = path.join(SECTIONS_DIR, SECTION_FILES.about);
  if (fs.existsSync(aboutFile)) {
    for (const row of extractInfoRows(fs.readFileSync(aboutFile, 'utf8'))) {
      if (row.title.length < 4) continue;
      entries.push({ section: 'about', sectionLabel: SECTION_LABELS.about, ...row });
    }
  }

  // уникализируем по «раздел + заголовок»
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.section}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const header = `/**\n * ИНДЕКС НАСТРОЕК — сгенерирован скриптом scripts/build-settings-index.mjs.\n *\n * Руками не правим: запустите \`npm run settings:index\`.\n * Используется поиском по настройкам, чтобы находить конкретные строки,\n * а не только названия разделов.\n */\n\n`;

const body = `export const SETTING_ENTRIES = ${JSON.stringify(build(), null, 2)};\n\nexport default SETTING_ENTRIES;\n`;

const args = process.argv.slice(2);
if (args.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const next = header + body;
  if (current !== next) {
    console.error('Индекс настроек устарел. Запустите: npm run settings:index');
    process.exit(1);
  }
  console.log('Индекс настроек актуален.');
} else {
  fs.writeFileSync(OUT, header + body);
  console.log(`Записано ${build().length} строк(и) в ${OUT}`);
}
