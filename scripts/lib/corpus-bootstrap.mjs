/** Paired percentile bootstrap over speakers, not clips. Input contains only
 * additive counts on the same successful speech cohort in both runs. A fixed
 * integer PRNG and sorted IDs make the Monte Carlo calculation reproducible. */
const SEED = 0x5eedc0de;
const REPLICATES = 1000;
const LIMIT = 2_000_000_000;
const fields = ['rawWordDelta', 'finalWordDelta', 'rawCharDelta', 'finalCharDelta'];

function random32(initial) {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
function percentile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return (sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)) || 0;
}

export function pairedSpeakerBootstrap(input) {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('Invalid bootstrap groups');
  const seen = new Set();
  const groups = input.map((g) => {
    if (!g || typeof g.speaker !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(g.speaker) || seen.has(g.speaker)) throw new Error('Invalid bootstrap speaker');
    seen.add(g.speaker);
    if (!['clips', 'words', 'characters', ...fields].every((k) => Number.isSafeInteger(g[k]) && Math.abs(g[k]) <= LIMIT) ||
        g.clips < 1 || g.clips > 10_000 || g.words < 1 || g.characters < 1) throw new Error('Invalid bootstrap counts');
    return g;
  }).sort((a, b) => a.speaker < b.speaker ? -1 : a.speaker > b.speaker ? 1 : 0);
  const report = { method: 'paired-speaker-percentile-v1', confidence: 0.95, seed: SEED, replicates: REPLICATES,
    speakers: groups.length, speechClips: groups.reduce((sum, g) => sum + g.clips, 0), interval: null };
  if (groups.length < 2) return { ...report, reason: 'fewer-than-two-speakers' };
  const next = random32(SEED);
  // Rejection avoids modulo bias for a group count that does not divide 2^32.
  const bound = Math.floor(0x100000000 / groups.length) * groups.length;
  const values = [[], [], [], []];
  for (let replicate = 0; replicate < REPLICATES; replicate++) {
    let words = 0, characters = 0, rawWord = 0, finalWord = 0, rawChar = 0, finalChar = 0;
    for (let draw = 0; draw < groups.length; draw++) {
      let value; do { value = next(); } while (value >= bound);
      const g = groups[value % groups.length];
      words += g.words; characters += g.characters;
      rawWord += g.rawWordDelta; finalWord += g.finalWordDelta;
      rawChar += g.rawCharDelta; finalChar += g.finalCharDelta;
    }
    values[0].push(rawWord / words || 0); values[1].push(finalWord / words || 0);
    values[2].push(rawChar / characters || 0); values[3].push(finalChar / characters || 0);
  }
  const bounds = values.map((row) => {
    row.sort((a, b) => a - b);
    return [percentile(row, 0.025), percentile(row, 0.975)];
  });
  report.interval = { raw: { wer: bounds[0], cer: bounds[2] }, final: { wer: bounds[1], cer: bounds[3] } };
  return report;
}
