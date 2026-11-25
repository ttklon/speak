import { createHash } from 'node:crypto';
import { loadCorpusForScoring } from './corpus-manifest.mjs';
import { scoreCorpus } from './corpus-score.mjs';

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

/** Does not run a model or authenticate declared metadata/results. */
export function scoreManifestRun(manifest, directory, run, { alignment = false } = {}) {
  if (!exact(run, ['version', 'manifestFingerprint', 'split', 'config', 'results']) || run.version !== 1 || !sha(run.manifestFingerprint) || !Array.isArray(run.results)) throw new Error('Invalid run');
  validateConfig(run.config);
  const { report, selected } = loadCorpusForScoring(manifest, directory, run.split);
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
