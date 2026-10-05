/** A comparison that did not happen must not make the earlier discrepancies look resolved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvedSince } from './audit-ownership.js';
import type { AuditReport } from './audit-report.js';

function report(over: Partial<AuditReport>): AuditReport {
  return { summary: 's', structure: { added: [], modified: [] }, reuseFindings: [], deviations: [], hardToReverse: [], discrepancies: [], unassessedExports: [], ...over };
}

test('discrepancies are not reported resolved when the new audit never ran the comparison', () => {
  const prev = report({ discrepancies: [{ id: 'x1', kind: 'unmentioned', text: 'new column not mentioned', cites: ['a.ts:3'] }] });
  const cur = report({ discrepancies: null, discrepanciesNote: 'the comparison with the implementer\'s summary failed' });
  assert.deepEqual(resolvedSince(prev, cur), []);
});
