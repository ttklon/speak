import { describe, expect, it } from 'vitest';
import { micConstraints } from './micConstraints.js';

describe('micConstraints', () => {
  it('по умолчанию просит сырой звук без обработки звонков', () => {
    const { audio } = micConstraints();
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
    expect(audio.channelCount).toBe(1);
  });

  it('выбранный микрофон указывается точно', () => {
    const { audio } = micConstraints({ deviceId: 'usb-1' });
    expect(audio.deviceId).toEqual({ exact: 'usb-1' });
  });

  it('на «default» deviceId не навязывается', () => {
    expect(micConstraints({ deviceId: 'default' }).audio.deviceId).toBeUndefined();
    expect(micConstraints({ deviceId: '' }).audio.deviceId).toBeUndefined();
  });

  it('шумоподавление включается только по просьбе человека', () => {
    const { audio } = micConstraints({ cleanup: true });
    expect(audio.noiseSuppression).toBe(true);
    expect(audio.echoCancellation).toBe(true);
    expect(audio.autoGainControl).toBe(true);
  });
});
