/**
 * Уборка временных файлов распознавания.
 *
 * Каждый проход whisper пишет wav во `%TEMP%/zspeakly` и удаляет его в finally.
 * Но если приложение убили (диспетчер задач, падение) или машина выключилась,
 * файлы остаются. Живая расшифровка делает такие проходы каждые 2,5 секунды,
 * поэтому мусор копится быстро: на длинной диктовке это десятки мегабайт.
 * При старте удаляем всё старше суток — свежие файлы могут принадлежать
 * работающему экземпляру.
 */
const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.dir           папка с временными wav
 * @param {number} [opts.olderThanMs] возраст, после которого файл считается мусором
 * @param {number} [opts.now]         текущее время (для тестов)
 * @returns {{removed: number, kept: number, error?: string}}
 */
function cleanupTemp({ dir, olderThanMs = DAY, now = Date.now() } = {}) {
  const result = { removed: 0, kept: 0 };
  if (!dir) return { ...result, error: 'no-dir' };
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    // папки нет — это нормально, whisper ещё ничего не писал
    return { ...result, error: err?.code === 'ENOENT' ? undefined : String(err?.message || err) };
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        result.kept += 1;
        continue;
      }
      if (now - stat.mtimeMs > olderThanMs) {
        fs.rmSync(file, { force: true });
        result.removed += 1;
      } else {
        result.kept += 1;
      }
    } catch {
      // файл занят или уже удалён — не наша проблема
      result.kept += 1;
    }
  }
  return result;
}

module.exports = { cleanupTemp, DAY };
