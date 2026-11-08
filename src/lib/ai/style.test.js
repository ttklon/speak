import { describe, expect, it } from 'vitest';
import { analyzeStyle, describeStyle, stylePrompt } from './style.js';

const sample = (text) => ({ id: String(Math.random()), text, createdAt: Date.now() });

describe('стиль письма', () => {
  it('пустая история — нейтральный профиль', () => {
    const s = analyzeStyle([]);
    expect(s.samples).toBe(0);
    expect(describeStyle(s)).toMatch(/продиктуйте/i);
    expect(stylePrompt(s)).toBe('');
  });

  it('ловит обращение на «ты» и дружелюбный тон', () => {
    const s = analyzeStyle([
      sample('Привет, ты как? Давай созвонимся, спасибо!'),
      sample('Ты посмотри задачи, окей? Класс, спасибо.'),
      sample('Привет, скинь файл, пожалуйста. Ты успеешь?'),
    ]);
    expect(s.samples).toBe(3);
    expect(s.address).toBe('ты');
    expect(s.tone).toBe('friendly');
    expect(describeStyle(s)).toContain('на «ты»');
    expect(stylePrompt(s)).toContain('на «ты»');
  });

  it('ловит деловой тон и «вы»', () => {
    const s = analyzeStyle([
      sample('Здравствуйте, коллеги. Направляю вам отчёт, прошу проверить.'),
      sample('Уважаемые коллеги, необходимо согласовать смету. Вам направляю детали.'),
    ]);
    expect(s.address).toBe('вы');
    expect(s.tone).toBe('formal');
    expect(describeStyle(s)).toContain('на «вы»');
  });

  it('считает длину предложения и эмодзи', () => {
    const s = analyzeStyle([sample('Сегодня коротко. Завтра тоже коротко 🙂. Послезавтра работаем.')]);
    expect(s.avgSentence).toBeGreaterThan(0);
    expect(s.emoji).toBe(true);
    expect(stylePrompt(s)).toContain('эмодзи');
  });

  it('игнорирует слишком короткие записи', () => {
    const s = analyzeStyle([sample('ок'), sample('да')]);
    expect(s.samples).toBe(0);
  });
});
