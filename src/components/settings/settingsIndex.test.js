import { describe, expect, it } from 'vitest';
import { SETTING_ENTRIES } from './settingsIndex.js';

describe('индекс настроек', () => {
  it('содержит строки из всех шести разделов', () => {
    const sections = new Set(SETTING_ENTRIES.map((e) => e.section));
    expect([...sections].sort()).toEqual([
      'about',
      'account',
      'app',
      'data',
      'diagnostics',
      'features',
      'network',
    ]);
  });

  it('находит настройки по частым запросам', () => {
    const find = (q) => SETTING_ENTRIES.filter((e) => e.title.toLowerCase().includes(q)).map((e) => e.title);
    expect(find('звук')).toContain('Звуковой отклик');
    expect(find('полировк')).toContain('Умная полировка');
    expect(find('язык')).toContain('Язык диктовки');
    expect(find('трей')).toContain('Свернуть в трей при закрытии');
    expect(find('ошибки')).toContain('Отправлять ошибки и логи');
  });

  it('не содержит обрезков короче четырёх символов', () => {
    expect(SETTING_ENTRIES.every((e) => e.title.length >= 4)).toBe(true);
  });

  it('описания не обрезаны на первом переносе строки', () => {
    // раньше регулярка сборщика останавливалась на переводе строки, и в индекс
    // попадали обрезки вроде «…, уровень микрофона, живой текст и»
    const descs = SETTING_ENTRIES.map((e) => e.desc).filter(Boolean);
    expect(descs.length).toBeGreaterThan(10);
    const broken = descs.filter((d) => !/[.!?»)]$/.test(d.trim()));
    expect(broken).toEqual([]);
  });

  it('находит строки, которые рисует отдельный компонент (микрофон)', () => {
    const find = (q) => SETTING_ENTRIES.filter((e) => e.title.toLowerCase().includes(q)).map((e) => e.title);
    expect(find('устройство микрофона')).toContain('Устройство микрофона');
    expect(find('тест микрофона')).toContain('Тест микрофона');
  });

  it('находит строки по словам из конца описания', () => {
    const byDesc = (q) => SETTING_ENTRIES.filter((e) => (e.desc || '').toLowerCase().includes(q));
    expect(byDesc('кнопки').map((e) => e.title)).toContain('Плавающий индикатор записи');
    // 1.6.0: в интерфейсе остались только настройки-вкусы, остальное выбирает
    // autotune — поэтому проверяем именно то, что человек видит
    expect(byDesc('офлайн-правил').map((e) => e.title)).toContain('Умная полировка');
    expect(byDesc('одним json-файлом').map((e) => e.title)).toContain('Скачать копию');
  });
});
