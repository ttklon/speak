/**
 * Где и какого размера открывать главное окно.
 *
 * Зачем отдельный модуль: до 1.36.0 окно каждый запуск открывалось заново по
 * размеру экрана. Человек на слабом ноутбуке сужал его до 720 px, чтобы рядом
 * поместился браузер, — и после перезапуска получал снова развёрнутое окно.
 * Здесь вся арифметика собрана в чистые функции: их видно в тестах, и их
 * невозможно «случайно» сломать правкой в main.
 *
 * Правила простые и проверяемые:
 *  - меньше 720×480 окно не открываем (проверено аудитом интерфейса);
 *  - больше рабочего стола — не открываем, иначе край с кнопками уедет за экран;
 *  - если сохранённая позиция больше не существует (отключили второй монитор),
 *    окно открывается по центру основного, а не в пустоте;
 *  - сохранённый размер применяем, только если он не меньше минимума.
 */

const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const MAX_WIDTH = 1020;
const MAX_HEIGHT = 680;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Размер по умолчанию: не больше 1020×680 и не меньше 720×480. */
function defaultBounds(workArea, gap = 60) {
  const w = num(workArea?.width) || MIN_WIDTH + gap;
  const h = num(workArea?.height) || MIN_HEIGHT + gap;
  return {
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w - gap)),
    height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h - gap)),
  };
}

/**
 * Помещается ли прямоугольник в рабочий стол хотя бы наполовину.
 * Именно наполовину: окно, у которого виден только заголовок, человек не
 * подвинет — он его не найдёт.
 */
function mostlyVisible(bounds, area) {
  const ax1 = area.x;
  const ay1 = area.y;
  const ax2 = area.x + area.width;
  const ay2 = area.y + area.height;
  const overlapW = Math.min(bounds.x + bounds.width, ax2) - Math.max(bounds.x, ax1);
  const overlapH = Math.min(bounds.y + bounds.height, ay2) - Math.max(bounds.y, ay1);
  if (overlapW <= 0 || overlapH <= 0) return false;
  return overlapW >= bounds.width / 2 && overlapH >= bounds.height / 2;
}

/**
 * Итоговые размеры окна на запуске.
 *
 * @param {object|null} saved     то, что сохранили в прошлый раз ({x,y,width,height,maximized})
 * @param {object}      env
 * @param {Array}       env.displays  рабочие области всех мониторов ([{x,y,width,height}])
 * @param {object}      env.primary   рабочий стол основного монитора
 * @returns {{width:number,height:number,x?:number,y?:number,maximized:boolean,restored:boolean,reason?:string}}
 */
function resolveWindowBounds(saved, { displays = [], primary } = {}) {
  const areas = (displays.length ? displays : [primary]).filter(
    (a) => a && num(a.width) > 0 && num(a.height) > 0,
  );
  const main = primary && num(primary.width) > 0 ? primary : areas[0] || { x: 0, y: 0, width: 1280, height: 800 };
  const fallback = { ...defaultBounds(main), maximized: false, restored: false, reason: 'по размеру экрана' };
  if (!saved || typeof saved !== 'object') return fallback;

  if (!num(saved.width) || !num(saved.height)) return fallback;

  // Размер из прошлого раза, но не больше основного экрана: сменили монитор на
  // маленький — окно не должно висеть шире рабочего стола.
  const width = Math.max(MIN_WIDTH, Math.min(Math.max(MIN_WIDTH, main.width), MAX_WIDTH, num(saved.width)));
  const height = Math.max(MIN_HEIGHT, Math.min(Math.max(MIN_HEIGHT, main.height), MAX_HEIGHT, num(saved.height)));
  const withSize = { width, height, maximized: saved.maximized === true, restored: true, reason: 'как в прошлый раз' };

  const x = num(saved.x);
  const y = num(saved.y);
  if (x === null || y === null) return withSize;

  const area = areas.find((a) => mostlyVisible({ x, y, width, height }, a));
  if (!area) {
    // Второй монитор отключили или сменили масштаб: размер помним, а место — нет.
    return { ...withSize, restored: false, reason: 'прошлое место больше не на экране' };
  }

  // Прижимаем к рабочему столу: человек мог сохранить окно, вылезшее за край
  // при смене масштаба (125 % → 150 %).
  const fitX = Math.min(Math.max(x, area.x), area.x + area.width - width);
  const fitY = Math.min(Math.max(y, area.y), area.y + area.height - height);
  return { ...withSize, x: Math.round(fitX), y: Math.round(fitY) };
}

/** Развёрнутое окно храним отдельно: размер «нормального» окна под ним. */
function boundsToSave(win) {
  if (!win) return null;
  let maximized = false;
  try {
    maximized = typeof win.isMaximized === 'function' ? win.isMaximized() : false;
  } catch {
    maximized = false;
  }
  let bounds = null;
  try {
    bounds = (maximized && typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds()) || null;
  } catch {
    bounds = null;
  }
  if (!bounds || !num(bounds.width) || !num(bounds.height)) return null;
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized,
  };
}

module.exports = { MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT, defaultBounds, resolveWindowBounds, boundsToSave, mostlyVisible };
