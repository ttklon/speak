import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_WIDTH,
  MAX_HEIGHT,
  defaultBounds,
  resolveWindowBounds,
  boundsToSave,
  mostlyVisible,
} = require('../../electron/windowBounds.cjs');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const small = { x: 0, y: 0, width: 1024, height: 600 };

describe('размер окна по умолчанию', () => {
  it('на большом экране — 1020×680, не больше', () => {
    expect(defaultBounds(primary)).toEqual({ width: MAX_WIDTH, height: MAX_HEIGHT });
  });

  it('на экране 1024×600 окно влезает целиком', () => {
    const b = defaultBounds(small);
    expect(b.width).toBeLessThanOrEqual(small.width);
    expect(b.height).toBeLessThanOrEqual(small.height);
    expect(b.width).toBeGreaterThanOrEqual(MIN_WIDTH);
  });

  it('совсем маленький экран не превращается в окно меньше минимума', () => {
    const b = defaultBounds({ x: 0, y: 0, width: 640, height: 400 });
    expect(b).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it('без данных об экране не падает и не уходит ниже минимума', () => {
    expect(defaultBounds(null)).toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });
});

describe('восстановление сохранённого размера', () => {
  it('без сохранения открывает по размеру экрана', () => {
    const r = resolveWindowBounds(null, { displays: [primary], primary });
    expect(r.restored).toBe(false);
    expect(r.width).toBe(MAX_WIDTH);
    expect(r.maximized).toBe(false);
  });

  it('помнит размер и место, если они на экране', () => {
    const r = resolveWindowBounds({ x: 120, y: 80, width: 900, height: 600 }, { displays: [primary], primary });
    expect(r).toMatchObject({ x: 120, y: 80, width: 900, height: 600, restored: true, maximized: false });
  });

  it('не открывает окно меньше минимума, даже если так сохранили', () => {
    const r = resolveWindowBounds({ x: 10, y: 10, width: 400, height: 300 }, { displays: [primary], primary });
    expect(r.width).toBe(MIN_WIDTH);
    expect(r.height).toBe(MIN_HEIGHT);
  });

  it('не открывает окно шире экрана', () => {
    const r = resolveWindowBounds({ x: 0, y: 0, width: 3000, height: 2000 }, { displays: [small], primary: small });
    expect(r.width).toBe(MAX_WIDTH);
    // высота упирается в рабочий стол 600 px, а не в «кабинетные» 680
    expect(r.height).toBe(small.height);
  });

  it('переносит окно на основной экран, если прошлое место исчезло', () => {
    // второй монитор справа отключили
    const r = resolveWindowBounds({ x: 2200, y: 200, width: 900, height: 600 }, { displays: [primary], primary });
    expect(r.restored).toBe(false);
    expect(r.reason).toMatch(/больше не на экране/);
    expect(r.x).toBeUndefined();
    // размер остаётся прежним: человек выбрал его не просто так
    expect(r.width).toBe(900);
    expect(r.height).toBe(600);
  });

  it('прижимает окно к краю, если оно вылезло за рабочий стол', () => {
    const r = resolveWindowBounds({ x: -200, y: -50, width: 900, height: 600 }, { displays: [primary], primary });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('запоминает, что окно было развёрнуто', () => {
    const r = resolveWindowBounds({ x: 0, y: 0, width: 900, height: 600, maximized: true }, { displays: [primary], primary });
    expect(r.maximized).toBe(true);
  });

  it('учитывает второй монитор: окно там остаётся', () => {
    const second = { x: 1920, y: 0, width: 2560, height: 1400 };
    const r = resolveWindowBounds({ x: 2400, y: 200, width: 900, height: 600 }, { displays: [primary, second], primary });
    expect(r).toMatchObject({ x: 2400, y: 200, restored: true });
  });

  it('не доверяет мусору в профиле', () => {
    expect(resolveWindowBounds({ width: 'ой', height: null }, { displays: [primary], primary }).restored).toBe(false);
  });
});

describe('что сохраняем при закрытии', () => {
  it('берёт границы окна', () => {
    const win = { getBounds: () => ({ x: 10, y: 20, width: 800, height: 500 }), isMaximized: () => false };
    expect(boundsToSave(win)).toEqual({ x: 10, y: 20, width: 800, height: 500, maximized: false });
  });

  it('у развёрнутого окна сохраняет «нормальный» размер, а не экранный', () => {
    const win = {
      getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
      getNormalBounds: () => ({ x: 100, y: 60, width: 900, height: 600 }),
      isMaximized: () => true,
    };
    expect(boundsToSave(win)).toEqual({ x: 100, y: 60, width: 900, height: 600, maximized: true });
  });

  it('если окно уже уничтожено — ничего не сохраняем', () => {
    expect(boundsToSave(null)).toBeNull();
    expect(boundsToSave({ getBounds: () => { throw new Error('нет окна'); } })).toBeNull();
  });
});

describe('видимость окна на мониторе', () => {
  it('наполовину видно — считаем, что окно на месте', () => {
    expect(mostlyVisible({ x: 1400, y: 100, width: 800, height: 600 }, primary)).toBe(true);
  });

  it('чуть-чуть за краем — окно не найдено', () => {
    expect(mostlyVisible({ x: 1900, y: 100, width: 800, height: 600 }, primary)).toBe(false);
  });
});
