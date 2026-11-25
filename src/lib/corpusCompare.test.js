import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateCorpusManifest } from '../../scripts/lib/corpus-manifest.mjs';
import { compareManifestRuns } from '../../scripts/lib/corpus-run.mjs';

const dirs = [];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-compare-')); dirs.push(dir);
  const data = [['one', 'первое слово', 'speaker1'], ['two', 'второе слово', 'speaker2'], ['three', 'третье слово', 'speaker3'], ['silence', '', null], ['held', 'контроль', 'speaker4']];
  const clips = data.map(([id, reference, speaker]) => {
    const audio = 'fake audio ' + id;
    fs.writeFileSync(path.join(dir, `${id}.wav`), audio); fs.writeFileSync(path.join(dir, `${id}.txt`), reference);
    return { id, split: id === 'held' ? 'test' : 'dev', speaker, kind: speaker ? 'speech' : 'silence',
      audio: { path: `${id}.wav`, sha256: sha(audio) }, reference: { path: `${id}.txt`, sha256: sha(reference), author: 'author', reviewer: 'reviewer', status: 'approved' },
      rights: { source: 'private-source', license: 'consent', evidence: 'private-record', storage: true, evaluation: true, publishResults: false } };
  });
  const manifest = { version: 1, corpus: 'synthetic', revision: 'rev1', clips };
  const stage = (text) => ({ status: 'ok', text });
  const baseline = { version: 1, manifestFingerprint: validateCorpusManifest(manifest, dir).validatedContentSha256, split: 'dev',
    config: { model: 'model1', weightsSha256: sha('weight1'), engineRevision: 'engine1', pipelineRevision: 'pipe1', decodeConfigSha256: sha('config1'),
      environment: { platform: 'synthetic', hardware: 'synthetic', runtime: 'synthetic' }, randomness: { seed: null, deterministic: false } },
    results: data.filter(([id]) => id !== 'held').map(([id, text]) => ({ id, raw: stage(text), final: stage(text) })) };
  return { dir, manifest, baseline, candidate: structuredClone(baseline) };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('сравнение прогонов на общей когорте', () => {
  it('не сравнивает разные выборки: пересекает успех всех этапов и отдельно учитывает причины исключений', () => {
    const { dir, manifest, baseline, candidate } = setup();
    baseline.results[0].raw = { status: 'error' };
    candidate.results[1].final = { status: 'error' };
    candidate.results[2].raw.text = 'ошибка слово';
    baseline.results[3].final = { status: 'error' }; candidate.results[3].raw = { status: 'error' };
    candidate.config.model = 'model2'; candidate.config.environment.hardware = 'other-cpu';
    const report = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(report).toMatchObject({ complete: false, cohorts: { speech: { total: 3, common: 1, baselineOnlyFailed: 1, candidateOnlyFailed: 1, bothFailed: 0 },
      silence: { total: 1, common: 0, baselineOnlyFailed: 0, candidateOnlyFailed: 0, bothFailed: 1 } },
      baseline: { metrics: { raw: { errors: 0, referenceWords: 2, wer: 0 }, final: { errors: 0 } } },
      candidate: { metrics: { raw: { errors: 1, referenceWords: 2, wer: 0.5 }, final: { errors: 0 } } },
      delta: { raw: { errors: 1, wer: 0.5 }, final: { errors: 0, wer: 0 }, silence: { rawFalsePositives: null } } });
    expect(report.configDifferences).toEqual(['model', 'environment.hardware']);
    const json = JSON.stringify(report);
    for (const secret of ['третье', 'ошибка слово', 'private-record', 'speaker1']) expect(json).not.toContain(secret);
  });
  it('полный парный набор отдельно сравнивает речь и ложные срабатывания на тишине', () => {
    const { dir, manifest, baseline, candidate } = setup();
    candidate.results[3].raw.text = 'слышится фраза';
    const report = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(report).toMatchObject({ complete: true, cohorts: { speech: { total: 3, common: 3 }, silence: { total: 1, common: 1 } },
      baseline: { metrics: { raw: { wer: 0 }, silence: { rawFalsePositives: 0 } } },
      candidate: { metrics: { raw: { wer: 0 }, silence: { rawFalsePositives: 1 } } },
      delta: { raw: { wer: 0 }, silence: { rawFalsePositives: 1, rawWords: 2 } } });
    expect(report.configDifferences).toEqual([]);
  });
  it('агрегирует по числу слов и симметрично меняет знак при перестановке прогонов', () => {
    const { dir, manifest, baseline, candidate } = setup();
    baseline.results[0].raw.text = 'другое слово';
    const forward = compareManifestRuns(manifest, dir, baseline, candidate);
    const reversed = compareManifestRuns(manifest, dir, candidate, baseline);
    expect(forward.baseline.metrics.raw).toMatchObject({ errors: 1, referenceWords: 6, wer: 1 / 6 });
    expect(forward.candidate.metrics.raw.wer).toBe(0);
    expect(forward.delta.raw.wer).toBe(-1 / 6);
    expect(reversed.delta.raw.wer).toBe(1 / 6);
    expect(reversed.delta.raw.errors).toBe(1);
    expect(reversed.cohorts).toEqual(forward.cohorts);
  });
  it('при отказах обеих моделей отдельные клипы не попадают в общий итог', () => {
    const { dir, manifest, baseline, candidate } = setup();
    baseline.results[0].final = { status: 'error' }; candidate.results[0].raw = { status: 'error' };
    const report = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(report.cohorts.speech).toEqual({ total: 3, common: 2, baselineOnlyFailed: 0, candidateOnlyFailed: 0, bothFailed: 1 });
    expect(report.baseline.metrics.raw.referenceWords).toBe(4);
    expect(report.candidate.metrics.raw.referenceWords).toBe(4);
  });
  it('пустое пересечение речи не трактует как нулевую ошибку', () => {
    const { dir, manifest, baseline, candidate } = setup();
    for (const row of baseline.results.slice(0, 3)) row.raw = { status: 'error' };
    const report = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(report).toMatchObject({ cohorts: { speech: { total: 3, common: 0, baselineOnlyFailed: 3 } },
      baseline: { metrics: { raw: { wer: null } } }, candidate: { metrics: { raw: { wer: null } } },
      delta: { raw: { errors: null, wer: null, cer: null } } });
  });
  it('не сравнивает разные корпуса, разделы или неполные результаты', () => {
    const { dir, manifest, baseline, candidate } = setup();
    candidate.manifestFingerprint = sha('other'); expect(() => compareManifestRuns(manifest, dir, baseline, candidate)).toThrow(/fingerprint/i);
    candidate.manifestFingerprint = baseline.manifestFingerprint; candidate.split = 'test'; expect(() => compareManifestRuns(manifest, dir, baseline, candidate)).toThrow(/split/i);
    candidate.split = 'dev'; candidate.results.pop(); expect(() => compareManifestRuns(manifest, dir, baseline, candidate)).toThrow(/results/i);
    candidate.results = structuredClone(baseline.results); fs.writeFileSync(path.join(dir, 'one.txt'), 'подмена');
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate)).toThrow(/hash/i);
  });
  it('CLI не раскрывает транскрипты и не печатает частичный отчёт при ошибке', () => {
    const { dir, manifest, baseline, candidate } = setup();
    const paths = ['manifest', 'baseline', 'candidate'].map((name) => path.join(dir, `${name}.json`));
    for (const [index, obj] of [manifest, baseline, candidate].entries()) fs.writeFileSync(paths[index], JSON.stringify(obj));
    const cli = path.resolve('scripts/compare-manifest-runs.mjs');
    const ok = spawnSync(process.execPath, [cli, ...paths], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0); expect(JSON.parse(ok.stdout).complete).toBe(true); expect(ok.stdout).not.toContain('первое');
    candidate.results.pop(); fs.writeFileSync(paths[2], JSON.stringify(candidate));
    const fail = spawnSync(process.execPath, [cli, ...paths], { encoding: 'utf8' });
    expect(fail.status).not.toBe(0); expect(fail.stdout).toBe(''); expect(fail.stderr).not.toContain('первое');
  });
});
