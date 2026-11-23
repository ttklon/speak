import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runner = readFileSync('scripts/test-electron-screen-recording.cjs', 'utf8');
const entry = readFileSync('scripts/e2e/electron-screen-recording-entry.cjs', 'utf8');
const workflow = readFileSync('.github/workflows/build.yml', 'utf8');

describe('реальная проверка записи экрана', () => {
  it('ограничена Windows CI, использует временный профиль и удаляет видео', () => {
    expect(runner).toContain("process.platform !== 'win32' || process.env.CI !== 'true'");
    expect(runner).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(entry).toContain("process.env.RUNNER_ENVIRONMENT !== 'github-hosted'");
    expect(runner).toContain('fs.mkdtempSync');
    expect(runner).toContain('fs.rmSync(root, { recursive: true');
    expect(runner).toContain('SCREEN_E2E_OK');
    const denied = spawnSync(process.execPath, ['scripts/test-electron-screen-recording.cjs'], { env: { ...process.env, CI: 'false' }, encoding: 'utf8', timeout: 5000 });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('только в изолированном Windows CI');
  });

  it('сохраняет через UI и проверяет декодированный кадр, не подменяя медиа или IPC', () => {
    expect(entry).toContain("require('./electron-entry.cjs')");
    expect(entry).toContain('.clip-hotkey[title^="Запись экрана"]');
    expect(entry).toContain('video.play()');
    expect(entry).toContain('ctx.drawImage(video');
    expect(entry).toContain("'1a45dfa3'");
    expect(entry).not.toContain('window.MediaRecorder =');
    expect(entry).not.toContain('getDisplayMedia =');
    expect(entry).not.toContain('native.saveFile =');
  });

  it('Windows CI запускает тест без подавления ошибки и без сохранения видео как артефакта', () => {
    const job = workflow.split('  package:')[1]?.split('\n  release:')[0];
    const step = job?.split('      - name: Реальная запись экрана Electron')[1]?.split('\n      - name:')[0];
    expect(step).toBeTruthy();
    expect(step).toContain('node scripts/test-electron-screen-recording.cjs');
    expect(step).toContain('exit "$code"');
    expect(step).toContain("if: github.event_name == 'pull_request'");
    expect(step).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    expect(step).not.toContain('upload-artifact');
  });
});
