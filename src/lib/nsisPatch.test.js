import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { patch } = require('../../scripts/nsis/patch-builder.cjs');
const template = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/multiUser.nsh');

describe('NSIS per-user installation path', () => {
  it('backports the bounded copy to the installed builder template and is idempotent', () => {
    const result = patch(fs.readFileSync(template, 'utf8'));
    expect(result).toContain('KERNEL32::lstrcpynW');
    expect(result).not.toContain("System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'");
    expect(result).toContain('OLE32::CoTaskMemFree(p r2)');
    expect(patch(result)).toBe(result);
  });
  it('fails closed for an unknown template', () => {
    expect(() => patch('an unexpected template')).toThrow(/template changed/);
  });
});
