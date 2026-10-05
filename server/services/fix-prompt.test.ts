/** The combined Fix prompt: what the implementer is told about each source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCombinedFixPrompt, auditRef, type FixPromptInput } from './fix-prompt.js';
import { REVIEW_FIX_REPLY_PREFIX, isFixRequestText } from './message-kinds.js';

const base: FixPromptInput = {
  reviewItems: [], hasProof: false, dismissed: [], auditItems: [], auditStale: false,
  proofInstructions: 'PROOF-RULES', reportFormat: 'REPORT-FORMAT',
};
const audit = { id: 'r1', kind: 'possible duplicate', text: 'helper duplicates util', cites: ['a.ts:3', 'c.ts:7'], ownership: { owner: 'task' as const, basis: 'lines' as const, reason: 'cites lines this task changed' } };

test('puts reviewer findings and audit findings, and the note, into one prompt', () => {
  const p = buildCombinedFixPrompt({ ...base, reviewItems: ['[abcd1234] null deref\n    FAILING TEST: x.test.ts'], hasProof: true, auditItems: [audit], note: 'use the existing constant; ignore the list one' });
  assert.match(p, /REVIEWER FINDINGS/);
  assert.match(p, /\[abcd1234\] null deref/);
  assert.match(p, /AUDIT FINDINGS/);
  assert.ok(p.includes(`[${auditRef('r1')}] (possible duplicate) helper duplicates util`));
  assert.match(p, /Cited: a\.ts:3, c\.ts:7/);
  assert.match(p, /use the existing constant; ignore the list one/);
  assert.match(p, /REPORT-FORMAT/);
});

test('reviewer findings with proof are "make the test pass"; audit findings are judgement calls that may be declined', () => {
  const p = buildCombinedFixPrompt({ ...base, reviewItems: ['[abcd1234] bug'], hasProof: true, auditItems: [audit] });
  assert.match(p, /make that test pass/);
  assert.match(p, /PROOF-RULES/);
  assert.match(p, /JUDGEMENT CALLS/);
  assert.match(p, /may DECLINE/);
  assert.match(p, /fixed.*declined, with a reason.*not applicable/s);
});

test('an audit-only send carries no reviewer section and no proof rules', () => {
  const p = buildCombinedFixPrompt({ ...base, auditItems: [audit] });
  assert.doesNotMatch(p, /REVIEWER FINDINGS/);
  assert.doesNotMatch(p, /PROOF-RULES/);
});

test('says whether each audit finding is the task\'s own code, and warns when the audit is stale', () => {
  const p = buildCombinedFixPrompt({ ...base, auditItems: [audit, { ...audit, id: 'd1', ownership: { owner: 'pre_existing', basis: 'untouched', reason: 'x' } }], auditStale: true });
  assert.match(p, /introduced by this task/);
  assert.match(p, /pre-existing code/);
  assert.match(p, /predates your latest changes/);
});

test('omits the note section when there is no note, and still reads as a Fix reply', () => {
  const p = buildCombinedFixPrompt({ ...base, reviewItems: ['[abcd1234] bug'], note: '   ' });
  assert.doesNotMatch(p, /Note from the user/);
  assert.ok(p.startsWith(REVIEW_FIX_REPLY_PREFIX));
  assert.equal(isFixRequestText(p), true);
});

test('repeats the dismissed-findings waiver so the implementer leaves them alone', () => {
  const p = buildCombinedFixPrompt({ ...base, reviewItems: ['[abcd1234] bug'], dismissed: [{ body: 'nit', note: 'on purpose' }] });
  assert.match(p, /DISMISSED/);
  assert.match(p, /nit \(user's reason: on purpose\)/);
});
