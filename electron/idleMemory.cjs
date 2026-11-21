/**
 * Когда отпускать модель из памяти.
 *
 * Зачем: «держать модель в памяти» ускоряет первую фразу, но занимает
 * ≈0,3–0,5 ГБ постоянно. На слабой машине это ровно та память, которой не
 * хватает браузеру и редактору. Через десять минут без диктовки модель в памяти
 * не помогает никому — её надо отпустить, а следующая диктовка просто загрузит
 * её снова (это секунды, но они уже не «на ровном месте»).
 *
 * Правило вынесено сюда, чтобы проверялось тестом, а не таймером.
 */

/** Сколько простоя терпим, прежде чем освободить память. */
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/**
 * @param {{lastUsedAt?: number, now?: number, warm?: boolean, keepLoaded?: boolean, idleMs?: number}} opts
 */
function shouldUnload({ lastUsedAt = 0, now = Date.now(), warm = false, keepLoaded = false, idleMs = IDLE_UNLOAD_MS } = {}) {
  // Если модель и так не держится в памяти, выгружать нечего.
  if (!keepLoaded) return false;
  if (!warm) return false;
  const last = Number(lastUsedAt) || 0;
  if (!last) return false;
  return Number(now) - last >= Number(idleMs);
}

module.exports = { shouldUnload, IDLE_UNLOAD_MS };
