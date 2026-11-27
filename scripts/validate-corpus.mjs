#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateCorpusManifest } from './lib/corpus-manifest.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/validate-corpus.mjs <manifest.json>');
  const file = path.resolve(process.argv[2]);
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Manifest exceeds 16 MiB');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const report = validateCorpusManifest(manifest, path.dirname(file));
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  // Parser and filesystem errors may contain private input or paths.
  const message = err instanceof SyntaxError ? 'Invalid JSON' :
    (err.code ? 'Could not read manifest' : err.message);
  console.error(`Corpus validation failed: ${message}`);
  process.exitCode = 1;
}
