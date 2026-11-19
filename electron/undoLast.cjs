/**
 * Можно ли убрать последнюю вставку — решается здесь, до SendInput.
 *
 * Стирание вслепую: Backspace в активное окно. Назад дороги нет, поэтому
 * проверки строгие и собраны в одном месте, чтобы их можно было прочитать и
 * проверить без Windows и без Electron:
 *
 *  1) было что вставлять;
 *  2) прошло не больше двух минут (человек ещё помнит, что говорил);
 *  3) это приложение для Windows (в браузере мы не видим чужих окон);
 *  4) переднем плане не наше окно (иначе сотрём текст в собственном интерфейсе);
 *  5) приложение на переднем плане то же, куда вставляли.
 *
 * Если приложение окна неизвестно (не смогли прочитать), не отказываем: пять
 * проверок выше уже сузили риск, а «не убирать никогда» — хуже, чем убрать.
 */

const UNDO_TTL_MS = 2 * 60 * 1000;

function appKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim();
}

function planUndo({
  text = '',
  at = 0,
  now = Date.now(),
  platform = process.platform,
  own = false,
  targetApp = '',
  currentApp = '',
  ttl = UNDO_TTL_MS,
} = {}) {
  const value = String(text || '');
  if (!value.trim()) return { ok: false, reason: 'нечего убирать' };
  const stamp = Number(at) || 0;
  const age = stamp ? Math.max(0, Number(now) - stamp) : Infinity;
  if (age > ttl) return { ok: false, reason: 'прошло больше двух минут' };
  if (platform !== 'win32') {
    return { ok: false, reason: 'стирание есть только в приложении для Windows' };
  }
  if (own) return { ok: false, reason: 'окно ZSpeakly сейчас на переднем плане' };
  const was = appKey(targetApp);
  const current = appKey(currentApp);
  if (was && current && was !== current) {
    return { ok: false, reason: `текст был в «${targetApp}», сейчас «${currentApp}»` };
  }
  // Символы, а не байты: Backspace считает то, что видно на экране.
  const chars = Array.from(value).length;
  if (!chars) return { ok: false, reason: 'нечего убирать' };
  return { ok: true, chars };
}

module.exports = { planUndo, appKey, UNDO_TTL_MS };
