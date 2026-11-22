// @vitest-environment node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { mayRetryOldInstaller } = require('../../scripts/e2e/nsis-retry.cjs');
const crash = { status: 1, stderr: 'Installer exited with code -1073741819', stdout: '', exeExists: false };

describe('повтор опубликованного установщика', () => {
  it('разрешён только при известном коде до обнаруженного окна и без установленного EXE', () => {
    expect(mayRetryOldInstaller(crash)).toBe(true);
    expect(mayRetryOldInstaller({ ...crash, stdout: 'Wizard window observed\n' })).toBe(false);
    expect(mayRetryOldInstaller({ ...crash, stdout: 'Wizard button: &Next >\n' })).toBe(false);
    expect(mayRetryOldInstaller({ ...crash, exeExists: true })).toBe(false);
    expect(mayRetryOldInstaller({ ...crash, exeExists: undefined })).toBe(false);
    expect(mayRetryOldInstaller({ ...crash, status: 0 })).toBe(false);
    expect(mayRetryOldInstaller({ ...crash, stderr: 'another failure' })).toBe(false);
  });

  it('полный GUI сообщает об обнаруженном окне до нажатия и не повторяет Next', () => {
    const script = readFileSync('scripts/e2e/nsis-gui.ps1', 'utf8');
    const full = script.split('\n$p = Start-Process')[1];
    expect(full.indexOf("Write-Output 'Wizard window observed'")).toBeGreaterThan(-1);
    expect(full.indexOf("Write-Output 'Wizard window observed'")).toBeLessThan(full.indexOf('[NsisGui]::Click($next.Handle)'));
    expect(full).toContain("$isNext = $null -ne $next -and $next.Text -match '^&?Next\\s*>'");
    expect(full).toContain('$repeatNext = $isNext -and $nextSent');
    expect(full).toContain('if (-not $mustWait -and -not $repeatNext');
    expect(full).toContain('if ($isNext) { $nextSent = $true }');
    expect(full).toContain("throw 'Timed out waiting for graphical NSIS installer'");
    expect(full).toContain("if ($p.ExitCode -ne 0) { throw");
  });
});
