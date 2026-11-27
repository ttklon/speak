import { describe, expect, it } from 'vitest';
import { normalizeInputs } from './devices.js';

describe('normalizeInputs', () => {
  it('оставляет только микрофоны', () => {
    const list = normalizeInputs([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Микрофон (Realtek)' },
      { kind: 'videoinput', deviceId: 'cam-1', label: 'Камера' },
      { kind: 'audiooutput', deviceId: 'spk-1', label: 'Динамики' },
    ]);
    expect(list).toEqual([{ id: 'mic-1', label: 'Микрофон (Realtek)' }]);
  });

  it('выбрасывает системное устройство «default», чтобы не было дубля с пунктом по умолчанию', () => {
    const list = normalizeInputs([
      { kind: 'audioinput', deviceId: 'default', label: 'Системный по умолчанию' },
      { kind: 'audioinput', deviceId: 'communications', label: 'Communications' },
      { kind: 'audioinput', deviceId: 'mic-2', label: 'Микрофон (USB)' },
    ]);
    expect(list.map((d) => d.id)).toEqual(['mic-2']);
  });

  it('убирает повторы одного и того же устройства', () => {
    const list = normalizeInputs([
      { kind: 'audioinput', deviceId: 'mic-3', label: 'Микрофон (USB)' },
      { kind: 'audioinput', deviceId: 'mic-3', label: 'Микрофон (USB)' },
    ]);
    expect(list).toHaveLength(1);
  });

  it('подписывает устройства без метки', () => {
    const list = normalizeInputs([
      { kind: 'audioinput', deviceId: 'mic-a', label: '' },
      { kind: 'audioinput', deviceId: 'mic-b', label: '' },
    ]);
    expect(list.map((d) => d.label)).toEqual(['Микрофон 1', 'Микрофон 2']);
  });

  it('пустой ответ не ломает список', () => {
    expect(normalizeInputs()).toEqual([]);
    expect(normalizeInputs([])).toEqual([]);
  });
});
