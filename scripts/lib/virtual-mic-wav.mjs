/** Запас тишины защищает начало фразы от задержки запуска аудиографа.
 * Chromium всё равно получает настоящий контрольный WAV, без зацикливания. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createPaddedWav(pcm, sampleRate) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || sampleRate !== 16000) {
    throw new Error('Нужен непустой моно PCM16 16 кГц');
  }
  const prefixSeconds = 2;
  const suffixSeconds = 1;
  const data = Buffer.concat([
    Buffer.alloc(sampleRate * 2 * prefixSeconds), pcm, Buffer.alloc(sampleRate * 2 * suffixSeconds),
  ]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(data.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-fake-audio-'));
  try {
    const file = path.join(dir, 'audio.wav');
    fs.writeFileSync(file, Buffer.concat([header, data]));
    return { file, seconds: data.length / (sampleRate * 2), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
