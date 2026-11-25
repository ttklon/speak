import { alignWords, characterError, words } from './word-error.mjs';

const MAX_SAMPLES = 10_000;
const MAX_TEXT = 200_000;
const metadataKeys = ['corpus', 'model', 'revision'];

function stageOf(stage, label) {
  if (!stage || typeof stage !== 'object' || !['ok', 'error'].includes(stage.status)) throw new Error(`Invalid ${label} status`);
  if (stage.status === 'ok' && (typeof stage.text !== 'string' || stage.text.length > MAX_TEXT)) throw new Error(`Invalid ${label} text`);
  return stage;
}
function emptyAggregate() {
  return { errors: 0, substitutions: 0, deletions: 0, insertions: 0, referenceWords: 0, wer: null,
    characterErrors: 0, referenceCharacters: 0, cer: null };
}
export function summarizeScores(samples) {
  const result = { speechSamples: 0, pairedSpeech: 0, excludedSpeech: 0, silenceSamples: 0, pairedSilence: 0, excludedSilence: 0,
    raw: emptyAggregate(), final: emptyAggregate(), silence: { rawFalsePositives: 0, finalFalsePositives: 0, rawWords: 0, finalWords: 0 } };
  for (const sample of samples) {
    const paired = sample.raw.status === 'ok' && sample.final.status === 'ok';
    if (sample.kind === 'silence') {
      result.silenceSamples++;
      if (!paired) { result.excludedSilence++; continue; }
      result.pairedSilence++;
      for (const stage of ['raw', 'final']) {
        const count = sample[stage].words;
        result.silence[`${stage}Words`] += count;
        if (count) result.silence[`${stage}FalsePositives`]++;
      }
      continue;
    }
    result.speechSamples++;
    if (!paired) { result.excludedSpeech++; continue; }
    result.pairedSpeech++;
    for (const stage of ['raw', 'final']) {
      const target = result[stage], score = sample[stage];
      for (const field of ['errors', 'substitutions', 'deletions', 'insertions', 'referenceWords']) target[field] += score.word[field];
      target.characterErrors += score.character.errors;
      target.referenceCharacters += score.character.referenceCharacters;
    }
  }
  for (const stage of ['raw', 'final']) {
    const row = result[stage];
    row.wer = row.referenceWords ? row.errors / row.referenceWords : null;
    row.cer = row.referenceCharacters ? row.characterErrors / row.referenceCharacters : null;
  }
  return result;
}

/** Input and optional alignments can contain sensitive transcripts. Default output
 * contains identifiers, tags and aggregate metrics, but no recognized text. */
export function scoreCorpus(input, { alignment = false } = {}) {
  if (!input || input.version !== 1 || !Array.isArray(input.samples) || input.samples.length > MAX_SAMPLES) throw new Error('Invalid corpus version or samples');
  const metadata = {};
  for (const key of metadataKeys) {
    if (typeof input.metadata?.[key] !== 'string' || !input.metadata[key].trim() || input.metadata[key].length > 200) throw new Error(`Invalid metadata ${key}`);
    metadata[key] = input.metadata[key];
  }
  const ids = new Set();
  const samples = input.samples.map((item) => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || ids.has(item.id)) throw new Error('Invalid or duplicate sample ID');
    ids.add(item.id);
    if (typeof item.reference !== 'string' || item.reference.length > MAX_TEXT) throw new Error('Invalid reference');
    if (item.reference.trim() && !words(item.reference).length) throw new Error('Reference contains no normalized words');
    if (!Array.isArray(item.tags) || item.tags.length > 30 || item.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 100)) throw new Error('Invalid tags');
    const tags = [...new Set(item.tags)];
    const source = stageOf(item.raw, 'raw');
    const final = stageOf(item.final, 'final');
    const kind = item.reference.trim() ? 'speech' : 'silence';
    const score = (stage) => {
      if (stage.status === 'error') return { status: 'error' };
      if (kind === 'silence') return { status: 'ok', words: words(stage.text).length };
      return { status: 'ok', word: alignWords(item.reference, stage.text, { alignment }),
        character: characterError(item.reference, stage.text, { alignment }) };
    };
    return { id: item.id, tags, kind, raw: score(source), final: score(final) };
  });
  const categories = new Map();
  for (const sample of samples) for (const tag of sample.tags) {
    if (!categories.has(tag)) categories.set(tag, []);
    categories.get(tag).push(sample);
  }
  return { version: 1, normalization: 'NFC; lowercase ru; ё→е; punctuation/symbols ignored; spaces collapsed', metadata,
    summary: summarizeScores(samples), categories: Object.fromEntries([...categories].map(([tag, group]) => [tag, summarizeScores(group)])), samples };
}
