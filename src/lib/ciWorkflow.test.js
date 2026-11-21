import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/build.yml', 'utf8');

describe('проверка настоящего движка в CI', () => {
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
    expect(job.match(/exit "\$code"/g)).toHaveLength(6);
    expect(job).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
  });

  it('Windows проверяет реальный ABI и симулированные отказы ввода', () => {
    const job = workflow.split('  package:')[1]?.split('\n  release:')[0];
    expect(job).toContain('scripts/test-wininput-layout.cjs');
    expect(job).toContain('scripts/test-wininput-failure.cjs');
    expect(job).toContain('scripts/test-wininput-window.cjs');
    expect(job).toContain('ZS_INPUT_INTERACTIVE: "1"');
    expect(job).toContain('ZS_TEST_ELECTRON: "1"');
    expect(job).toContain('ZS_TEST_WINDOWS_DICTATION: "1"');
    expect(job).toContain('scripts/test-onnx-live.mjs gigaam "$ZS_DICTATION_WAV" --download');
    expect(job).toContain('::error title=Windows GigaAM');
    expect(job).toContain('::warning title=Windows input window');
    expect(job).toContain('::warning title=Windows Electron input');
    expect(job).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
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
