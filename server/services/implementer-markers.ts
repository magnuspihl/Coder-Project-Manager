/**
 * Machine-readable lines the implementer may end a turn with. Like
 * NO_REVIEW_NEEDED and FINDING_REPORT they are plumbing: parsed here, stripped
 * before the message reaches the user.
 */

export const TEST_PROFILE_MARKER = 'TEST_PROFILE';
export const NO_TESTS_MARKER = 'NO_TESTS_NEEDED';

const WRAP = '[ \\t]*[*`_]*';
const testProfileRe = () => new RegExp(`^${WRAP}${TEST_PROFILE_MARKER}[*\`_]*[ \\t]*:[ \\t]*\`*(\\{.*?\\})\`*[ \\t]*$`, 'gm');
const noTestsRe = () => new RegExp(`^${WRAP}${NO_TESTS_MARKER}[*\`_]*[ \\t]*:?[ \\t]*(.*)$`, 'gm');
const tidy = (s: string) => s.replace(/\n{3,}/g, '\n\n').trim();

/**
 * Pull the implementer's `TEST_PROFILE: {json}` out of a message. The last marker
 * wins (a model that restates it means the final one). The JSON is returned raw —
 * callers validate it with parseTestProfile, since it ends up in a shell.
 */
export function extractTestProfile(text: string): { profile: unknown | null; stripped: string } {
  if (!text.includes(TEST_PROFILE_MARKER)) return { profile: null, stripped: text };
  let profile: unknown | null = null;
  for (const m of text.matchAll(testProfileRe())) {
    try { profile = JSON.parse(m[1]); } catch { /* an unreadable marker is dropped, not fatal */ }
  }
  // Strip the whole marker line even when its JSON didn't parse — plumbing must
  // never be user-visible.
  const stripped = text.replace(new RegExp(`^${WRAP}${TEST_PROFILE_MARKER}[*\`_]*[ \\t]*:.*$`, 'gm'), '');
  return { profile, stripped: tidy(stripped) };
}

/**
 * `NO_TESTS_NEEDED: <reason>` — the implementer's statement that its change has
 * no testable behaviour. The reason is kept so the summary can show it; a bare
 * marker with no reason is recorded as a generic one.
 */
export function extractNoTests(text: string): { reason: string | null; stripped: string } {
  if (!text.includes(NO_TESTS_MARKER)) return { reason: null, stripped: text };
  let reason: string | null = null;
  for (const m of text.matchAll(noTestsRe())) {
    reason = m[1].replace(/[*`_]+/g, '').trim() || 'No testable behaviour in this change.';
  }
  return { reason, stripped: tidy(text.replace(noTestsRe(), '')) };
}

/**
 * The implementer's standing test obligation. Tests are part of the deliverable:
 * they are what lets a human trust a change without reading its diff. `existing`
 * never asks for a framework to be installed; only an explicit workspace opt-in
 * (`setup`) does, because in some workspaces (a Godot or Unity project) the
 * "obvious" test framework is the wrong thing to add.
 */
export function buildTestingPrompt(mode: 'existing' | 'setup'): string {
  const framework = mode === 'setup'
    ? `- Use the project's existing test framework and conventions. If it has none, set one up that fits the stack (the language's standard or most common runner) as part of this task — adding a test dependency is expected here — and say so in your final message.`
    : `- Use the project's existing test framework and conventions. Do NOT add a new test framework or test dependency; if you cannot see where a test would go, say so instead.`;
  return `TESTS ARE PART OF THE DELIVERABLE:
When you add or change behaviour, add or update automated tests that prove it works, in the same change.
${framework}
- Name each test as the behaviour it verifies, in plain English a non-programmer can read: "rejects usernames containing @, $, € or ¥" — not "test_validate_3". These names are shown to the user as the checklist of what was verified.
- Test the requirements and their edge cases, not implementation details. A test that cannot fail proves nothing; prefer one that would have failed before your change.
- Run the tests before you finish and fix failures. If something cannot be run, say so plainly.
- Skip tests only when there is no testable behaviour (docs, comments, pure styling, config, a question or diagnosis). Only then, end your final response with this exact line, giving the reason. If you added or changed ANY test, never write this line — not even as "not applicable" or "a test was added":

${NO_TESTS_MARKER}: <one short reason>

If you set up or changed how tests are run, also end your final response with this line (one line of JSON) so the harness can run your tests itself:

${TEST_PROFILE_MARKER}: {"runner":"node-test|vitest|jest|pytest|go|dotnet","command":"<optional command prefix, e.g. npx vitest run>","cwd":"<optional subdirectory>"}

Both lines are stripped before your message is shown.`;
}
