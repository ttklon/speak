#!/usr/bin/env node
/** Компилирует настоящий код помощника, заменяя только системный SendInput:
 * воспроизводит отказ первого и последнего символа без ввода в чужое окно. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { HELPER_SOURCE } = require('../electron/winInput.cjs');
if (process.platform !== 'win32') {
  console.log('Симуляция на CLR запускается на Windows.');
  process.exit(0);
}
const signature = '[DllImport("user32.dll", SetLastError = true)]\n  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);';
assert.ok(HELPER_SOURCE.includes(signature), 'сигнатура SendInput изменилась');
const fake = `public static int calls = 0;
  public static int failAfter = 0;
  static uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize) {
    return calls++ < failAfter ? nInputs : 0;
  }`;
const source = HELPER_SOURCE.replace(signature, fake);
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const cases = [
  { text: 'ab', after: 0, ok: false, typed: 0, total: 2 },
  { text: 'ab', after: 1, ok: false, typed: 1, total: 2 },
  { text: 'ab', after: 2, ok: true, typed: 2, total: 2 },
  { text: '\r\nx', after: 2, ok: true, typed: 2, total: 2 },
  { text: '\r\nx', after: 0, ok: false, typed: 0, total: 2 },
];
let script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @"\n${source}\n"@\n`;
for (const item of cases) {
  script += `[ZsInput]::calls = 0; [ZsInput]::failAfter = ${item.after}; [void][ZsInput]::Main([string[]]@('type','${b64(item.text)}'))\n`;
}
const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  encoding: 'utf8', timeout: 30000, windowsHide: true,
});
assert.equal(run.status, 0, run.stderr || String(run.error));
const results = run.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{')).map(JSON.parse);
assert.equal(results.length, cases.length, `не все ответы: ${run.stdout}`);
cases.forEach((item, i) => {
  assert.deepEqual(results[i], { ok: item.ok, typed: item.typed, total: item.total });
  console.log(`Симуляция SendInput: ${JSON.stringify(item.text)}, успешных вызовов ${item.after} → ${JSON.stringify(results[i])}`);
});
