/**
 * Map a caret offset from an old string onto a new one after an external edit.
 *
 * Programmatic writes to the composer (voice dictation pushing interim
 * transcripts, a failed send restoring the draft) replace the whole value, and
 * both CodeMirror's setValue and a controlled textarea answer that by throwing
 * the caret away. Diffing the common prefix/suffix recovers where it should have
 * landed:
 *
 *  - caret at or after the edited region → shifted by the length delta
 *  - caret strictly before it            → unchanged
 *  - caret inside it                     → end of the replacement
 *
 * The at-or-after case is tested first on purpose. A caret sitting exactly at
 * the end of the old text is the common one — dictation appending the next
 * clause — and it should ride along to the end of the new text rather than be
 * left stranded in front of the words that just arrived.
 */
export function mapCaret(prev: string, next: string, caret: number): number {
  if (prev === next) return caret;

  const max = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < max && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;

  if (caret >= prev.length - suffix) return next.length - (prev.length - caret);
  if (caret <= prefix) return caret;
  return next.length - suffix;
}

export const clampCaret = (pos: number, length: number) => Math.max(0, Math.min(pos, length));
