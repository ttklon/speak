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
    expect(html).toContain('Транскрибирую…');
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
