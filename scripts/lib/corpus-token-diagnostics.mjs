import { words } from './word-error.mjs';

// These are literal bags, not semantic negation/number interpretation or an
// alignment. Compare within each clip before summing to avoid cross-clip matches.
const NEGATION = new Set(['не', 'ни', 'нет', 'нельзя']);
const TECHNICAL = new Set(['ai', 'api', 'sdk', 'saas', 'b2b']);
const CATEGORIES = ['negation', 'asciiDigits', 'adjacentRepeat', 'technicalLiterals'];
const COUNTS = ['matched', 'referenceExcess', 'hypothesisExcess'];
function bags(text) {
  const features = Object.fromEntries(CATEGORIES.map((category) => [category, new Map()]));
  const increment = (category, token) => {
    const bag = features[category];
    bag.set(token, (bag.get(token) || 0) + 1);
  };
  const tokens = words(text);
  tokens.forEach((token, i) => {
    if (NEGATION.has(token)) increment('negation', token);
    if (TECHNICAL.has(token)) increment('technicalLiterals', token);
    if (/^[0-9]+$/.test(token)) increment('asciiDigits', token);
    if (i > 0 && token === tokens[i - 1]) increment('adjacentRepeat', token);
  });
  return features;
}
function compare(ref, hyp) {
  let matched = 0, referenceExcess = 0, hypothesisExcess = 0;
  for (const [token, count] of ref) {
    const other = hyp.get(token) || 0;
    matched += Math.min(count, other);
    referenceExcess += Math.max(0, count - other);
  }
  for (const [token, count] of hyp) hypothesisExcess += Math.max(0, count - (ref.get(token) || 0));
  return { matched, referenceExcess, hypothesisExcess };
}
function emptyStage() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, { referenceOccurrences: 0,
    baseline: { matched: 0, referenceExcess: 0, hypothesisExcess: 0 },
    candidate: { matched: 0, referenceExcess: 0, hypothesisExcess: 0 } }]));
}

/** Texts are retained only for the duration of the call and never returned. */
export function summarizeTokenDiagnostics(samples) {
  if (!Array.isArray(samples) || samples.length > 10_000) throw new Error('Invalid token diagnostics');
  if (!samples.length) return { speechClips: 0, raw: null, final: null };
  const stages = { raw: emptyStage(), final: emptyStage() };
  for (const sample of samples) {
    const texts = [sample?.reference, sample?.baseline?.raw, sample?.baseline?.final, sample?.candidate?.raw, sample?.candidate?.final];
    if (texts.some((text) => typeof text !== 'string' || text.length > 200_000)) throw new Error('Invalid token diagnostics text');
    const reference = bags(sample.reference);
    for (const stage of ['raw', 'final']) {
      const base = bags(sample.baseline[stage]), candidate = bags(sample.candidate[stage]);
      for (const category of CATEGORIES) {
        const target = stages[stage][category];
        for (const count of reference[category].values()) target.referenceOccurrences += count;
        const before = compare(reference[category], base[category]), after = compare(reference[category], candidate[category]);
        for (const count of COUNTS) { target.baseline[count] += before[count]; target.candidate[count] += after[count]; }
      }
    }
  }
  for (const stage of ['raw', 'final']) for (const category of CATEGORIES) {
    const row = stages[stage][category];
    row.delta = Object.fromEntries(COUNTS.map((count) => [count, row.candidate[count] - row.baseline[count]]));
  }
  return { speechClips: samples.length, ...stages };
}
