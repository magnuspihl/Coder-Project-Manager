import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBaselineReview } from './review-coverage.js';
import { routeReview, toStored } from './review-proof.js';

test('an unverified review is never used as the baseline that lets the next review skip unchanged files', () => {
  const routed = routeReview('proof', { outcome: 'pass', summary: 'looks fine' }, [], 'tests could not run: no dependencies installed in the worktree');
  assert.equal(routed.outcome, 'unverified');
  const stored = {
    ...toStored(routed, []),
    coverage: {
      reviewed: ['server/a.ts'], readViaTool: [], unreviewed: [], exempt: [],
      claimUnverified: false, stoppedByTurnCap: false, reviewedTree: 'a'.repeat(40),
    },
  };
  assert.equal(pickBaselineReview([{ turnNumber: 1, stored: JSON.stringify(stored) }]), null,
    'a review whose tests could not run verified nothing, so the next review must not carry its files over as covered');
});
