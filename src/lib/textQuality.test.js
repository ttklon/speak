import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { judgeText, betterText } = require('../../electron/textQuality.cjs');

describe('judgeText', () => {
  it('нормальную фразу не переспрашивает', () => {
    const res = judgeText('Позвони Пете и скажи, что встреча в три.', { seconds: 4.2 });
    expect(res.unsure).toBe(false);
  });

  it('пустой результат — повод переспросить', () => {
    expect(judgeText('')).toEqual({ unsure: true, why: 'пусто' });
    expect(judgeText('   ').unsure).toBe(true);
  });

  it('одно слово на десять секунд речи — потеря, а не ответ', () => {
    expect(judgeText('Да.', { seconds: 10 }).why).toBe('слишком мало слов');
    // короткая запись — нормально
    expect(judgeText('Да.', { seconds: 1.2 }).unsure).toBe(false);
  });

  it('мало текста на длинную запись — тоже повод', () => {
    expect(judgeText('привет', { seconds: 6 }).unsure).toBe(true);
  });

  it('заглушки whisper узнаёт', () => {
    expect(judgeText('Продолжение следует...', { seconds: 6 }).why).toBe('фраза-заглушка');
    expect(judgeText('Субтитры сделал DimaTorzok', { seconds: 5 }).unsure).toBe(true);
    expect(judgeText('Thanks for watching!', { seconds: 5 }).unsure).toBe(true);
  });

  it('длинный текст с фразой «подписывайтесь» не переспрашивает: это может быть речь', () => {
    const text =
      'Итак, дорогие друзья, сегодня мы поговорим о том, как правильно настроить микрофон, ' +
      'а в конце я скажу: подписывайтесь на канал и ставьте лайки, потому что это помогает.';
    expect(judgeText(text, { seconds: 14 }).unsure).toBe(false);
  });

  it('зацикливание декодера видно', () => {
    expect(judgeText('вот вот вот вот и всё', { seconds: 3 }).why).toBe('зацикливание');
  });

  it('без длительности судит только по тексту', () => {
    expect(judgeText('привет, как дела', { seconds: 0 }).unsure).toBe(false);
  });
});

describe('betterText', () => {
  it('второй проход засчитывается, только если слов заметно больше', () => {
    expect(betterText('', 'привет, как дела')).toBe(true);
    expect(betterText('привет', 'привет, как дела')).toBe(true);
    expect(betterText('привет, как дела', 'привет, как дела')).toBe(false);
    expect(betterText('привет, как дела', 'привет')).toBe(false);
  });

  it('пустой второй проход не засчитывается никогда', () => {
    expect(betterText('привет, как дела', '')).toBe(false);
  });
});
