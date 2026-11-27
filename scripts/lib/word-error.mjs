/** Deterministic WER/CER helpers. Normalization intentionally ignores case,
 * punctuation and ё/е; it is not a semantic or punctuation accuracy metric. */
const MAX_CELLS = 2_000_000;
export function words(text) {
  return String(text || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}
function checkSize(n, m) {
  if ((n + 1) * (m + 1) > MAX_CELLS) throw new Error('Alignment size exceeds limit');
}

/** Existing lightweight API: no transcript or alignment is returned. */
export function wordError(reference, hypothesis) {
  const ref = words(reference), hyp = words(hypothesis);
  if (!ref.length) throw new Error('Empty reference');
  checkSize(ref.length, hyp.length);
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

// Dynamic programming with two score rows and a byte per backtracking cell.
// Equal, substitution, deletion, insertion is the deterministic tie order.
function align(ref, hyp, includeAlignment) {
  const n = ref.length, m = hyp.length;
  if (!n) throw new Error('Empty reference');
  checkSize(n, m);
  const width = m + 1;
  const direction = new Uint8Array((n + 1) * width);
  let prev = Uint32Array.from({ length: width }, (_, i) => i);
  for (let j = 1; j <= m; j++) direction[j] = 3;
  for (let i = 1; i <= n; i++) {
    const next = new Uint32Array(width);
    next[0] = i;
    direction[i * width] = 2;
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      let best = prev[j - 1] + (same ? 0 : 1);
      let dir = same ? 0 : 1;
      const deletion = prev[j] + 1;
      const insertion = next[j - 1] + 1;
      if (deletion < best) { best = deletion; dir = 2; }
      if (insertion < best) { best = insertion; dir = 3; }
      next[j] = best;
      direction[i * width + j] = dir;
    }
    prev = next;
  }
  let i = n, j = m, substitutions = 0, deletions = 0, insertions = 0;
  const alignment = includeAlignment ? [] : null;
  while (i || j) {
    const dir = direction[i * width + j];
    if (dir === 0 || dir === 1) {
      const a = ref[--i], b = hyp[--j];
      if (dir === 1) substitutions++;
      if (alignment) alignment.push({ type: dir === 0 ? 'equal' : 'substitution', reference: a, hypothesis: b });
    } else if (dir === 2) {
      const a = ref[--i]; deletions++;
      if (alignment) alignment.push({ type: 'deletion', reference: a, hypothesis: null });
    } else {
      const b = hyp[--j]; insertions++;
      if (alignment) alignment.push({ type: 'insertion', reference: null, hypothesis: b });
    }
  }
  const result = { errors: substitutions + deletions + insertions, substitutions, deletions, insertions };
  if (alignment) result.alignment = alignment.reverse();
  return result;
}

export function alignWords(reference, hypothesis, { alignment = true } = {}) {
  const ref = words(reference), hyp = words(hypothesis);
  const result = align(ref, hyp, alignment);
  return { ...result, referenceWords: ref.length, wer: result.errors / ref.length };
}

/** CER counts Unicode code points after the same normalization as WER;
 * one space between normalized words is counted as a character. */
export function characterError(reference, hypothesis, { alignment = false } = {}) {
  const ref = Array.from(words(reference).join(' ')), hyp = Array.from(words(hypothesis).join(' '));
  const result = align(ref, hyp, alignment);
  return { ...result, referenceCharacters: ref.length, cer: result.errors / ref.length };
}
