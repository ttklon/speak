import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Модуль живёт в main-процессе (CommonJS): там же его читает main.cjs.
const require = createRequire(import.meta.url);
const { IDLE_UNLOAD_MS, shouldUnload } = require('../../electron/idleMemory.cjs');

describe('shouldUnload', () => {
  const base = { lastUsedAt: 1_000_000, keepLoaded: true, warm: true };

  it('через десять минут простоя — освобождаем память', () => {
    expect(shouldUnload({ ...base, now: base.lastUsedAt + IDLE_UNLOAD_MS })).toBe(true);
  });

  it('сразу после диктовки — не трогаем: человек ещё диктует', () => {
    expect(shouldUnload({ ...base, now: base.lastUsedAt + 60_000 })).toBe(false);
  });

  it('если модель не держат в памяти — выгружать нечего', () => {
    expect(shouldUnload({ ...base, keepLoaded: false, now: base.lastUsedAt + IDLE_UNLOAD_MS })).toBe(false);
  });

  it('если сервер и так не поднят — ничего не делаем', () => {
    expect(shouldUnload({ ...base, warm: false, now: base.lastUsedAt + IDLE_UNLOAD_MS })).toBe(false);
  });

  it('без единой диктовки в этой сессии — нечего освобождать', () => {
    expect(shouldUnload({ ...base, lastUsedAt: 0, now: Date.now() })).toBe(false);
  });
});
