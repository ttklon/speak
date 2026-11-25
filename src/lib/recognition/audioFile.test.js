import { describe, expect, it } from 'vitest';
import {
  AUDIO_ACCEPT,
  assembleFileParts,
  FILE_LIMITS,
  fileExt,
  fileTitle,
  formatBytes,
  formatDuration,
  mergeFileText,
  planWindows,
  progressLabel,
  slicePcm,
  validateAudioFile,
} from './audioFile.js';

describe('audioFile: окна нарезки', () => {
  it('короткий файл — одно окно', () => {
    expect(planWindows(5000, { windowMs: 30000, overlapMs: 800 })).toEqual([{ fromMs: 0, toMs: 5000 }]);
  });

  it('пустой файл — ни одного окна', () => {
    expect(planWindows(0)).toEqual([]);
  });

  it('минута режется на два окна с перекрытием на стыке', () => {
    const windows = planWindows(60000, { windowMs: 30000, overlapMs: 800 });
    expect(windows.length).toBe(2);
    expect(windows[0]).toEqual({ fromMs: 0, toMs: 30000 });
    // второй кусок начинается раньше стыка: слово на границе не потеряется
    expect(windows[1].fromMs).toBe(29200);
    expect(windows[1].toMs).toBe(60000);
  });

  it('хвост короче пятой части окна приклеивается к прошлому куску', () => {
    const windows = planWindows(61000, { windowMs: 30000, overlapMs: 800 });
    // иначе был бы третий проход на 1,8 с — полная загрузка модели ради двух слов
    expect(windows.length).toBe(2);
    expect(windows[1].toMs).toBe(61000);
  });

  it('длинный файл покрывает всю длительность без дыр', () => {
    const windows = planWindows(10 * 60 * 1000, { windowMs: 30000, overlapMs: 800 });
    expect(windows[0].fromMs).toBe(0);
    expect(windows[windows.length - 1].toMs).toBe(600000);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].fromMs).toBeLessThanOrEqual(windows[i - 1].toMs);
    }
  });
});

describe('audioFile: куски звука и склейка текста', () => {
  const pcm = Int16Array.from({ length: 16000 * 10 }, (_, i) => i % 100);

  it('slicePcm режет по времени', () => {
    const part = slicePcm(pcm, { fromMs: 2000, toMs: 4000 });
    expect(part.length).toBe(16000 * 2);
    expect(part[0]).toBe(pcm[16000 * 2]);
  });

  it('slicePcm не выходит за пределы записи', () => {
    const part = slicePcm(pcm, { fromMs: 8000, toMs: 20000 });
    expect(part.length).toBe(16000 * 2);
  });

  it('mergeFileText убирает повтор на стыке', () => {
    const text = mergeFileText(['Сегодня встреча в три часа', 'в три часа дня обсудим макет']);
    expect(text).toBe('Сегодня встреча в три часа дня обсудим макет');
  });

  it('mergeFileText пропускает пустые куски', () => {
    expect(mergeFileText(['', '  ', 'Привет', ''])).toBe('Привет');
  });
});

describe('audioFile: неполные результаты', () => {
  const windows = [
    { fromMs: 0, toMs: 30000 }, { fromMs: 29200, toMs: 59200 }, { fromMs: 58400, toMs: 80000 },
  ];
  it('сохраняет оба текста и позицию отказа вместо склейки через пропуск', () => {
    const result = assembleFileParts(['важно проверить', null, 'важно проверить ещё раз'], windows);
    expect(result.text).toBe('важно проверить\n[Не удалось распознать фрагмент 2: 0:29–0:59]\nважно проверить ещё раз');
    expect(result.speechText).toBe('важно проверить\nважно проверить ещё раз');
  });
  it('отмечает первый и последний отказ, не склеивает через тишину', () => {
    expect(assembleFileParts([null, 'слова', null], windows).text).toBe('[Не удалось распознать фрагмент 1: 0:00–0:30]\nслова\n[Не удалось распознать фрагмент 3: 0:58–1:20]');
    expect(assembleFileParts(['повтор', '', 'повтор'], windows).text).toBe('повтор\nповтор');
  });
  it('соседние успешные фрагменты по-прежнему склеиваются по перекрытию', () => {
    expect(assembleFileParts(['встреча в три часа', 'в три часа дня'], windows).text).toBe('встреча в три часа дня');
  });
  it('преобразует соседнюю группу после склейки и не изменяет маркер отказа', () => {
    const transform = (s) => s.replace('три часа дня', '15:00');
    const result = assembleFileParts(['встреча в три часа', 'в три часа дня', null], windows, transform);
    expect(result.text).toBe('встреча в 15:00\n[Не удалось распознать фрагмент 3: 0:58–1:20]');
    expect(result.speechText).toBe('встреча в 15:00');
  });
});

describe('audioFile: пределы и подписи', () => {
  it('файл без имени — отказ', () => {
    expect(validateAudioFile({}).reason).toBe('no-file');
  });

  it('слишком большой файл называет предел и выход', () => {
    const res = validateAudioFile({ name: 'a.wav', size: FILE_LIMITS.bytes + 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('too-big');
    expect(res.message).toMatch(/Разделите запись/);
  });

  it('слишком длинная запись называет предел', () => {
    const res = validateAudioFile({ name: 'a.wav', durationMs: FILE_LIMITS.durationMs + 1 });
    expect(res.reason).toBe('too-long');
    expect(res.message).toMatch(/по частям/);
  });

  it('обычный файл проходит', () => {
    expect(validateAudioFile({ name: 'встреча.m4a', size: 1024, durationMs: 5000 }).ok).toBe(true);
  });

  it('размер и длительность читаются по-человечески', () => {
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 МБ');
    expect(formatBytes(1024)).toBe('1 КБ');
    expect(formatDuration(65000)).toBe('1 мин 05 с');
    expect(formatDuration(3_840_000)).toBe('1 ч 04 мин');
  });

  it('имя файла без расширения и с обрезкой', () => {
    expect(fileExt('Запись.M4A')).toBe('m4a');
    expect(fileTitle('встреча-2026.wav')).toBe('встреча-2026');
    expect(fileTitle('')).toBe('Запись');
    expect(fileTitle('я'.repeat(120)).length).toBe(60);
  });

  it('подпись прогресса не врёт при переполнении', () => {
    expect(progressLabel(2, 9)).toBe('Фрагмент 2 из 9');
    expect(progressLabel(12, 9)).toBe('Фрагмент 9 из 9');
    expect(progressLabel(1, 0)).toBe('');
  });

  it('выбор файла принимает все ходовые форматы', () => {
    for (const ext of ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm']) {
      expect(AUDIO_ACCEPT).toContain(ext);
    }
  });
});
