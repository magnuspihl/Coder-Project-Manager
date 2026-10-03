import test from 'node:test';
import assert from 'node:assert/strict';
import { extractProofFiles, parseReviewDecision } from './review-verdict.js';

test('parses a plain pass', () => {
  const d = parseReviewDecision('All good.\nREVIEW_DECISION: {"outcome":"pass","summary":"Looks right"}');
  assert.deepEqual(d, { outcome: 'pass', summary: 'Looks right', issues: undefined });
});

test('legacy string issues still parse', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"fail","summary":"bad","issues":["a","b"]}');
  assert.deepEqual(d?.issues, [{ text: 'a' }, { text: 'b' }]);
});

test('evidence-based findings carry requirement and proof path', () => {
  const d = parseReviewDecision(`REVIEW_DECISION: {"outcome":"fail","summary":"s","findings":[
    {"defect":"empty input crashes","requirement":"Task says: 'accept empty lines'","proof":"src/a.cpm-proof.test.ts"},
    {"defect":"obj shapes","requirement":{"quote":"existing test x","source":"test"},"proof":{"path":"b.cpm-proof.test.ts"},"reraises":"AB12CD34"}
  ]}`);
  assert.equal(d?.issues?.length, 2);
  assert.deepEqual(d?.issues?.[0], { text: 'empty input crashes', requirement: "Task says: 'accept empty lines'", proofPath: 'src/a.cpm-proof.test.ts' });
  assert.deepEqual(d?.issues?.[1], { text: 'obj shapes', requirement: 'existing test x', requirementSource: 'test', proofPath: 'b.cpm-proof.test.ts', reraises: 'ab12cd34' });
});

test('findings and legacy issues are merged when both are present', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"fail","summary":"s","findings":[{"defect":"x"}],"issues":["y"]}');
  assert.deepEqual(d?.issues?.map(i => i.text), ['x', 'y']);
});

test('a finding without a defect is dropped rather than invented', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"fail","summary":"s","findings":[{"proof":"p"},{"defect":"  "}]}');
  assert.equal(d?.issues, undefined);
});

test('tolerates markdown wrappers, indentation and pretty-printed JSON', () => {
  const text = 'blah\n\n  **REVIEW_DECISION:** ```json\n{\n  "outcome": "fail",\n  "summary": "s",\n  "issues": ["with } brace"]\n}\n```';
  assert.deepEqual(parseReviewDecision(text)?.issues, [{ text: 'with } brace' }]);
});

test('the last marker wins, but an earlier one is used when the last is inside the JSON', () => {
  assert.equal(
    parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"first"}\nREVIEW_DECISION: {"outcome":"fail","summary":"second"}')?.summary,
    'second');
  const tricky = 'REVIEW_DECISION: {"outcome":"fail","summary":"s","issues":["it never emits REVIEW_DECISION: when cut off"]}';
  const d = parseReviewDecision(tricky);
  assert.equal(d?.outcome, 'fail');
  assert.equal(d?.issues?.[0].text, 'it never emits REVIEW_DECISION: when cut off');
});

test('an echoed template is rejected, and placeholder issues are stripped', () => {
  assert.equal(parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"<one sentence>"}'), null);
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"fail","summary":"real","issues":["<specific issue>","...","real one"],"findings":[{"defect":"<defect>"}]}');
  assert.deepEqual(d?.issues, [{ text: 'real one' }]);
});

test('returns null with no marker, bad outcome, or unbalanced JSON', () => {
  assert.equal(parseReviewDecision('just prose'), null);
  assert.equal(parseReviewDecision('REVIEW_DECISION: {"outcome":"maybe","summary":"s"}'), null);
  assert.equal(parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"s"'), null);
});

test('extractProofFiles reads a fenced block after the marker', () => {
  const text = 'PROOF_FILE: src/a.cpm-proof.test.ts\n```ts\nimport x from "y";\ntest("t", () => {});\n```\nREVIEW_DECISION: {}';
  assert.deepEqual(extractProofFiles(text), [{ path: 'src/a.cpm-proof.test.ts', content: 'import x from "y";\ntest("t", () => {});\n' }]);
});

test('extractProofFiles tolerates markdown around the marker and blank lines before the fence', () => {
  const text = '**PROOF_FILE:** `a.cpm-proof.test.ts`\n\n```\nX\n```';
  assert.deepEqual(extractProofFiles(text), [{ path: 'a.cpm-proof.test.ts', content: 'X\n' }]);
});

test('extractProofFiles: a longer fence lets the test contain ``` itself', () => {
  const text = 'PROOF_FILE: a.cpm-proof.test.ts\n````\nconst s = `\n```\ninner\n```\n`;\n````';
  const [f] = extractProofFiles(text);
  assert.match(f.content, /inner/);
  assert.match(f.content, /```/);
});

test('extractProofFiles: unterminated blocks are ignored, and the last block for a path wins', () => {
  assert.deepEqual(extractProofFiles('PROOF_FILE: a.cpm-proof.test.ts\n```\ncut off'), []);
  const twice = 'PROOF_FILE: a.cpm-proof.test.ts\n```\nOLD\n```\nPROOF_FILE: a.cpm-proof.test.ts\n```\nNEW\n```\nPROOF_FILE: b.cpm-proof.test.ts\n```\nB\n```';
  assert.deepEqual(extractProofFiles(twice).map(f => [f.path, f.content]), [['a.cpm-proof.test.ts', 'NEW\n'], ['b.cpm-proof.test.ts', 'B\n']]);
});

test('extractProofFiles: CRLF input (PTY output) is handled', () => {
  assert.equal(extractProofFiles('PROOF_FILE: a.cpm-proof.test.ts\r\n```\r\nX\r\n```\r\n')[0].content, 'X\n');
});

test('parses the reviewer\'s coverage claim, with notReviewed entries as paths or objects', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"s","coverage":{"reviewed":["a.ts"],"notReviewed":["b.ts",{"file":"c.ts","reason":"too long"}]}}');
  assert.deepEqual(d?.coverage, { reviewed: ['a.ts'], notReviewed: [{ file: 'b.ts', reason: '' }, { file: 'c.ts', reason: 'too long' }] });
});

test('a missing coverage field leaves coverage undefined (unverified), not an error', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"s"}');
  assert.equal(d?.outcome, 'pass');
  assert.equal(d?.coverage, undefined);
});

test('a garbled coverage field is ignored without losing the verdict', () => {
  for (const bad of ['"coverage":"all of it"', '"coverage":[1,2]', '"coverage":null', '"coverage":{"reviewed":"a.ts"}', '"coverage":{}']) {
    const d = parseReviewDecision(`REVIEW_DECISION: {"outcome":"pass","summary":"s",${bad}}`);
    assert.equal(d?.outcome, 'pass', bad);
    assert.equal(d?.coverage, undefined, bad);
  }
});

test('echoed coverage template placeholders are not treated as files', () => {
  const d = parseReviewDecision('REVIEW_DECISION: {"outcome":"pass","summary":"s","coverage":{"reviewed":["<path>"],"notReviewed":[{"file":"<path>","reason":"<why>"}]}}');
  assert.deepEqual(d?.coverage, { reviewed: [], notReviewed: [] });
});
