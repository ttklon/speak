import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/build.yml', 'utf8');

describe('проверка настоящего движка в CI', () => {
  it('ошибка выполненного теста не подавляется настройкой шага', () => {
    const step = workflow.split('      - name: Тест настоящего движка распознавания (whisper.cpp)')[1]?.split('\n  package:')[0];
    expect(step).toBeTruthy();
    expect(step).not.toMatch(/^\s*continue-on-error:\s*true\s*$/m);
    expect(step).toContain('npm run test:whisper');
    expect(step).toContain('code=${PIPESTATUS[0]}');
    expect(step).toContain('exit "$code"');
  });
});
