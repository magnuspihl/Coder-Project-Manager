import test from 'node:test';
import assert from 'node:assert/strict';
import { filesOpened } from './review-coverage.js';

test('a Bash command naming a different file does not count as opening the file', () => {
  const opened = filesOpened(
    [{ name: 'Bash', input: { command: 'cat src/data.ts' } }],
    '/work/tree',
    ['a.ts', 'src/data.ts'],
  );
  assert.ok(opened.has('src/data.ts'));
  assert.ok(!opened.has('a.ts'), 'cat src/data.ts must not mark a.ts as read');
});
