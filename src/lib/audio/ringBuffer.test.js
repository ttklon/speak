import { describe, expect, it } from 'vitest';
import { createRingBuffer } from './ringBuffer.js';

describe('кольцевой буфер предролла', () => {
  it('отдаёт последние отсчёты в правильном порядке', () => {
    const ring = createRingBuffer(8);
    ring.push(new Float32Array([1, 2, 3]));
    ring.push(new Float32Array([4, 5]));
    expect([...ring.tail(4)]).toEqual([2, 3, 4, 5]);
    expect(ring.length).toBe(5);
  });

  it('после переполнения хранит только последние', () => {
    const ring = createRingBuffer(4);
    ring.push(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect([...ring.tail()]).toEqual([3, 4, 5, 6]);
  });

  it('корректно работает на стыке кольца', () => {
    const ring = createRingBuffer(5);
    ring.push(new Float32Array([1, 2, 3, 4]));
    ring.push(new Float32Array([5, 6]));
    // в буфере: 2,3,4,5,6 — читаем три последних
    expect([...ring.tail(3)]).toEqual([4, 5, 6]);
  });

  it('пустой буфер и нулевой запрос не ломаются', () => {
    const ring = createRingBuffer(4);
    expect(ring.tail().length).toBe(0);
    expect(ring.tail(2).length).toBe(0);
    ring.push(new Float32Array([7]));
    expect(ring.tail(0).length).toBe(0);
  });

  it('clear очищает накопленное', () => {
    const ring = createRingBuffer(4);
    ring.push(new Float32Array([1, 2, 3]));
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.tail().length).toBe(0);
  });
});
