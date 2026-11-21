import { describe, expect, it } from 'vitest';
import { formatLiveDraft } from './liveDraft.js';

describe('черновик живой расшифровки', () => {
  it('обычный текст не трогает', () => {
    expect(formatLiveDraft({ text: 'привет как дела' })).toBe('привет как дела');
  });

  it('обрезанное окно помечает многоточием', () => {
    expect(formatLiveDraft({ text: 'это только хвост фразы', truncated: true })).toBe(
      '… это только хвост фразы',
    );
  });

  it('не дублирует многоточие и схлопывает пробелы', () => {
    expect(formatLiveDraft({ text: '… уже с точкой', truncated: true })).toBe('… уже с точкой');
    expect(formatLiveDraft({ text: '  два   слова  ' })).toBe('два слова');
  });

  it('пустой текст остаётся пустым, даже если окно обрезано', () => {
    expect(formatLiveDraft({ text: '', truncated: true })).toBe('');
    expect(formatLiveDraft()).toBe('');
  });
});
