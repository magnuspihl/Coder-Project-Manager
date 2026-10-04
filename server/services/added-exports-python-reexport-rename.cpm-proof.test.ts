import test from 'node:test';
import assert from 'node:assert/strict';
import { addedExports } from './added-exports.js';

test('a Python re-export renamed in a package __init__ is not reported as an added export', () => {
  // The task renames the re-exported name: pkg exported old_name at the base, new_name now.
  // `from pkg import new_name` failing on the base is a renamed export, not new code.
  const added = addedExports('pkg/__init__.py', 'from .impl import old_name\n', 'from .impl import new_name\n');
  assert.ok(added === null || !added.has('new_name'), `rename reported as added: ${added ? [...added] : added}`);
});
