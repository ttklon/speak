import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { words } from './word-error.mjs';

const MAX_CLIPS = 10_000;
const MAX_AUDIO = 1024 * 1024 * 1024;
const MAX_REFERENCE = 256 * 1024;
const splits = ['dev', 'validation', 'test'];
const key = (value) => value.normalize('NFC').trim().toLocaleLowerCase('en');
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value);
const detail = (value) => typeof value === 'string' && !!value.trim() && value.length <= 2000;
function fail(message, index) { throw new Error(`${message}${index === undefined ? '' : ` (clip ${index + 1})`}`); }
function within(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function fileData(base, entry, maxSize, readContent, index) {
  if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.includes('\0') ||
      path.posix.isAbsolute(entry.path) || /^[A-Za-z]:/.test(entry.path) || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) fail('Invalid file path', index);
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail('Invalid SHA-256', index);
  const candidate = path.join(base, ...entry.path.split('/'));
  if (!within(base, candidate)) fail('Invalid file path', index);
  let parent;
  try { parent = fs.realpathSync(path.dirname(candidate)); } catch { fail('File not found', index); }
  if (parent !== base && !within(base, parent)) fail('File path escapes corpus directory', index);
  let actual;
  try { actual = fs.realpathSync(candidate); } catch { fail('File not found', index); }
  if (!within(base, actual)) fail('File path escapes corpus directory', index);
  let fd;
  try {
    fd = fs.openSync(actual, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxSize || (maxSize === MAX_AUDIO && stat.size === 0)) fail('Invalid file size or type', index);
    const hash = createHash('sha256');
    const chunks = readContent ? [] : null;
    const buf = Buffer.allocUnsafe(64 * 1024);
    let size = 0, count;
    while ((count = fs.readSync(fd, buf, 0, buf.length, null)) !== 0) {
      size += count;
      if (size > maxSize) fail('Invalid file size or type', index);
      hash.update(buf.subarray(0, count));
      if (chunks) chunks.push(Buffer.from(buf.subarray(0, count)));
    }
    if (hash.digest('hex') !== entry.sha256) fail('File hash mismatch', index);
    if (chunks) {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { fail('Invalid reference UTF-8', index); }
    }
  } catch (err) {
    // Internal validation errors contain no input values. Never leak OS paths.
    if (err.message?.endsWith(`(clip ${index + 1})`)) throw err;
    fail('Could not read file', index);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Checks declared provenance and local bytes, not the truth of permissions,
 * reviewer independence or the content of audio. The report omits clip data. */
function validate(manifest, directory, selectedSplit = null) {
  if (selectedSplit !== null && !splits.includes(selectedSplit)) fail('Invalid selected split');
  if (!manifest || manifest.version !== 1 || !identifier(manifest.corpus) || !identifier(manifest.revision) ||
      !Array.isArray(manifest.clips) || !manifest.clips.length || manifest.clips.length > MAX_CLIPS) fail('Invalid manifest');
  let base;
  try { base = fs.realpathSync(directory); if (!fs.statSync(base).isDirectory()) fail('Invalid corpus directory'); }
  catch { fail('Invalid corpus directory'); }
  const ids = new Set(), speakers = new Map(), hashes = new Set(), fingerprintRows = [];
  const selected = [];
  let selectedBytes = 0;
  const report = { version: 1, corpus: manifest.corpus, revision: manifest.revision, clips: manifest.clips.length,
    speech: 0, silence: 0, splits: { dev: 0, validation: 0, test: 0 }, publishResultsAllowed: true };
  manifest.clips.forEach((clip, i) => {
    if (!clip || !identifier(clip.id) || ids.has(key(clip.id))) fail('Invalid or duplicate clip ID', i);
    ids.add(key(clip.id));
    if (!splits.includes(clip.split) || !['speech', 'silence'].includes(clip.kind)) fail('Invalid split or kind', i);
    if ((clip.kind === 'speech' && !identifier(clip.speaker)) || (clip.kind === 'silence' && clip.speaker !== null)) fail('Invalid speaker', i);
    if (clip.speaker !== null) {
      const speaker = key(clip.speaker);
      if (speakers.has(speaker) && speakers.get(speaker) !== clip.split) fail('Speaker occurs in multiple splits', i);
      speakers.set(speaker, clip.split);
    }
    const ref = clip.reference;
    if (!ref || !identifier(ref.author) || !identifier(ref.reviewer) || key(ref.author) === key(ref.reviewer) || ref.status !== 'approved') fail('Invalid reference review', i);
    const rights = clip.rights;
    if (!rights || !detail(rights.source) || !detail(rights.license) || !detail(rights.evidence) || rights.storage !== true || rights.evaluation !== true || typeof rights.publishResults !== 'boolean') fail('Invalid rights declaration', i);
    fileData(base, clip.audio, MAX_AUDIO, false, i);
    if (hashes.has(clip.audio.sha256)) fail('Duplicate audio', i);
    hashes.add(clip.audio.sha256);
    const text = fileData(base, ref, MAX_REFERENCE, true, i);
    if ((clip.kind === 'speech' && !words(text).length) || (clip.kind === 'silence' && text.trim() !== '')) fail('Reference does not match kind', i);
    if (clip.split === selectedSplit) {
      selectedBytes += Buffer.byteLength(text, 'utf8');
      if (selectedBytes > 32 * 1024 * 1024 || text.length > 200_000) fail('Selected reference size exceeds scoring limit', i);
      selected.push({ id: clip.id, reference: text, speaker: clip.speaker });
    }
    // Fixed field order makes the digest independent of JSON key and clip order.
    fingerprintRows.push([clip.id, clip.split, clip.speaker, clip.kind,
      clip.audio.path, clip.audio.sha256, ref.path, ref.sha256, ref.author, ref.reviewer, ref.status,
      rights.source, rights.license, rights.evidence, rights.storage, rights.evaluation, rights.publishResults]);
    report[clip.kind]++;
    report.splits[clip.split]++;
    report.publishResultsAllowed &&= rights.publishResults;
  });
  fingerprintRows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  report.validatedContentSha256 = createHash('sha256').update(JSON.stringify([manifest.version, manifest.corpus, manifest.revision, fingerprintRows])).digest('hex');
  return { report, selected };
}

export function validateCorpusManifest(manifest, directory) {
  return validate(manifest, directory).report;
}

/** References stay in memory and are returned only for the explicitly selected split. */
export function loadCorpusForScoring(manifest, directory, split) {
  if (!splits.includes(split)) fail('Invalid selected split');
  const result = validate(manifest, directory, split);
  if (!result.selected.length) fail('Selected split is empty');
  return result;
}
