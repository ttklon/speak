/**
 * Кольцевой буфер для предролла микрофона.
 *
 * Держит последние N отсчётов звука: когда человек нажимает хоткей и сразу
 * говорит, первые сотни миллисекунд уже записаны и уходят в распознавание
 * вместе с остальной записью.
 */
export function createRingBuffer(size) {
  if (!Number.isFinite(size) || size <= 0) throw new Error('размер буфера должен быть положительным');
  const buffer = new Float32Array(Math.floor(size));
  let write = 0;
  let filled = 0;

  return {
    get size() {
      return buffer.length;
    },
    get length() {
      return filled;
    },
    push(chunk) {
      if (!chunk || !chunk.length) return;
      for (let i = 0; i < chunk.length; i += 1) {
        buffer[write] = chunk[i];
        write = (write + 1) % buffer.length;
        if (filled < buffer.length) filled += 1;
      }
    },
    /** Последние `count` отсчётов (по умолчанию — всё, что накопилось). */
    tail(count = filled) {
      const n = Math.max(0, Math.min(Math.floor(count), filled));
      const out = new Float32Array(n);
      let start = (write - n + buffer.length * 2) % buffer.length;
      for (let i = 0; i < n; i += 1) {
        out[i] = buffer[start];
        start = (start + 1) % buffer.length;
      }
      return out;
    },
    clear() {
      write = 0;
      filled = 0;
    },
  };
}

export default createRingBuffer;
