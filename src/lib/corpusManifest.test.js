import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateCorpusManifest } from '../../scripts/lib/corpus-manifest.mjs';

const dirs = [];
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-corpus-'));
  dirs.push(dir);
  const audio = Buffer.from('synthetic bytes, not a wav');
  const ref = Buffer.from('не секретная фраза\n');
  fs.writeFileSync(path.join(dir, 'one.wav'), audio);
  fs.writeFileSync(path.join(dir, 'one.txt'), ref);
  const row = { id: 'clip-1', split: 'dev', speaker: 'speaker-1', kind: 'speech',
    audio: { path: 'one.wav', sha256: digest(audio) },
    reference: { path: 'one.txt', sha256: digest(ref), author: 'annotator-1', reviewer: 'reviewer-1', status: 'approved' },
    rights: { source: 'local consent record', license: 'consent', evidence: 'record-1', storage: true, evaluation: true, publishResults: false } };
  return { dir, manifest: { version: 1, corpus: 'synthetic', revision: 'rev1', clips: [row] } };
}
function second(dir, manifest) {
  const row = structuredClone(manifest.clips[0]);
  row.id = 'clip-2'; row.speaker = 'speaker-2'; row.split = 'test';
  row.audio.path = 'two.wav'; fs.writeFileSync(path.join(dir, row.audio.path), 'second fake wav'); row.audio.sha256 = digest('second fake wav');
  row.reference.path = 'two.txt'; fs.writeFileSync(path.join(dir, row.reference.path), 'другая фраза'); row.reference.sha256 = digest('другая фраза');
  manifest.clips.push(row); return row;
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('проверка локального манифеста корпуса', () => {
  it('проверяет хэши и отчёт не содержит путей, эталона, разрешений или идентификаторов говорящих', () => {
    const { dir, manifest } = setup(); second(dir, manifest);
    const report = validateCorpusManifest(manifest, dir);
    expect(report).toMatchObject({ version: 1, corpus: 'synthetic', revision: 'rev1', clips: 2, splits: { dev: 1, validation: 0, test: 1 }, publishResultsAllowed: false });
    const json = JSON.stringify(report);
    for (const secret of ['one.wav', 'секретная', 'speaker-1', 'annotator-1', 'record-1']) expect(json).not.toContain(secret);
  });
  it('создаёт стабильный отпечаток проверенных полей и меняет его при изменении прав', () => {
    const { dir, manifest } = setup(); second(dir, manifest);
    const fingerprint = validateCorpusManifest(manifest, dir).validatedContentSha256;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    manifest.clips.reverse();
    expect(validateCorpusManifest(manifest, dir).validatedContentSha256).toBe(fingerprint);
    manifest.clips[0].rights.publishResults = true;
    expect(validateCorpusManifest(manifest, dir).validatedContentSha256).not.toBe(fingerprint);
  });
  it('отклоняет недействительный UTF-8 и совпадение авторов без учёта регистра', () => {
    const { dir, manifest } = setup(); const row = manifest.clips[0];
    row.reference.reviewer = 'ANNOTATOR-1'; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/review/i);
    row.reference.reviewer = 'other'; const bad = Buffer.from([0xff]);
    fs.writeFileSync(path.join(dir, 'one.txt'), bad); row.reference.sha256 = digest(bad);
    expect(() => validateCorpusManifest(manifest, dir)).toThrow(/UTF-8/i);
  });
  it('отклоняет утечки дикторов и идентичных записей между разделами', () => {
    const { dir, manifest } = setup(); const row = second(dir, manifest);
    row.speaker = 'speaker-1'; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/speaker.*split/i);
    row.speaker = 'speaker-2'; fs.copyFileSync(path.join(dir, 'one.wav'), path.join(dir, row.audio.path)); row.audio.sha256 = manifest.clips[0].audio.sha256;
    expect(() => validateCorpusManifest(manifest, dir)).toThrow(/duplicate audio/i);
  });
  it('отклоняет изменённые, отсутствующие и подменённые файлы без раскрытия путей', () => {
    const { dir, manifest } = setup(); fs.writeFileSync(path.join(dir, 'one.txt'), 'другой текст');
    expect(() => validateCorpusManifest(manifest, dir)).toThrow(/hash/i);
    fs.unlinkSync(path.join(dir, 'one.wav')); expect(() => validateCorpusManifest(manifest, dir)).toThrow(/file/i);
    manifest.clips[0].audio.path = '../secret.wav'; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/path/i);
  });
  it('не следует за ссылками, выходящими за каталог манифеста', () => {
    const { dir, manifest } = setup();
    fs.symlinkSync(os.tmpdir(), path.join(dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    manifest.clips[0].audio.path = 'external/outside.wav';
    expect(() => validateCorpusManifest(manifest, dir)).toThrow(/path/i);
  });
  it('требует независимую проверку, разрешения и понятный тип эталона', () => {
    const { dir, manifest } = setup(); const row = manifest.clips[0];
    row.reference.reviewer = row.reference.author; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/review/i);
    row.reference.reviewer = 'reviewer-1'; row.reference.status = 'disputed'; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/review/i);
    row.reference.status = 'approved'; row.rights.evaluation = false; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/rights/i);
    row.rights.evaluation = true; row.kind = 'silence'; row.speaker = null; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/reference/i);
  });
  it('тишина не подменяет неразмеченную речь; права публикации проверяются отдельно', () => {
    const { dir, manifest } = setup(); const row = manifest.clips[0];
    row.kind = 'silence'; row.speaker = null; fs.writeFileSync(path.join(dir, 'one.txt'), '  \n'); row.reference.sha256 = digest('  \n');
    row.rights.publishResults = true;
    expect(validateCorpusManifest(manifest, dir)).toMatchObject({ speech: 0, silence: 1, publishResultsAllowed: true });
    row.kind = 'speech'; row.speaker = 'speaker-1'; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/reference/i);
  });
  it('отклоняет неизвестные версии, пустые корпуса и повторяющиеся ID', () => {
    const { dir, manifest } = setup();
    expect(() => validateCorpusManifest({ ...manifest, version: 2 }, dir)).toThrow();
    expect(() => validateCorpusManifest({ ...manifest, clips: [] }, dir)).toThrow();
    const row = second(dir, manifest); row.id = manifest.clips[0].id; expect(() => validateCorpusManifest(manifest, dir)).toThrow(/ID/i);
  });
  it('CLI использует каталог манифеста, не текущий каталог; ошибка не содержит эталона', () => {
    const { dir, manifest } = setup(); const file = path.join(dir, 'corpus.json'); fs.writeFileSync(file, JSON.stringify(manifest));
    const cli = path.resolve('scripts/validate-corpus.mjs');
    const run = spawnSync(process.execPath, [cli, file], { cwd: os.tmpdir(), encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0); expect(JSON.parse(run.stdout).clips).toBe(1);
    fs.writeFileSync(path.join(dir, 'one.txt'), 'не секретная фраза изменилась');
    const fail = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' });
    expect(fail.status).not.toBe(0); expect(fail.stderr).not.toContain('секретная'); expect(fail.stdout).toBe('');
  });
});
