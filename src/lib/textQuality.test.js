import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { judgeText, betterText, tailForPrompt, stripPromptEcho, shouldRetry } = require('../../electron/textQuality.cjs');

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

describe('tailForPrompt', () => {
  it('берёт конец фразы по границе слова', () => {
    const tail = tailForPrompt('сегодня мы обсуждали Zoom и Telegram, а завтра про Docker', 30);
    expect(tail.length).toBeLessThanOrEqual(30);
    expect(tail.startsWith(' ')).toBe(false);
    expect(tail).toMatch(/Docker$/);
  });

  it('убирает переносы и висящую пунктуацию', () => {
    expect(tailForPrompt('привет\nкак дела?')).toBe('привет как дела');
  });

  it('пустой текст — пустая подсказка', () => {
    expect(tailForPrompt('')).toBe('');
    expect(tailForPrompt(null)).toBe('');
  });

  it('не разваливает короткий текст', () => {
    expect(tailForPrompt('привет', 80)).toBe('привет');
  });
});

describe('stripPromptEcho', () => {
  it('срезает подсказку, повторённую целиком', () => {
    const tail = 'обсуждали Zoom и Telegram';
    expect(stripPromptEcho('обсуждали Zoom и Telegram, а завтра Docker.', tail)).toBe('а завтра Docker.');
  });

  it('срезает повтор по словам', () => {
    const tail = 'сегодня мы обсуждали Zoom и Telegram';
    expect(stripPromptEcho('обсуждали Zoom и Telegram, а завтра Docker', tail)).toBe('а завтра Docker');
  });

  it('обычный текст не трогает', () => {
    const text = 'позвони Пете и скажи про встречу';
    expect(stripPromptEcho(text, 'сегодня мы обсуждали Zoom')).toBe(text);
  });

  it('без подсказки возвращает текст как есть', () => {
    expect(stripPromptEcho('привет', '')).toBe('привет');
  });
});

describe('shouldRetry', () => {
  const unsure = { unsure: true, why: 'фраза-заглушка' };
  const fine = { unsure: false, why: '' };

  it('подозрительный текст на быстрой машине переспрашиваем', () => {
    expect(shouldRetry({ judge: unsure, plan: { thorough: false }, seconds: 5 })).toBe(true);
  });

  it('нормальный текст не переспрашиваем никогда', () => {
    expect(shouldRetry({ judge: fine, plan: { thorough: false }, seconds: 5 })).toBe(false);
  });

  it('если проход уже был честным, повтор ничего не даст', () => {
    expect(shouldRetry({ judge: unsure, plan: { thorough: true }, seconds: 5 })).toBe(false);
  });

  it('короткую запись не переспрашиваем', () => {
    expect(shouldRetry({ judge: unsure, plan: { thorough: false }, seconds: 0.8 })).toBe(false);
  });

  it('черновик живой расшифровки не переспрашиваем', () => {
    expect(shouldRetry({ judge: unsure, plan: { thorough: false }, seconds: 5, partial: true })).toBe(false);
  });

  it('код ошибки важнее сомнений', () => {
    expect(shouldRetry({ judge: unsure, plan: { thorough: false }, seconds: 5, code: 'cancelled' })).toBe(false);
  });
});
