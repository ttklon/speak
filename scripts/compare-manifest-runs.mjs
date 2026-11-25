#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compareManifestRuns } from './lib/corpus-run.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 3 && !(args.length === 4 && args[3] === '--by-speaker')) throw new Error('Usage: node scripts/compare-manifest-runs.mjs <manifest.json> <baseline.json> <candidate.json> [--by-speaker]');
  const files = args.slice(0, 3).map((file) => path.resolve(file));
  if (fs.statSync(files[0]).size > 16 * 1024 * 1024 || files.slice(1).some((file) => fs.statSync(file).size > 32 * 1024 * 1024)) throw new Error('Input exceeds size limit');
  const [manifest, baseline, candidate] = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const report = compareManifestRuns(manifest, path.dirname(files[0]), baseline, candidate, { bySpeaker: args.length === 4 });
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  const message = err instanceof SyntaxError ? 'Invalid JSON' : (err.code ? 'Could not read input' : err.message);
  console.error(`Corpus comparison failed: ${message}`);
  process.exitCode = 1;
}
