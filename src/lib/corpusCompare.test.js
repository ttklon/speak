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
  it('опционально сравнивает дикторов на той же общей когорте и показывает исключения', () => {
    const { dir, manifest, baseline, candidate } = setup();
    manifest.clips.find((row) => row.id === 'two').speaker = 'Speaker1';
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    candidate.results.find((row) => row.id === 'one').raw.text = 'другое слово';
    candidate.results.find((row) => row.id === 'two').final = { status: 'error' };
    baseline.results.find((row) => row.id === 'three').raw = { status: 'error' };
    const normal = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(normal).not.toHaveProperty('speakers');
    const report = compareManifestRuns(manifest, dir, baseline, candidate, { bySpeaker: true });
    expect(report.speakers).toHaveLength(2);
    expect(report.speakers[0]).toMatchObject({ speaker: 'speaker1',
      cohort: { total: 2, common: 1, baselineOnlyFailed: 0, candidateOnlyFailed: 1, bothFailed: 0 },
      baseline: { raw: { errors: 0, referenceWords: 2, wer: 0 } },
      candidate: { raw: { errors: 1, referenceWords: 2, wer: 0.5 } },
      delta: { raw: { errors: 1, wer: 0.5 }, final: { errors: 0, wer: 0 } } });
    expect(report.speakers[1]).toMatchObject({ speaker: 'speaker3', cohort: { total: 1, common: 0, baselineOnlyFailed: 1 },
      baseline: { raw: { wer: null } }, candidate: { raw: { wer: null } }, delta: { raw: { errors: null, wer: null } } });
    expect(JSON.stringify(report.speakers)).not.toMatch(/первое|другое|private-record|silence|speaker4/);
  });
  it('срез по диктору считает сумму ошибок по эталонным словам, а не среднее WER клипов', () => {
    const { dir, manifest, baseline, candidate } = setup();
    manifest.clips.find((row) => row.id === 'two').speaker = 'speaker1';
    fs.writeFileSync(path.join(dir, 'two.txt'), 'второе слово третье');
    manifest.clips.find((row) => row.id === 'two').reference.sha256 = sha('второе слово третье');
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    for (const run of [baseline, candidate]) run.results.find((row) => row.id === 'two').raw.text = 'второе слово третье';
    candidate.results.find((row) => row.id === 'one').raw.text = 'другое слово';
    const report = compareManifestRuns(manifest, dir, baseline, candidate, { bySpeaker: true });
    expect(report.speakers[0].candidate.raw).toMatchObject({ errors: 1, referenceWords: 5, wer: 0.2 });
    expect(report.speakers[0].delta.raw.wer).toBe(0.2);
    const swapped = compareManifestRuns(manifest, dir, candidate, baseline, { bySpeaker: true });
    expect(swapped.speakers[0].delta.raw.wer).toBe(-0.2);
  });
  it('порядок срезов устойчив к порядку клипов и результатов; при отсутствии речи список пуст', () => {
    const { dir, manifest, baseline, candidate } = setup();
    candidate.results.find((row) => row.id === 'two').final = { status: 'error' };
    const options = { bySpeaker: true };
    const first = compareManifestRuns(manifest, dir, baseline, candidate, options);
    manifest.clips.reverse(); baseline.results.reverse(); candidate.results.reverse();
    const second = compareManifestRuns(manifest, dir, baseline, candidate, options);
    expect(second.speakers).toEqual(first.speakers);
    const onlySilence = { ...manifest, clips: manifest.clips.filter((row) => row.kind === 'silence') };
    const fingerprint = validateCorpusManifest(onlySilence, dir).validatedContentSha256;
    for (const run of [baseline, candidate]) { run.manifestFingerprint = fingerprint; run.results = run.results.filter((row) => row.id === 'silence'); }
    const silence = compareManifestRuns(onlySilence, dir, baseline, candidate, options);
    expect(silence.speakers).toEqual([]);
    expect(silence.cohorts.silence.common).toBe(1);
  });
  it('не разрешает неявно включить раскрывающий идентификаторы режим значением-строкой', () => {
    const { dir, manifest, baseline, candidate } = setup();
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate, { bySpeaker: 'false' })).toThrow(/speaker option/i);
  });
  it('срезы по условиям включают речь и тишину с общей когортой и исключениями', () => {
    const { dir, manifest, baseline, candidate } = setup();
    manifest.version = 2;
    const tags = { one: ['Noise', 'room'], two: ['noise'], three: ['quiet'], silence: ['noise'], held: ['room'] };
    for (const clip of manifest.clips) clip.conditions = tags[clip.id];
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    candidate.results.find((row) => row.id === 'one').raw.text = 'другое слово';
    baseline.results.find((row) => row.id === 'two').final = { status: 'error' };
    candidate.results.find((row) => row.id === 'silence').raw.text = 'ложная фраза';
    const normal = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(normal).not.toHaveProperty('conditions');
    const report = compareManifestRuns(manifest, dir, baseline, candidate, { byCondition: true, bySpeaker: true });
    expect(report.conditions.map((row) => row.condition)).toEqual(['noise', 'quiet', 'room']);
    expect(report.conditions[0]).toMatchObject({ condition: 'noise',
      cohorts: { speech: { total: 2, common: 1, baselineOnlyFailed: 1 }, silence: { total: 1, common: 1 } },
      baseline: { raw: { errors: 0, wer: 0 }, silence: { rawFalsePositives: 0 } },
      candidate: { raw: { errors: 1, wer: 0.5 }, silence: { rawFalsePositives: 1, rawWords: 2 } },
      delta: { raw: { errors: 1, wer: 0.5 }, silence: { rawFalsePositives: 1, rawWords: 2 } } });
    expect(report.conditions[2].cohorts.speech.total).toBe(1); // условие clip из test не входит в dev
    expect(JSON.stringify(report.conditions)).not.toMatch(/первое|другое|private-record|speaker1/);
    const swapped = compareManifestRuns(manifest, dir, candidate, baseline, { byCondition: true });
    expect(swapped.conditions[0].delta.raw.wer).toBe(-0.5);
    expect(swapped.conditions[0].cohorts.speech.candidateOnlyFailed).toBe(1);
  });
  it('условия нельзя запросить у v1 или без явного логического флага', () => {
    const { dir, manifest, baseline, candidate } = setup();
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate, { byCondition: true })).toThrow(/version 2/i);
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate, { byCondition: 'false' })).toThrow(/condition option/i);
  });
  it('CLI включает срезы условий и дикторов только явными уникальными флагами', () => {
    const { dir, manifest, baseline, candidate } = setup(); manifest.version = 2;
    for (const clip of manifest.clips) clip.conditions = ['synthetic'];
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    const paths = ['manifest', 'baseline', 'candidate'].map((name) => path.join(dir, `${name}.json`));
    for (const [index, obj] of [manifest, baseline, candidate].entries()) fs.writeFileSync(paths[index], JSON.stringify(obj));
    const cli = path.resolve('scripts/compare-manifest-runs.mjs');
    const run = (flags) => spawnSync(process.execPath, [cli, ...paths, ...flags], { encoding: 'utf8' });
    const normal = run([]); expect(JSON.parse(normal.stdout)).not.toHaveProperty('conditions');
    const both = run(['--by-condition', '--by-speaker']); expect(both.status, both.stderr).toBe(0);
    expect(JSON.parse(both.stdout)).toMatchObject({ conditions: [{ condition: 'synthetic' }], speakers: expect.any(Array) });
    const repeated = run(['--by-condition', '--by-condition']); expect(repeated.status).not.toBe(0); expect(repeated.stdout).toBe('');
    manifest.clips[0].conditions = ['changed']; fs.writeFileSync(paths[0], JSON.stringify(manifest));
    const tampered = run(['--by-condition']); expect(tampered.status).not.toBe(0); expect(tampered.stdout).toBe('');
  });
  it('опциональная неопределённость использует только общую речь и не раскрывает ID', () => {
    const { dir, manifest, baseline, candidate } = setup();
    baseline.results.find((row) => row.id === 'one').raw = { status: 'error' };
    candidate.results.find((row) => row.id === 'two').raw.text = 'ошибка слово';
    candidate.results.find((row) => row.id === 'silence').raw.text = 'ложная фраза';
    expect(compareManifestRuns(manifest, dir, baseline, candidate)).not.toHaveProperty('bootstrap');
    const report = compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: true });
    expect(report.bootstrap).toMatchObject({ speakers: 2, speechClips: 2, replicates: 1000,
      interval: { raw: { wer: [0, 0.5] }, final: { wer: [0, 0] } } });
    expect(JSON.stringify(report.bootstrap)).not.toMatch(/speaker1|speaker2|ошибка слово|ложная фраза|private-record/);
    manifest.clips.reverse(); baseline.results.reverse(); candidate.results.reverse();
    expect(compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: true }).bootstrap).toEqual(report.bootstrap);
    candidate.results.find((row) => row.id === 'three').raw = { status: 'error' };
    expect(compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: true }).bootstrap).toMatchObject({ speakers: 1, speechClips: 1, interval: null });
  });
  it('ресэмплирует несколько клипов одного диктора одним блоком и не учитывает исключённого', () => {
    const { dir, manifest, baseline, candidate } = setup();
    manifest.clips.find((row) => row.id === 'two').speaker = 'Speaker1';
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    candidate.results.find((row) => row.id === 'one').raw.text = 'ошибка слово';
    candidate.results.find((row) => row.id === 'two').raw.text = 'ошибка слово';
    const out = compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: true }).bootstrap;
    expect(out).toMatchObject({ speakers: 2, speechClips: 3, interval: { raw: { wer: [0, 0.5] } } });
    candidate.results.find((row) => row.id === 'three').final = { status: 'error' };
    const excluded = compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: true }).bootstrap;
    expect(excluded).toMatchObject({ speakers: 1, speechClips: 2, interval: null });
  });
  it('сравнивает буквальные токены только на общей успешной речи и раздельно по этапам', () => {
    const { dir, manifest, baseline, candidate } = setup();
    fs.writeFileSync(path.join(dir, 'one.txt'), 'не отправляй 15 15 раз раз');
    manifest.clips.find((row) => row.id === 'one').reference.sha256 = sha('не отправляй 15 15 раз раз');
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    baseline.manifestFingerprint = fingerprint; candidate.manifestFingerprint = fingerprint;
    const first = (run) => run.results.find((row) => row.id === 'one');
    first(baseline).raw.text = 'отправляй 15 раз'; first(baseline).final.text = 'не отправляй 15 15 раз раз';
    first(candidate).raw.text = 'не отправляй 15 15 раз раз'; first(candidate).final.text = 'отправляй 15 раз';
    baseline.results.find((row) => row.id === 'two').raw = { status: 'error' };
    candidate.results.find((row) => row.id === 'silence').raw.text = 'не 15';
    const normal = compareManifestRuns(manifest, dir, baseline, candidate);
    expect(normal).not.toHaveProperty('tokenDiagnostics');
    const report = compareManifestRuns(manifest, dir, baseline, candidate, { tokenDiagnostics: true });
    expect(report.tokenDiagnostics).toMatchObject({ speechClips: 2,
      raw: { negation: { referenceOccurrences: 1, baseline: { referenceExcess: 1 }, candidate: { referenceExcess: 0 }, delta: { referenceExcess: -1 } },
        asciiDigits: { referenceOccurrences: 2, baseline: { referenceExcess: 1 }, candidate: { referenceExcess: 0 } } },
      final: { negation: { baseline: { referenceExcess: 0 }, candidate: { referenceExcess: 1 }, delta: { referenceExcess: 1 } } } });
    expect(JSON.stringify(report.tokenDiagnostics)).not.toMatch(/отправляй|speaker|"15"/);
    for (const row of baseline.results) row.raw = { status: 'error' };
    expect(compareManifestRuns(manifest, dir, baseline, candidate, { tokenDiagnostics: true }).tokenDiagnostics)
      .toEqual({ speechClips: 0, raw: null, final: null });
  });
  it('CLI не включает диагностику без флага и не принимает повторный флаг', () => {
    const { dir, manifest, baseline, candidate } = setup();
    const paths = ['manifest', 'baseline', 'candidate'].map((name) => path.join(dir, `${name}.json`));
    for (const [index, obj] of [manifest, baseline, candidate].entries()) fs.writeFileSync(paths[index], JSON.stringify(obj));
    const cli = path.resolve('scripts/compare-manifest-runs.mjs');
    const run = (flags) => spawnSync(process.execPath, [cli, ...paths, ...flags], { encoding: 'utf8' });
    expect(JSON.parse(run([]).stdout)).not.toHaveProperty('tokenDiagnostics');
    const output = run(['--token-diagnostics']); expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).tokenDiagnostics.speechClips).toBe(3); expect(output.stdout).not.toContain('первое слово');
    const fail = run(['--token-diagnostics', '--token-diagnostics']); expect(fail.status).not.toBe(0); expect(fail.stdout).toBe('');
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate, { tokenDiagnostics: 'false' })).toThrow(/token.*option/i);
  });
  it('CLI разрешает бутстреп лишь явным флагом и не раскрывает ID', () => {
    const { dir, manifest, baseline, candidate } = setup();
    const paths = ['manifest', 'baseline', 'candidate'].map((name) => path.join(dir, `${name}.json`));
    for (const [index, obj] of [manifest, baseline, candidate].entries()) fs.writeFileSync(paths[index], JSON.stringify(obj));
    const cli = path.resolve('scripts/compare-manifest-runs.mjs');
    const run = (flags) => spawnSync(process.execPath, [cli, ...paths, ...flags], { encoding: 'utf8' });
    const ok = run(['--bootstrap-speaker']); expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).bootstrap.speakers).toBe(3); expect(ok.stdout).not.toContain('speaker1');
    const bad = run(['--bootstrap-speaker', '--bootstrap-speaker']); expect(bad.status).not.toBe(0); expect(bad.stdout).toBe('');
    expect(() => compareManifestRuns(manifest, dir, baseline, candidate, { bootstrapSpeakers: 'false' })).toThrow(/bootstrap option/i);
  });
  it('CLI срезы по дикторам включаются только явно, неизвестные флаги отклоняются', () => {
    const { dir, manifest, baseline, candidate } = setup();
    const paths = ['manifest', 'baseline', 'candidate'].map((name) => path.join(dir, `${name}.json`));
    for (const [index, obj] of [manifest, baseline, candidate].entries()) fs.writeFileSync(paths[index], JSON.stringify(obj));
    const cli = path.resolve('scripts/compare-manifest-runs.mjs');
    const options = { cwd: os.tmpdir(), encoding: 'utf8' };
    const ordinary = spawnSync(process.execPath, [cli, ...paths], options);
    expect(ordinary.status).toBe(0); expect(ordinary.stdout).not.toContain('speaker1');
    const sliced = spawnSync(process.execPath, [cli, ...paths, '--by-speaker'], options);
    expect(sliced.status, sliced.stderr).toBe(0); expect(JSON.parse(sliced.stdout).speakers).toHaveLength(3);
    expect(sliced.stdout).not.toContain('первое слово');
    const invalid = spawnSync(process.execPath, [cli, ...paths, '--bad'], options);
    expect(invalid.status).not.toBe(0); expect(invalid.stdout).toBe('');
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
