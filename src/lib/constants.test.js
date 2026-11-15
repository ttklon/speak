import { describe, it, expect } from 'vitest';
import { ENGINE_LABEL, IS_ELECTRON } from './constants.js';

describe('константы окружения', () => {
  it('в браузере движок назван понятной строкой, а не пустотой', () => {
    expect(typeof ENGINE_LABEL).toBe('string');
    expect(ENGINE_LABEL.length).toBeGreaterThan(0);
  });

  it('без моста Electron приложение знает, что оно в браузере', () => {
    expect(IS_ELECTRON).toBe(false);
  });
});
