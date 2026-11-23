import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runner = readFileSync('scripts/test-electron-clipboard-image.cjs', 'utf8');
const entry = readFileSync('scripts/e2e/electron-clipboard-image-entry.cjs', 'utf8');
const workflow = readFileSync('.github/workflows/build.yml', 'utf8');

describe('сквозной тест изображения в буфере', () => {
  it('не трогает системный буфер вне одноразового Windows CI', () => {
    for (const file of [runner, entry]) {
      expect(file).toContain("process.platform !== 'win32' || process.env.CI !== 'true'");
      expect(file).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    }
    expect(runner).toContain('fs.mkdtempSync');
    expect(runner).toContain('fs.rmSync(root, { recursive: true');
    expect(entry).toContain('clipboard.clear()');
    const denied = spawnSync(process.execPath, ['scripts/test-electron-clipboard-image.cjs'], { env: { ...process.env, CI: 'false' }, encoding: 'utf8', timeout: 5000 });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('только в изолированном Windows CI');
  });

  it('использует настоящий preload и буфер без подмены Electron IPC', () => {
    expect(entry).toContain("require('./electron-entry.cjs')");
    expect(entry).toContain('window.zspeakly.native.writeClipboard');
    expect(entry).toContain('clipboard.readImage()');
    expect(entry).toContain('clipboard.readText()');
    expect(entry).toContain('CLIPBOARD_PIN_E2E_OK');
    expect(entry).toContain('clipboardMonitor: true');
    expect(entry).toContain("window.zspeakly.store.getSync('zs.clipboard')");
    expect(runner).toContain("profile['zs.clipboard']");
    expect(entry).not.toContain('native.writeClipboard =');
  });

  it('Windows PR CI запускает проверку без подавления ошибки', () => {
    const job = workflow.split('  package:')[1]?.split('\n  release:')[0];
    const step = job?.split('      - name: Изображение в буфере Electron')[1]?.split('\n      - name:')[0];
    expect(step).toBeTruthy();
    expect(step).toContain('node scripts/test-electron-clipboard-image.cjs');
    expect(step).toContain('exit "$code"');
    expect(step).toContain("if: github.event_name == 'pull_request'");
    expect(step).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
  });
});
