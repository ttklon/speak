import { createHash } from 'node:crypto';
import { loadCorpusForScoring } from './corpus-manifest.mjs';
import { scoreCorpus, summarizeScores } from './corpus-score.mjs';
import { pairedSpeakerBootstrap } from './corpus-bootstrap.mjs';

const id = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validateConfig(config) {
  if (!exact(config, ['model', 'weightsSha256', 'engineRevision', 'pipelineRevision', 'decodeConfigSha256', 'environment', 'randomness']) ||
      !id(config.model) || !sha(config.weightsSha256) || !id(config.engineRevision) || !id(config.pipelineRevision) || !sha(config.decodeConfigSha256) ||
      !exact(config.environment, ['platform', 'hardware', 'runtime']) || !Object.values(config.environment).every(id) ||
      !exact(config.randomness, ['seed', 'deterministic']) || !(config.randomness.seed === null || Number.isSafeInteger(config.randomness.seed)) ||
      typeof config.randomness.deterministic !== 'boolean') throw new Error('Invalid run config');
}
function validateStage(stage) {
  if (!stage || (stage.status === 'ok' ? !exact(stage, ['status', 'text']) || typeof stage.text !== 'string' || stage.text.length > 200_000 :
    stage.status !== 'error' || !exact(stage, ['status']))) throw new Error('Invalid result stage');
}

function validateRun(run) {
  if (!exact(run, ['version', 'manifestFingerprint', 'split', 'config', 'results']) || run.version !== 1 || !sha(run.manifestFingerprint) || !Array.isArray(run.results)) throw new Error('Invalid run');
  validateConfig(run.config);
}
function scoreLoadedRun({ report, selected }, run, { alignment = false } = {}) {
  if (run.manifestFingerprint !== report.validatedContentSha256) throw new Error('Manifest fingerprint mismatch');
  if (run.results.length !== selected.length) throw new Error('Results do not cover the selected split');
  const expected = new Set(selected.map((item) => item.id));
  const byId = new Map();
  for (const row of run.results) {
    if (!exact(row, ['id', 'raw', 'final']) || !expected.has(row.id) || byId.has(row.id)) throw new Error('Invalid or duplicate results');
    validateStage(row.raw); validateStage(row.final);
    byId.set(row.id, row);
  }
  const samples = selected.map(({ id, reference }) => ({ id, reference, tags: [], raw: byId.get(id).raw, final: byId.get(id).final }));
  const scores = scoreCorpus({ version: 1, metadata: { corpus: report.corpus, revision: report.revision, model: run.config.model }, samples }, { alignment });
  const fingerprintRows = run.results.map(({ id, raw, final }) => [id, raw.status, raw.status === 'ok' ? raw.text : null,
    final.status, final.status === 'ok' ? final.text : null]);
  fingerprintRows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const resultsFingerprint = createHash('sha256').update(JSON.stringify(fingerprintRows)).digest('hex');
  return { version: 1, manifestFingerprint: report.validatedContentSha256, resultsFingerprint, split: run.split,
    publishResultsAllowed: report.publishResultsAllowed, config: run.config, scores };
}

/** Does not run a model or authenticate declared metadata/results. */
export function scoreManifestRun(manifest, directory, run, options = {}) {
  validateRun(run);
  return scoreLoadedRun(loadCorpusForScoring(manifest, directory, run.split), run, options);
}

/** Compare only clips whose raw and final stages succeeded in both runs.
 * No winner or statistical significance is inferred from the numbers. */
export function compareManifestRuns(manifest, directory, baseline, candidate, { bySpeaker = false, byCondition = false, bootstrapSpeakers = false } = {}) {
  if (typeof bootstrapSpeakers !== 'boolean') throw new Error('Invalid bootstrap option');
  if (typeof byCondition !== 'boolean') throw new Error('Invalid condition option');
  if (typeof bySpeaker !== 'boolean') throw new Error('Invalid speaker option');
  validateRun(baseline);
  validateRun(candidate);
  if (baseline.split !== candidate.split) throw new Error('Run split mismatch');
  if (baseline.manifestFingerprint !== candidate.manifestFingerprint) throw new Error('Run fingerprint mismatch');
  // Read and hash all manifest files once: both runs use the same verified references.
  const corpus = loadCorpusForScoring(manifest, directory, baseline.split);
  if (byCondition && corpus.report.version !== 2) throw new Error('Conditions require manifest version 2');
  const before = scoreLoadedRun(corpus, baseline);
  const after = scoreLoadedRun(corpus, candidate);
  const cohort = () => ({ total: 0, common: 0, baselineOnlyFailed: 0, candidateOnlyFailed: 0, bothFailed: 0 });
  const cohorts = { speech: cohort(), silence: cohort() };
  const commonBefore = [], commonAfter = [];
  const speakerGroups = new Map();
  const conditionGroups = new Map();
  const conditionsByClip = byCondition ? new Map(corpus.selected.map((sample) => [sample.id, sample.conditions])) : null;
  const speakerByClip = bySpeaker || bootstrapSpeakers ? new Map(corpus.selected.map((sample) => [sample.id, sample.speaker?.toLowerCase() ?? null])) : null;
  const byId = new Map(after.scores.samples.map((sample) => [sample.id, sample]));
  for (const a of before.scores.samples) {
    const b = byId.get(a.id);
    const group = cohorts[a.kind];
    group.total++;
    const failedA = a.raw.status !== 'ok' || a.final.status !== 'ok';
    const failedB = b.raw.status !== 'ok' || b.final.status !== 'ok';
    const outcome = !failedA && !failedB ? 'common' : failedA && failedB ? 'bothFailed' : failedA ? 'baselineOnlyFailed' : 'candidateOnlyFailed';
    group[outcome]++;
    if (outcome === 'common') { commonBefore.push(a); commonAfter.push(b); }
    if ((bySpeaker || bootstrapSpeakers) && a.kind === 'speech') {
      const speaker = speakerByClip.get(a.id);
      if (!speakerGroups.has(speaker)) speakerGroups.set(speaker, { cohort: cohort(), before: [], after: [] });
      const slice = speakerGroups.get(speaker);
      slice.cohort.total++;
      slice.cohort[outcome]++;
      if (outcome === 'common') { slice.before.push(a); slice.after.push(b); }
    }
    if (byCondition) for (const condition of conditionsByClip.get(a.id)) {
      if (!conditionGroups.has(condition)) conditionGroups.set(condition, { cohorts: { speech: cohort(), silence: cohort() }, before: [], after: [] });
      const slice = conditionGroups.get(condition);
      slice.cohorts[a.kind].total++;
      slice.cohorts[a.kind][outcome]++;
      if (outcome === 'common') { slice.before.push(a); slice.after.push(b); }
    }
  }
  const a = summarizeScores(commonBefore), b = summarizeScores(commonAfter);
  const deltaFor = (first, second, fields, hasCommon) => Object.fromEntries(fields.map((field) =>
    [field, hasCommon && first[field] !== null && second[field] !== null ? second[field] - first[field] : null]));
  const wordFields = ['errors', 'substitutions', 'deletions', 'insertions', 'wer', 'characterErrors', 'cer'];
  const silenceFields = ['rawFalsePositives', 'finalFalsePositives', 'rawWords', 'finalWords'];
  const configFields = [
    ['model', (c) => c.model], ['weightsSha256', (c) => c.weightsSha256], ['engineRevision', (c) => c.engineRevision],
    ['pipelineRevision', (c) => c.pipelineRevision], ['decodeConfigSha256', (c) => c.decodeConfigSha256],
    ['environment.platform', (c) => c.environment.platform], ['environment.hardware', (c) => c.environment.hardware],
    ['environment.runtime', (c) => c.environment.runtime], ['randomness.seed', (c) => c.randomness.seed],
    ['randomness.deterministic', (c) => c.randomness.deterministic],
  ];
  const speakers = bySpeaker ? [...speakerGroups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([speaker, slice]) => {
    const first = summarizeScores(slice.before), second = summarizeScores(slice.after);
    return { speaker, cohort: slice.cohort,
      baseline: { raw: first.raw, final: first.final }, candidate: { raw: second.raw, final: second.final },
      delta: { raw: deltaFor(first.raw, second.raw, wordFields, slice.cohort.common),
        final: deltaFor(first.final, second.final, wordFields, slice.cohort.common) } };
  }) : undefined;
  const bootstrap = bootstrapSpeakers ? pairedSpeakerBootstrap([...speakerGroups.entries()]
    .filter(([, slice]) => slice.cohort.common > 0)
    .map(([speaker, slice]) => {
      const first = summarizeScores(slice.before), second = summarizeScores(slice.after);
      return { speaker, clips: slice.cohort.common, words: first.raw.referenceWords, characters: first.raw.referenceCharacters,
        rawWordDelta: second.raw.errors - first.raw.errors, finalWordDelta: second.final.errors - first.final.errors,
        rawCharDelta: second.raw.characterErrors - first.raw.characterErrors,
        finalCharDelta: second.final.characterErrors - first.final.characterErrors };
    })) : undefined;
  const conditions = byCondition ? [...conditionGroups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([condition, slice]) => {
    const first = summarizeScores(slice.before), second = summarizeScores(slice.after);
    return { condition, cohorts: slice.cohorts, baseline: first, candidate: second,
      delta: { raw: deltaFor(first.raw, second.raw, wordFields, slice.cohorts.speech.common),
        final: deltaFor(first.final, second.final, wordFields, slice.cohorts.speech.common),
        silence: deltaFor(first.silence, second.silence, silenceFields, slice.cohorts.silence.common) } };
  }) : undefined;
  return { version: 1, manifestFingerprint: corpus.report.validatedContentSha256, split: baseline.split,
    publishResultsAllowed: corpus.report.publishResultsAllowed,
    complete: cohorts.speech.common === cohorts.speech.total && cohorts.silence.common === cohorts.silence.total,
    cohorts, ...(bySpeaker ? { speakers } : {}), ...(byCondition ? { conditions } : {}), ...(bootstrapSpeakers ? { bootstrap } : {}), configDifferences: configFields.filter(([, get]) => get(baseline.config) !== get(candidate.config)).map(([name]) => name),
    baseline: { config: before.config, resultsFingerprint: before.resultsFingerprint, metrics: a },
    candidate: { config: after.config, resultsFingerprint: after.resultsFingerprint, metrics: b },
    delta: { raw: deltaFor(a.raw, b.raw, wordFields, cohorts.speech.common),
      final: deltaFor(a.final, b.final, wordFields, cohorts.speech.common),
      silence: deltaFor(a.silence, b.silence, silenceFields, cohorts.silence.common) } };
}
