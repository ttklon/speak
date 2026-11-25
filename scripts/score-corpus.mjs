#!/usr/bin/env node
/** Score local prepared reference/raw/final transcripts; never starts a model or uploads data. */
import fs from 'node:fs';
import { scoreCorpus } from './lib/corpus-score.mjs';

try {
  const args = process.argv.slice(2);
  const alignment = args.includes('--alignment');
  const paths = args.filter((arg) => arg !== '--alignment');
  if (paths.length !== 1 || args.filter((arg) => arg === '--alignment').length > 1) throw new Error('Usage: node scripts/score-corpus.mjs <corpus.json> [--alignment]');
  if (fs.statSync(paths[0]).size > 32 * 1024 * 1024) throw new Error('Input exceeds 32 MiB');
  const input = JSON.parse(fs.readFileSync(paths[0], 'utf8'));
  console.log(JSON.stringify(scoreCorpus(input, { alignment }), null, 2));
} catch (err) {
  console.error(`Corpus scoring failed: ${err.message}`);
  process.exitCode = 1;
}
