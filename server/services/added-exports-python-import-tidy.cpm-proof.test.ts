import test from 'node:test';
import assert from 'node:assert/strict';
import { addedExports } from './added-exports.js';

test('a Python function added alongside dropping an unused typing import is still found as added', () => {
  const base = 'from typing import Optional\n\ndef parse_duration(s):\n    return 1\n';
  const now = 'def parse_duration(s):\n    return 1\n\ndef format_duration(ms):\n    return str(ms)\n';
  const added = addedExports('pkg/dur.py', base, now);
  assert.ok(added?.has('format_duration'), `got ${added ? JSON.stringify([...added]) : added}`);
});
