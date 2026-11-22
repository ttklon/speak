// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync('scripts/e2e/nsis-gui.ps1', 'utf8');
const probe = script.split('if ($ProbeCount -gt 0) {')[1]?.split('\n$p = Start-Process')[0];

describe('проверка мастера без установки', () => {
  it('остаётся ASCII для Windows PowerShell 5.1 и работает только в CI', () => {
    expect(/^[\x00-\x7f]*$/.test(script)).toBe(true);
    expect(script).toContain("$env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true'");
    expect(probe).toContain('if ($ProbeCount -gt 50)');
  });

  it('шаблон Next распознаёт подпись кнопки, но не Install', () => {
    const pattern = probe.match(/\$_.Text -match '([^']*Next[^']*)'/)?.[1];
    expect(pattern).toBeDefined();
    const next = new RegExp(pattern, 'i');
    expect(next.test('&Next >')).toBe(true);
    expect(next.test('Next>')).toBe(true);
    expect(next.test('&Install')).toBe(false);
  });

  it('один раз нажимает только Next на первом экране и ждёт поле каталога, не нажимая Install', () => {
    expect(probe).toContain("$_.Text -match 'Choose Installation Options'");
    expect(probe).toContain("$_.Text -match '^&?Next\\s*>'");
    expect(probe).toContain('if (-not $advanced -and $null -ne $options -and $null -ne $next)');
    expect(probe.match(/\[NsisGui\]::Click\(/g)).toHaveLength(1);
    expect(probe).toContain("$_.Text -match 'Choose Install Location'");
    expect(probe).toContain("$_.Class -eq 'Edit' -and $_.Id -eq 1019");
    expect(probe).toContain('if (-not $directoryReady) { throw');
    expect(probe).toContain('if ($probe.HasExited) { throw');
    expect(probe).toContain('Stop-Process -Id $probe.Id -Force');
    expect(probe).not.toContain('[NsisGui]::SetText(');
  });
});
