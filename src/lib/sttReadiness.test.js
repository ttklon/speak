import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { determineReadiness } = require('../../electron/sttEngine.cjs');

const yes = { available: true };
const no = { available: false };
const para = (available) => ({ available, languages: ['en', 'de', 'fr', 'es', 'uk'] });

describe('готовность распознавания', () => {
  it.each([
    [{ language: 'ru', gigaam: yes, parakeet: para(false), whisper: no }, 'gigaam', true, false],
    [{ language: 'en-US', gigaam: no, parakeet: para(true), whisper: yes }, 'parakeet', true, true],
    [{ language: 'ru', gigaam: no, parakeet: para(true), whisper: yes }, 'whisper', true, true],
    [{ language: 'zh', gigaam: yes, parakeet: para(true), whisper: no }, 'whisper', false, false],
    [{ language: 'ru', preference: 'whisper', gigaam: yes, parakeet: para(true), whisper: no }, 'whisper', false, false],
    [{ language: 'en', preference: 'whisper', gigaam: no, parakeet: para(true), whisper: yes }, 'whisper', true, true],
  ])('использует ту же политику выбора, что и распознавание: %j', (input, engine, available, shortAvailable) => {
    expect(determineReadiness(input)).toMatchObject({ status: available ? 'available' : 'missing', engine, shortAvailable });
  });
  it('не превращает недоступный статус или ошибочную структуру в готовность', () => {
    expect(determineReadiness({ language: 'ru', gigaam: {}, whisper: yes }).status).toBe('unknown');
    expect(determineReadiness({ language: 'ru', gigaam: yes, whisper: {} }).status).toBe('unknown');
    expect(determineReadiness({ language: 'en', parakeet: { available: true }, whisper: yes }).status).toBe('unknown');
    expect(determineReadiness({ language: 'zh', whisper: { available: 'yes' } }).status).toBe('unknown');
  });
  it('не требует статусов ONNX, если явно выбран Whisper', () => {
    expect(determineReadiness({ language: 'ru', preference: 'whisper', whisper: yes })).toMatchObject({ status: 'available', engine: 'whisper', shortAvailable: true });
  });
});
