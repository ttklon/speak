/**
 * Пресеты и голосовые горячие клавиши должны действительно что-то делать.
 *
 * Пресет без офлайн-правила — это кнопка-пустышка: без Ollama она молча
 * возвращает тот же текст, и человек считает, что «инструкция не работает».
 * Тест прогоняет каждый пресет через исполнителя с выключенным ИИ и требует
 * заметного результата.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_PRESETS, DEFAULT_VOICE_HOTKEYS } from '../config.js';
import { runInstruction } from './instructions.js';

const OFFLINE = { aiProcessing: false, language: 'ru', translateTarget: 'en' };

describe('пресеты AI-инструкций', () => {
  for (const preset of DEFAULT_AI_PRESETS) {
    it(`«${preset.title}» что-то меняет без модели`, async () => {
      const source = 'ну короче мы вчера обсудили проект атлас и решили что дедлайн переносится';
      const out = await runInstruction(preset, source, OFFLINE);
      const shown = typeof out === 'string' ? out : out?.text;
      expect(typeof shown).toBe('string');
      expect(shown.trim().length).toBeGreaterThan(0);
      // пустышка вернула бы исходный текст без изменений
      expect(shown.trim().toLowerCase()).not.toBe(source);
    });
  }

  it('перевод действительно переводит, а не переписывает', async () => {
    const out = await runInstruction(
      { id: 'to-english', prompt: 'Переведи текст на английский язык.' },
      'Спасибо за встречу',
      OFFLINE,
    );
    const shown = typeof out === 'string' ? out : out.text;
    expect(shown.toLowerCase()).toMatch(/thank|meeting/);
    // частичный перевод обязан нести пометку, иначе это нечестный ярлык
    if (typeof out === 'object') {
      expect(/модель|перевод/i.test(out.note)).toBe(true);
    }
  });

  it('пустой текст не превращается в выдуманный', async () => {
    expect(await runInstruction(DEFAULT_AI_PRESETS[0], '', OFFLINE)).toBe('');
    expect(await runInstruction(DEFAULT_AI_PRESETS[0], '   ', OFFLINE)).toBe('');
  });

  it('своя инструкция без промпта не падает и не врёт', async () => {
    const out = await runInstruction({ id: 'custom-1', title: 'Моя', prompt: '' }, 'текст для правки', OFFLINE);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('голосовые горячие клавиши', () => {
  it('у каждой есть сочетание и подпись', () => {
    expect(DEFAULT_VOICE_HOTKEYS.length).toBeGreaterThan(0);
    for (const hk of DEFAULT_VOICE_HOTKEYS) {
      expect(Array.isArray(hk.keys) || typeof hk.key === 'string').toBe(true);
      expect(String(hk.title || hk.label || '').trim().length).toBeGreaterThan(0);
    }
  });
});
