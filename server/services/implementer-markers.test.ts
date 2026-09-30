import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestingPrompt, extractNoTests, extractTestProfile } from './implementer-markers.js';

test('extractTestProfile reads the JSON and strips the line', () => {
  const r = extractTestProfile('Done.\n\nTEST_PROFILE: {"runner":"vitest","command":"npx vitest run"}');
  assert.deepEqual(r.profile, { runner: 'vitest', command: 'npx vitest run' });
  assert.equal(r.stripped, 'Done.');
});

test('extractTestProfile tolerates bold/backtick wrapping and takes the last marker', () => {
  const r = extractTestProfile('**TEST_PROFILE:** `{"runner":"jest"}`\nlater\nTEST_PROFILE: {"runner":"pytest"}');
  assert.deepEqual(r.profile, { runner: 'pytest' });
  assert.equal(r.stripped, 'later');
});

test('extractTestProfile strips an unparseable marker but reports no profile', () => {
  const r = extractTestProfile('ok\nTEST_PROFILE: {not json}');
  assert.equal(r.profile, null);
  assert.equal(r.stripped, 'ok');
});

test('extractTestProfile leaves text without the marker untouched', () => {
  const r = extractTestProfile('nothing here');
  assert.deepEqual(r, { profile: null, stripped: 'nothing here' });
});

test('extractNoTests captures the reason and strips the line', () => {
  const r = extractNoTests('Changed the colour.\nNO_TESTS_NEEDED: CSS-only change, nothing to assert');
  assert.equal(r.reason, 'CSS-only change, nothing to assert');
  assert.equal(r.stripped, 'Changed the colour.');
});

test('extractNoTests: a bare marker gets a generic reason; wrapping is tolerated', () => {
  assert.equal(extractNoTests('x\n**NO_TESTS_NEEDED**').reason, 'No testable behaviour in this change.');
  assert.equal(extractNoTests('NO_TESTS_NEEDED — docs only').reason, '— docs only');
});

test('testing prompt: "existing" forbids adding a framework; only "setup" asks for one', () => {
  const existing = buildTestingPrompt('existing');
  const setup = buildTestingPrompt('setup');
  assert.match(existing, /Do NOT add a new test framework or test dependency/);
  assert.doesNotMatch(existing, /set one up/);
  assert.match(setup, /set one up that fits the stack/);
  assert.doesNotMatch(setup, /Do NOT add a new test framework/);
});

test('testing prompt: both variants keep the naming rule and the opt-out markers', () => {
  for (const mode of ['existing', 'setup'] as const) {
    const p = buildTestingPrompt(mode);
    assert.match(p, /plain English/);
    assert.match(p, /NO_TESTS_NEEDED: <one short reason>/);
    assert.match(p, /TEST_PROFILE: \{"runner"/);
  }
});

