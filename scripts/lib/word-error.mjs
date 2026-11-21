/** Word error rate for explicitly supplied reference text; punctuation/case ignored. */
export function words(text) {
  return String(text || '').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}
export function wordError(reference, hypothesis) {
  const ref = words(reference), hyp = words(hypothesis);
  if (!ref.length) throw new Error('Empty reference');
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++) {
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = next;
  }
  return { errors: prev[hyp.length], referenceWords: ref.length, wer: prev[hyp.length] / ref.length };
}
