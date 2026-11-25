import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateCorpusManifest } from '../../scripts/lib/corpus-manifest.mjs';
import { scoreManifestRun } from '../../scripts/lib/corpus-run.mjs';

const dirs = [];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-corpus-run-')); dirs.push(dir);
  const rows = [['one', 'dev', 'speaker1', 'не отправляй письмо', 'fake audio 1'], ['two', 'dev', null, '', 'fake audio 2'], ['held', 'test', 'speaker2', 'контрольная фраза', 'fake audio 3']];
  const clips = rows.map(([id, split, speaker, text, audio]) => {
    fs.writeFileSync(path.join(dir, `${id}.wav`), audio); fs.writeFileSync(path.join(dir, `${id}.txt`), text);
    return { id, split, speaker, kind: speaker ? 'speech' : 'silence', audio: { path: `${id}.wav`, sha256: sha(audio) },
      reference: { path: `${id}.txt`, sha256: sha(text), author: 'author', reviewer: 'reviewer', status: 'approved' },
      rights: { source: 'private-source', license: 'consent', evidence: 'private-evidence', storage: true, evaluation: true, publishResults: false } };
  });
  const manifest = { version: 1, corpus: 'synthetic', revision: 'rev1', clips };
  const run = { version: 1, manifestFingerprint: validateCorpusManifest(manifest, dir).validatedContentSha256, split: 'dev',
    config: { model: 'no-model', weightsSha256: sha('no-weights'), engineRevision: 'engine1', pipelineRevision: 'pipeline1',
      decodeConfigSha256: sha('synthetic-config'), environment: { platform: 'synthetic', hardware: 'synthetic', runtime: 'synthetic' },
      randomness: { seed: null, deterministic: false } },
    results: [{ id: 'one', raw: { status: 'ok', text: 'отправляй письмо' }, final: { status: 'ok', text: 'не отправляй письмо' } },
      { id: 'two', raw: { status: 'ok', text: 'ложная фраза' }, final: { status: 'ok', text: '' } }] };
  return { dir, manifest, run };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('оценка привязанного прогона', () => {
  it('оценивает строго выбранный раздел по проверенным эталонам без вывода текста', () => {
    const { dir, manifest, run } = setup();
    const report = scoreManifestRun(manifest, dir, run);
    expect(report).toMatchObject({ manifestFingerprint: run.manifestFingerprint, split: 'dev', config: run.config,
      scores: { summary: { speechSamples: 1, pairedSpeech: 1, silenceSamples: 1, pairedSilence: 1,
        raw: { errors: 1 }, final: { errors: 0 }, silence: { rawFalsePositives: 1, finalFalsePositives: 0 } } } });
    const json = JSON.stringify(report);
    for (const secret of ['отправляй', 'ложная фраза', 'контрольная фраза', 'private-evidence', 'speaker1']) expect(json).not.toContain(secret);
    expect(JSON.stringify(scoreManifestRun(manifest, dir, run, { alignment: true }))).toContain('отправляй');
  });
  it('отпечаток результатов не зависит от порядка и меняется при смене расшифровки', () => {
    const { dir, manifest, run } = setup();
    const digest = scoreManifestRun(manifest, dir, run).resultsFingerprint;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    run.results.reverse(); expect(scoreManifestRun(manifest, dir, run).resultsFingerprint).toBe(digest);
    run.results[0].raw.text = 'иная фраза';
    expect(scoreManifestRun(manifest, dir, run).resultsFingerprint).not.toBe(digest);
  });
  it('не принимает чужой или устаревший отпечаток, даже при той же версии корпуса', () => {
    const { dir, manifest, run } = setup();
    run.manifestFingerprint = sha('wrong'); expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/fingerprint/i);
    run.manifestFingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    manifest.clips[0].rights.publishResults = true; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/fingerprint/i);
  });
  it('не считает отсутствующие, повторные и посторонние ID за успешный или парный прогон', () => {
    const { dir, manifest, run } = setup();
    run.results.pop(); expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/results/i);
    run.results.push({ ...run.results[0] }); expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/results/i);
    run.results[1].id = 'held'; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/results/i);
    run.split = 'validation'; run.results = []; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/split/i);
  });
  it('отказ этапа виден и не превращается в нулевую ошибку', () => {
    const { dir, manifest, run } = setup(); run.results[0].final = { status: 'error' };
    const { summary } = scoreManifestRun(manifest, dir, run).scores;
    expect(summary).toMatchObject({ pairedSpeech: 0, excludedSpeech: 1, raw: { wer: null }, final: { wer: null } });
  });
  it('отклоняет чужой эталон в результатах, неполную конфигурацию и невалидные этапы', () => {
    const { dir, manifest, run } = setup();
    run.results[0].reference = 'подменено'; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/results/i);
    delete run.results[0].reference; delete run.config.weightsSha256; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/config/i);
    run.config.weightsSha256 = sha('x'); run.results[0].raw = { status: 'error', text: 'скрытые данные' }; expect(() => scoreManifestRun(manifest, dir, run)).toThrow(/stage/i);
  });
  it('отклоняет изменённые файлы и не печатает частичный отчёт или секреты при ошибке CLI', () => {
    const { dir, manifest, run } = setup();
    const manifestFile = path.join(dir, 'manifest.json'), runFile = path.join(dir, 'run.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.writeFileSync(runFile, JSON.stringify(run));
    const cli = path.resolve('scripts/score-manifest-run.mjs');
    const ok = spawnSync(process.execPath, [cli, manifestFile, runFile], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0); expect(JSON.parse(ok.stdout).scores.summary.pairedSpeech).toBe(1);
    fs.writeFileSync(path.join(dir, 'one.txt'), 'секретный изменённый эталон');
    const failed = spawnSync(process.execPath, [cli, manifestFile, runFile], { encoding: 'utf8' });
    expect(failed.status).not.toBe(0); expect(failed.stdout).toBe(''); expect(failed.stderr).not.toContain('секретный');
  });
});
