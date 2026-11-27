#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { scoreManifestRun } from './lib/corpus-run.mjs';

try {
  const args = process.argv.slice(2);
  const alignment = args.includes('--alignment');
  const files = args.filter((arg) => arg !== '--alignment');
  if (files.length !== 2 || args.filter((arg) => arg === '--alignment').length > 1) throw new Error('Usage: node scripts/score-manifest-run.mjs <manifest.json> <run.json> [--alignment]');
  const manifestFile = path.resolve(files[0]), runFile = path.resolve(files[1]);
  if (fs.statSync(manifestFile).size > 16 * 1024 * 1024 || fs.statSync(runFile).size > 32 * 1024 * 1024) throw new Error('Input exceeds size limit');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const report = scoreManifestRun(manifest, path.dirname(manifestFile), run, { alignment });
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  const message = err instanceof SyntaxError ? 'Invalid JSON' : (err.code ? 'Could not read input' : err.message);
  console.error(`Corpus run failed: ${message}`);
  process.exitCode = 1;
}
