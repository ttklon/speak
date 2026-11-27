#!/usr/bin/env node
/** Проверка реального CLR layout трёх реализаций Win32 INPUT на Windows. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { HELPER_SOURCE } = require('../electron/winInput.cjs');
const { buildHostScript } = require('../electron/inputHost.cjs');
const { buildScript } = require('../electron/sendInput.cjs');

if (process.platform !== 'win32') {
  console.log('Проверка CLR layout запускается на Windows.');
  process.exit(0);
}
function embeddedSource(script) {
  const result = script.match(/Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@/);
  assert.ok(result, 'не найден C# для Add-Type');
  return result[1];
}
for (const [label, source, type] of [
  ['compiled helper', HELPER_SOURCE, 'ZsInput+INPUT'],
  ['resident host', embeddedSource(buildHostScript()), 'ZsInput+INPUT'],
  ['PowerShell fallback', embeddedSource(buildScript()), 'ZsSendInput+INPUT'],
]) {
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @"\n${source}\n"@\n` +
    `Write-Output (([IntPtr]::Size.ToString()) + ':' + [Runtime.InteropServices.Marshal]::SizeOf([type]'${type}'))\n`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(run.status, 0, `${label}: ${run.stderr || run.error || run.stdout}`);
  const match = run.stdout.match(/(4|8):(\d+)/);
  assert.ok(match, `${label}: неожиданный ответ ${run.stdout}`);
  const pointer = Number(match[1]), size = Number(match[2]);
  console.log(`${label}: указатель ${pointer} байт, INPUT ${size} байт`);
  assert.equal(size, pointer === 8 ? 40 : 28, `${label}: размер INPUT неверен для Win32 SendInput`);
}
