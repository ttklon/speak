/** Подготовить все файлы движка до замены и восстановить предыдущие при сбое. */
const fs = require('node:fs');
const path = require('node:path');

function installEngineFiles(files, bin) {
  const seen = new Set();
  for (const file of files) {
    // На Windows имена без учёта регистра относятся к одному файлу.
    const key = path.basename(file).toLowerCase();
    if (seen.has(key)) throw new Error(`в архиве повторяется файл ${path.basename(file)}`);
    seen.add(key);
  }

  const staging = fs.mkdtempSync(path.join(bin, '.engine-update-'));
  const incoming = path.join(staging, 'new');
  const backup = path.join(staging, 'backup');
  let keepBackup = false;
  try {
    fs.mkdirSync(incoming);
    fs.mkdirSync(backup);
    const plan = files.map((file) => {
      const name = path.basename(file);
      const target = path.join(bin, name);
      const fresh = path.join(incoming, name);
      const saved = path.join(backup, name);
      const hadOld = fs.existsSync(target);
      // Подготовка может не хватить места, но ещё не затрагивает рабочие файлы.
      fs.copyFileSync(file, fresh);
      if (hadOld) fs.copyFileSync(target, saved);
      return { target, fresh, saved, hadOld };
    });
    const applied = [];
    try {
      for (const item of plan) {
        fs.renameSync(item.fresh, item.target);
        applied.push(item);
      }
    } catch (err) {
      const failed = [];
      for (const item of applied.reverse()) {
        try {
          if (item.hadOld) fs.renameSync(item.saved, item.target);
          else fs.rmSync(item.target, { force: true });
        } catch (restoreErr) {
          failed.push(`${path.basename(item.target)}: ${restoreErr.message}`);
        }
      }
      if (failed.length) {
        // Не удаляем единственную резервную копию, если её не удалось вернуть.
        keepBackup = true;
        throw new Error(`не удалось установить движок: ${err.message}; не удалось восстановить ${failed.join(', ')}; сохранённые копии, если были: ${backup}`);
      }
      throw err;
    }
  } finally {
    if (!keepBackup) fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { installEngineFiles };
