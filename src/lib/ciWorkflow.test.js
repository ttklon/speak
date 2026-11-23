import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/build.yml', 'utf8');

describe('проверка настоящего движка в CI', () => {
  it('Windows запускает все unit-тесты и полный интерфейс без фильтра сценариев', () => {
    const job = workflow.split('  windows-full-ui:')[1]?.split('\n  onnx-live:')[0];
    expect(job).toContain('runs-on: windows-latest');
    expect(job).toContain('npm test > windows-all-tests.log');
    expect(job).toContain('node scripts/test-ui.mjs > windows-full-ui.log');
    expect(job).toContain('node scripts/smoke-main.mjs --test-clipboard-disabled > windows-clipboard-smoke.log');
    expect(job).toContain('::error title=Windows clipboard smoke');
    // Unit failure must not prevent the independent UI suite from running.
    expect(job).toContain("if: ${{ !cancelled() && steps.windows-install.outcome == 'success' }}");
    expect(job).not.toContain('ZS_ONLY');
    expect(job).not.toContain('ZS_SKIP_CRAWL');
    expect(job).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    expect(job).toContain('::error title=Windows full UI');
  });

  it('настоящие ONNX-модели проверяются на речи и ошибка теста не скрыта', () => {
    const job = workflow.split('  onnx-live:')[1]?.split('\n  package:')[0];
    expect(job).toBeTruthy();
    expect(job).toContain('scripts/test-gigaam-preprocessor.mjs');
    expect(job).toContain('scripts/test-onnx-live.mjs gigaam');
    expect(job).toContain('scripts/test-onnx-live.mjs parakeet');
    expect(job).toContain('scripts/test-virtual-mic.mjs gigaam');
    expect(job).toContain('scripts/test-virtual-mic.mjs parakeet');
    expect(job).toContain('scripts/test-electron-virtual-mic.mjs gigaam');
    expect(job).toContain('scripts/test-electron-virtual-mic.mjs parakeet');
    expect(job).toContain('sha256sum -c');
    expect(job.match(/exit "\$code"/g)).toHaveLength(7);
    expect(job).toContain('xvfb-run -a node scripts/test-electron-backup.cjs');
    expect(job).toContain('::error title=Electron backup');
    expect(job).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
  });

  it('Windows проверяет реальный ABI и симулированные отказы ввода', () => {
    const job = workflow.split('  package:')[1]?.split('\n  release:')[0];
    expect(job).toContain("[string]$_.Exception.Message -replace 'https?://\\S+', '[url]' -replace '%', '%25' -replace '[\\r\\n]+', ' '");
    expect(job).toContain('if (-not $hint) { $hint = $_.Exception.GetType().Name }');
    expect(job).toContain('scripts/test-wininput-layout.cjs');
    expect(job).toContain('scripts/test-wininput-failure.cjs');
    expect(job).toContain('scripts/test-wininput-window.cjs');
    expect(job).toContain('scripts/check-packaged-onnx.cjs');
    expect(job).toContain('node scripts/test-electron-backup.cjs');
    expect(job).toContain('::error title=Electron backup');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.build.files).not.toContain('!**/node_modules/onnxruntime-common/**');
    expect(pkg.build.nsis.include).toBe('scripts/nsis/installer.nsh');
    expect(job).toContain('ZS_INPUT_INTERACTIVE: "1"');
    expect(job).toContain('ZS_TEST_ELECTRON: "1"');
    expect(job).toContain('ZS_TEST_WINDOWS_DICTATION: "1"');
    expect(job).toContain('ZS_TEST_PACKAGED=1 node scripts/test-wininput-window.cjs');
    expect(job).toContain('::error title=Packaged Windows dictation');
    expect(job).toContain('scripts/test-nsis-lifecycle.cjs');
    expect(job).toContain('::error title=NSIS lifecycle');
    expect(job).toContain('::warning title=NSIS lifecycle');
    expect(job).toContain('scripts/test-onnx-live.mjs gigaam "$ZS_DICTATION_WAV" --download');
    expect(job).toContain('::error title=Windows GigaAM');
    expect(job).toContain('::warning title=Windows input window');
    expect(job).toContain('::warning title=Windows Electron input');
    expect(job).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
  });

  it('проверка пустого буфера разрешена только на одноразовом Windows CI', () => {
    const runner = readFileSync('scripts/test-wininput-window.cjs', 'utf8');
    const target = readFileSync('scripts/e2e/wininput-target.ps1', 'utf8');
    expect(runner).toContain("process.platform !== 'win32'");
    expect(runner).toContain("process.env.CI === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'");
    expect(runner).toContain("await command('clipboardClearIsolatedCi')");
    expect(runner).toContain("await command('clipboardFormatsIsolatedCi')");
    expect(runner).toContain('CLIPBOARD_EMPTY_RESTORE_E2E_OK');
    expect(runner).toContain('SELECTION_STALE_CLIPBOARD_E2E_OK');
    expect(runner).toContain('UNDO_CARET_MOVED_E2E_OK');
    expect(target.match(/\$env:CI -ne 'true' -or \$env:RUNNER_ENVIRONMENT -ne 'github-hosted'/g)).toHaveLength(2);
    expect(target).toContain('[System.Windows.Forms.Clipboard]::Clear()');
  });

  it('проверка потерянного подтверждения защищена и проверяет реальный ввод', () => {
    const runner = readFileSync('scripts/test-wininput-window.cjs', 'utf8');
    const entry = readFileSync('scripts/e2e/electron-input-lost-entry.cjs', 'utf8');
    expect(entry).toContain("process.platform !== 'win32'");
    expect(entry).toContain("process.env.CI !== 'true'");
    expect(entry).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(entry).toContain("process.env.ZS_INPUT_LOST_E2E !== '1'");
    expect(entry).toContain('const result = await type(text)');
    expect(runner).toContain('SENDINPUT_LOST_ACK_E2E_OK');
    expect(runner).toContain('PASTE_LOST_ACK_E2E_OK');
    expect(runner).toContain('SHARED_PASTE_LOST_ACK_E2E_OK');
    expect(entry).toContain('host.paste = async');
    expect(entry).toContain('const result = await input.paste()');
    expect(runner).toContain("await lostPage.evaluate(() => window.zspeakly.native.undoLastInsert())");
    expect(runner).toContain("assert.equal((await command('state')).text, text");
  });

  it('ошибка выполненного теста не подавляется настройкой шага', () => {
    const step = workflow.split('      - name: Тест настоящего движка распознавания (whisper.cpp)')[1]?.split('\n  package:')[0];
    expect(step).toBeTruthy();
    expect(step).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    expect(step).toContain('npm run test:whisper');
    expect(step).toContain('if ! url=$(curl -fsS --retry 3');
    expect(step).toContain('if [ -z "$url" ]; then');
    expect(step).toContain('code=${PIPESTATUS[0]}');
    expect(step).toContain('exit "$code"');
    const disable = step.lastIndexOf('set +e', step.indexOf('npm run test:whisper'));
    const test = step.indexOf('npm run test:whisper');
    const capture = step.indexOf('code=${PIPESTATUS[0]}');
    const restore = step.indexOf('set -e', capture);
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(disable).toBeLessThan(test);
    expect(test).toBeLessThan(capture);
    expect(restore).toBeGreaterThan(capture);
  });
});
