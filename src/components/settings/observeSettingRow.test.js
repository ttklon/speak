import { describe, expect, it, vi } from 'vitest';
import { observeSettingRow } from './observeSettingRow.js';

describe('переход к строке настроек', () => {
  it('находит уже отображённую строку без учёта регистра', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="setting-row">Микрофон</div>';
    const found = vi.fn();
    const stop = observeSettingRow(root, 'микрофон', found);
    expect(found).toHaveBeenCalledOnce();
    expect(found).toHaveBeenCalledWith(root.firstElementChild);
    stop();
  });

  it('ждёт строку, которая появилась после загрузки раздела', async () => {
    const root = document.createElement('div');
    const found = vi.fn();
    const stop = observeSettingRow(root, 'Микрофон', found);
    root.innerHTML = '<div>Загрузка раздела…</div>';
    await Promise.resolve();
    expect(found).not.toHaveBeenCalled();
    root.innerHTML = '<div class="setting-row">Микрофон</div>';
    await Promise.resolve();
    expect(found).toHaveBeenCalledOnce();
    root.append(document.createElement('div'));
    await Promise.resolve();
    expect(found).toHaveBeenCalledOnce();
    stop();
  });

  it('не переходит после отмены', async () => {
    const root = document.createElement('div');
    const found = vi.fn();
    const stop = observeSettingRow(root, 'Микрофон', found);
    stop();
    root.innerHTML = '<div class="setting-row">Микрофон</div>';
    await Promise.resolve();
    expect(found).not.toHaveBeenCalled();
  });
});
