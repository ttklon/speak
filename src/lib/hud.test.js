import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Плавающий индикатор диктовки живёт в отдельном окне Electron, поэтому
 * компонентные тесты его не покрывают. Здесь сторжим контракт: у окна есть
 * ровно две кнопки с понятными именами, стоп и закрытие идут через мост,
 * а мост умеет только три вещи.
 */

const root = resolve(__dirname, '../..');
const html = readFileSync(resolve(root, 'electron/hud.html'), 'utf8');
const preload = readFileSync(resolve(root, 'electron/hud-preload.cjs'), 'utf8');

describe('окно индикатора диктовки', () => {
  it('показывает состояние, уровень и время', () => {
    expect(html).toContain('id="title"');
    expect(html).toContain('id="time"');
    expect(html).toContain("--level");
    expect(html).toContain('onState');
    expect(html).toContain('Слушаю…');
    expect(html).toContain('Распознаю…');
  });

  it('говорит о состояниях словами человека, а не терминами', () => {
    // «Транскрибирую» — слово из мира движков: человек в плашке ищет «что
    // происходит», а не название процесса. Заодно у «готово» есть своё слово:
    // после команды голосом «Запись остановлена» звучит как отказ.
    expect(html).not.toContain('Транскрибирую');
    expect(html).toContain('Готово');
    expect(html).toContain('Распознаю запись…');
    // долгая запись режется на куски — это видно словами, а не «распознаю 8 с»
    expect(html).toContain('фрагмент ${parts.done} из ${parts.total}');
  });

  it('предупреждает о молчащем микрофоне ещё во время записи', () => {
    // Раньше о тишине говорили только после остановки: человек проговаривал
    // минуту в выключенный микрофон и узнавал об этом из ошибки.
    expect(html).toContain('Микрофон молчит');
    expect(html).toContain('p.quiet');
    expect(html).toContain('hud.dataset.quiet');
  });

  it('даёт кнопку «стоп» и кнопку «скрыть» с доступными именами', () => {
    expect(html).toMatch(/id="stop"[^>]*aria-label="Остановить запись"/);
    expect(html).toMatch(/id="close"[^>]*aria-label="Скрыть индикатор"/);
    expect(html).toContain('hudBridge?.stop()');
    expect(html).toContain('hudBridge?.close()');
  });

  it('не тянет в окно node и не забирает фокус', () => {
    expect(html).not.toContain('require(');
    expect(html).not.toContain('nodeIntegration');
    const main = readFileSync(resolve(root, 'electron/main.cjs'), 'utf8');
    const block = main.slice(main.indexOf('function createHudWindow'), main.indexOf('function showHudWindow'));
    expect(block).toContain('focusable: false');
    expect(block).toContain('alwaysOnTop: true');
    expect(block).toContain("preload: path.join(__dirname, 'hud-preload.cjs')");
    expect(block).toContain("loadFile(path.join(__dirname, 'hud.html'))");
  });

  it('мост отдаёт только стоп, закрытие и подписку на состояние', () => {
    const exposed = preload.slice(preload.indexOf('exposeInMainWorld'));
    expect(exposed).toContain("'hud:stop'");
    expect(exposed).toContain("'hud:close'");
    expect(exposed).toContain("'hud:state'");
    expect(exposed).not.toContain('ipcRenderer.send(');
  });
});
