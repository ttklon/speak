/**
 * Смоук апдейтера: проверяем, что канал (stable/beta) реально применяется,
 * а не просто сохраняется в настройках. Раньше переключатель «Канал» ни на что
 * не влиял — это был тихий обман интерфейса.
 */

import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

const fakeUpdater = {
  allowPrerelease: false,
  autoDownload: true,
  autoInstallOnAppQuit: false,
  logger: null,
  on() {},
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true } };
  if (request === 'electron-updater') return { autoUpdater: fakeUpdater };
  return originalLoad.call(this, request, parent, isMain);
};

const { createUpdater } = await import(path.resolve('electron/updater.cjs')).then((m) => m.default || m);

const ok = [];
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    ok.push(name);
  } catch (err) {
    fail.push(`${name}: ${err.message}`);
  }
};

const updater = createUpdater({ channel: 'stable' });

check('апдейтер отдаёт setChannel', () => {
  if (typeof updater.setChannel !== 'function') throw new Error('setChannel отсутствует');
});

await updater.check();

check('по умолчанию стабильный канал', () => {
  if (fakeUpdater.allowPrerelease) throw new Error('предрелизы включены по умолчанию');
});

check('бета-канал включает предрелизы', () => {
  updater.setChannel('beta');
  if (!fakeUpdater.allowPrerelease) throw new Error('allowPrerelease не включился');
});

check('возврат на стабильный выключает предрелизы', () => {
  updater.setChannel('stable');
  if (fakeUpdater.allowPrerelease) throw new Error('allowPrerelease остался включён');
});

check('мусор в канале не ломает апдейтер', () => {
  updater.setChannel('что-то странное');
  if (fakeUpdater.allowPrerelease) throw new Error('непонятное значение включило бету');
});

// Без build.publish electron-builder не создаёт latest.yml и app-update.yml, а
// установленное приложение просто не видит новых версий — молча, без ошибки.
check('в package.json есть источник обновлений (build.publish → github)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish : [pkg.build?.publish];
  const gh = publish.find((p) => p && p.provider === 'github');
  if (!gh) throw new Error('build.publish с provider=github не задан');
  if (gh.owner !== 'ttklon' || gh.repo !== 'speak') {
    throw new Error(`источник обновлений указывает на ${gh.owner}/${gh.repo}`);
  }
  if (!pkg.repository?.url?.includes('github.com/ttklon/speak')) {
    throw new Error('repository не совпадает с publish — update будет искать не тот репозиторий');
  }
  if (!pkg.dependencies?.['electron-updater']) throw new Error('electron-updater не в зависимостях');
});

console.log(`\nOK (${ok.length}):`);
ok.forEach((n) => console.log(`  ✓ ${n}`));
if (fail.length) {
  console.log(`\nПРОБЛЕМЫ (${fail.length}):`);
  fail.forEach((n) => console.log(`  × ${n}`));
  process.exit(1);
}
