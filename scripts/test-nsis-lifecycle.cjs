#!/usr/bin/env node
/** Полный жизненный цикл NSIS — исключительно на одноразовом GitHub runner.
 * Изменяются HKCU, ярлыки и тестовый профиль: на машине пользователя не запускать.
 * Установщик и деинсталлятор настоящие, профиль и каталог установки временные. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

assert.equal(process.platform, 'win32', 'тест выполняется только на Windows');
assert.equal(process.env.CI, 'true', 'тест только на CI');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'нужен одноразовый GitHub runner');
assert.equal(process.env.ZS_INPUT_INTERACTIVE, '1', 'тест создаёт окно и вводит клавиши');
assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA, 'не заданы каталоги CI');

const installer = path.resolve('release', `ZSpeakly-Setup-${pkg.version}.exe`);
if (!fs.existsSync(installer)) {
  console.log('SKIP: NSIS не собран; вместо установщика сборка могла создать ZIP.');
  process.exit(0);
}
const dataDir = path.join(process.env.APPDATA, 'ZSpeakly');
assert.ok(!fs.existsSync(dataDir), `отказ: существует профиль ${dataDir}, его нельзя менять`);
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'zs-nsis-'));
let installDir = path.join(root, 'installed app'); // намеренно проверяем путь с пробелом
let exe = path.join(installDir, 'ZSpeakly.exe');
let uninstall = path.join(installDir, 'Uninstall ZSpeakly.exe');
const profile = path.join(dataDir, 'profile.json');
const marker = JSON.stringify({ 'zs.settings': { onboarded: true }, 'zs.dictations': [{ id: 'ci-sentinel', text: 'история должна сохраниться' }] });
let installAttempted = false;
let uninstalled = false;

function run(file, args, opts = {}) {
  const result = spawnSync(file, args, {
    cwd: process.cwd(), encoding: 'utf8', timeout: opts.timeout || 180000,
    windowsHide: true, windowsVerbatimArguments: Boolean(opts.verbatim),
    env: { ...process.env, ...opts.env }, maxBuffer: 5 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${opts.label || file}: ${result.error?.message || `код ${result.status}, сигнал ${result.signal}`}`);
  return result.stdout || '';
}
function verifyProfile(stage) {
  assert.ok(fs.existsSync(profile), `${stage}: профиль исчез`);
  assert.equal(fs.readFileSync(profile, 'utf8'), marker, `${stage}: профиль изменился`);
  console.log(`${stage}: существующий профиль и история сохранены`);
}
function removeInstallation() {
  if (!fs.existsSync(uninstall)) throw new Error(`нет деинсталлятора: ${uninstall}`);
  // _?= последним: NSIS не копирует uninstaller, и процесс не завершится раньше удаления.
  run(uninstall, ['/S', `_?=${installDir}`], { verbatim: true, label: 'деинсталляция' });
  assert.ok(!fs.existsSync(exe), 'деинсталлятор оставил исполняемый файл приложения');
  uninstalled = true;
}
try {
  fs.mkdirSync(dataDir);
  fs.writeFileSync(profile, marker, 'utf8');
  installAttempted = true;
  // /D= последний и не заключён в кавычки: правило NSIS даже для путей с пробелами.
  run(installer, ['/S', `/D=${installDir}`], { verbatim: true, label: 'установка NSIS' });
  if (!fs.existsSync(exe)) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    console.log(`Содержимое тестового каталога: ${entries.map((e) => e.name).join(', ') || '(пусто)'}`);
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const folder = path.join(root, entry.name);
      console.log(`${folder}: ${fs.readdirSync(folder).slice(0, 15).join(', ') || '(пусто)'}`);
    }
    const defaultDir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZSpeakly');
    console.log(`Каталог по умолчанию: ${defaultDir}, exe=${fs.existsSync(path.join(defaultDir, 'ZSpeakly.exe'))}`);
  }
  assert.ok(fs.existsSync(exe), `установщик не создал ${exe}`);
  assert.ok(fs.existsSync(uninstall), `установщик не создал ${uninstall}`);
  verifyProfile('установка');
  run(process.execPath, ['scripts/check-packaged-onnx.cjs', path.join(installDir, 'resources')], { label: 'проверка установленного ONNX' });
  const firstDictation = run(process.execPath, ['scripts/test-wininput-window.cjs'], {
    timeout: 240000, label: 'диктовка установленного приложения',
    env: { ZS_TEST_ELECTRON: '1', ZS_TEST_PACKAGED: '1', ZS_TEST_WINDOWS_DICTATION: '1', ZS_TEST_PACKAGED_EXE: exe },
  });
  // Node сам заключает /D= с пробелом в кавычки — так делает и автообновление.
  // Другой путь доказывает, что EXE действительно создан заново, а не остался
  // от первой установки, если цитированный аргумент был разобран неверно.
  const oldExe = exe;
  const nextDir = path.join(root, 'updated app');
  run(installer, ['--updated', '/S', `/D=${nextDir}`], { label: 'повторная установка с кавычками' });
  installDir = nextDir;
  exe = path.join(installDir, 'ZSpeakly.exe');
  uninstall = path.join(installDir, 'Uninstall ZSpeakly.exe');
  assert.ok(fs.existsSync(exe), 'после повторной установки нет приложения в новом каталоге');
  assert.ok(!fs.existsSync(oldExe), 'старая установка не удалена при смене каталога');
  verifyProfile('повторная установка');
  const secondDictation = run(process.execPath, ['scripts/test-wininput-window.cjs'], {
    timeout: 240000, label: 'диктовка после повторной установки',
    env: { ZS_TEST_ELECTRON: '1', ZS_TEST_PACKAGED: '1', ZS_TEST_WINDOWS_DICTATION: '1', ZS_TEST_PACKAGED_EXE: exe },
  });
  removeInstallation();
  verifyProfile('удаление');
  if (firstDictation.includes('SKIP:') || secondDictation.includes('SKIP:')) {
    console.log('SKIP: часть проверок окна не выполнена; установка и удаление проверены.');
  } else {
    assert.match(firstDictation, /Виртуальная диктовка Windows \+ приложение после NSIS/);
    assert.match(secondDictation, /Виртуальная диктовка Windows \+ приложение после NSIS/);
    console.log('NSIS: установка, диктовка до и после повторной установки, удаление завершены.');
  }
} finally {
  if (installAttempted && !uninstalled && fs.existsSync(uninstall)) {
    try { removeInstallation(); } catch (error) { console.error(`Очистка установки не удалась: ${error.message}`); }
  } else if (installAttempted && !uninstalled) {
    // Старый установщик ошибочно обрезал каталог на первом пробеле.
    // Удаляем только заведомо созданный в нашем временном корне экземпляр.
    const truncatedDir = path.join(root, 'installed');
    const truncatedUninstall = path.join(truncatedDir, 'Uninstall ZSpeakly.exe');
    if (fs.existsSync(truncatedUninstall)) {
      try { run(truncatedUninstall, ['/S', `_?=${truncatedDir}`], { verbatim: true, label: 'очистка обрезанного пути' }); }
      catch (error) { console.error(`Очистка установки не удалась: ${error.message}`); }
    }
  }
  // Удаляем только собственный точный маркер; неизвестные пользовательские
  // данные и нетронутый профиль не трогаем даже при ошибке.
  try {
    if (fs.existsSync(profile) && fs.readFileSync(profile, 'utf8') === marker) fs.unlinkSync(profile);
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) fs.rmdirSync(dataDir);
  } catch (error) { console.error(`Очистка тестового профиля: ${error.message}`); }
  fs.rmSync(root, { recursive: true, force: true });
}
