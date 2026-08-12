import { Suspense, forwardRef, lazy, useEffect, useImperativeHandle, useRef } from 'react';
import { clampCaret, mapCaret } from './composerCaret';

/*
 * The task reply composer, ported from the agent-box workspace's MarkdownEditor.
 *
 * Two branches, chosen by pointer type:
 *
 *  - Coarse pointer (phones, tablets): a plain textarea. Re-tokenising the whole
 *    document on every keystroke is the most expensive thing a phone does here,
 *    and live markdown decorations are barely legible at that size anyway. This
 *    is agent-box's mobile fix.
 *  - Everything else: EasyMDE over CodeMirror 5, with live markdown decorations
 *    in the editor. That lives in MarkdownComposerRich so the ~350 kB of
 *    CodeMirror only ships in a lazy chunk — phones never fetch it at all.
 *
 * Both branches expose the same caret API through the ref, which is what lets
 * TaskDetailModal's @-mention menu work without caring which one rendered.
 */

const MarkdownComposerRich = lazy(() => import('./MarkdownComposerRich'));

// Evaluated once at module load. The branch never needs to flip mid-session, and
// re-checking per render would defeat the point of the fast path.
const isCoarsePointer =
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

/**
 * The slice of a key event the composer's callers actually use. React's
 * KeyboardEvent satisfies this structurally, so the textarea branch forwards its
 * own event untouched and the CodeMirror branch forwards the native one.
 */
export interface ComposerKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}

export interface ComposerHandle {
  focus(): void;
  /** Caret position as an index into the plain-text value. */
  getCaret(): number;
  setCaret(pos: number): void;
}

export interface ComposerProps {
  value: string;
  /**
   * `caret` is null while an IME composition is in flight — the text is real but
   * the caret isn't settled yet, so callers should skip caret-derived work
   * (mention detection) until `onCaretMove` fires.
   */
  onChange: (value: string, caret: number | null) => void;
  /** Caret moved without the text changing: clicks, arrows, composition end. */
  onCaretMove?: (value: string, caret: number) => void;
  onKeyDown?: (e: ComposerKeyEvent) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Matches the two composer variants: task agent (blue) vs participant (teal). */
  accent?: 'blue' | 'teal';
}

// Spelled out in full rather than composed, so Tailwind's scanner can see them.
const BORDER = {
  blue: 'border-gray-300 dark:border-gray-700 focus:ring-blue-500',
  teal: 'border-teal-300 dark:border-teal-700 focus:ring-teal-500',
} as const;
const BORDER_WITHIN = {
  blue: 'border-gray-300 dark:border-gray-700 focus-within:ring-blue-500',
  teal: 'border-teal-300 dark:border-teal-700 focus-within:ring-teal-500',
} as const;

const MarkdownComposer = forwardRef<ComposerHandle, ComposerProps>(function MarkdownComposer(props, ref) {
  const { value, onChange, onCaretMove, onKeyDown, placeholder, disabled = false, autoFocus = false, accent = 'blue' } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const richRef = useRef<ComposerHandle>(null);
  // A controlled textarea also throws the caret away when the value is replaced
  // from outside, so the same repair the rich branch does is needed here.
  //
  // It can't be done the same way, though: React writes textarea.value during
  // the commit, i.e. before layout effects run, and that write already moves the
  // caret to the end. There is no effect that can observe the prior state. So
  // the last value/caret the *user* produced is tracked from the event handlers
  // instead, and anything that doesn't match it is by definition external.
  const lastRef = useRef({ value, caret: value.length });
  const pendingCaretRef = useRef<number | null>(null);

  const applyCaret = (pos: number) => {
    const el = textareaRef.current;
    if (!el) return;
    const c = clampCaret(pos, el.value.length);
    el.setSelectionRange(c, c);
  };

  useImperativeHandle(ref, (): ComposerHandle => {
    if (!isCoarsePointer) {
      return {
        focus: () => richRef.current?.focus(),
        getCaret: () => richRef.current?.getCaret() ?? value.length,
        setCaret: (pos) => richRef.current?.setCaret(pos),
      };
    }
    return {
      focus: () => textareaRef.current?.focus(),
      getCaret: () => textareaRef.current?.selectionStart ?? value.length,
      // Remembered as well as applied: callers set the caret in the same tick as
      // the value change that motivated it, so the DOM hasn't caught up yet.
      setCaret: (pos) => { pendingCaretRef.current = pos; applyCaret(pos); },
    };
  });

  useEffect(() => {
    const el = textareaRef.current;
    const last = lastRef.current;
    const pending = pendingCaretRef.current;
    pendingCaretRef.current = null;
    if (!el) return;
    // Matching the last value the user typed means they drove this update and
    // the browser has already put the caret where it belongs.
    if (last.value === value && pending === null) return;
    const caret = pending ?? mapCaret(last.value, value, last.caret);
    applyCaret(caret);
    lastRef.current = { value, caret };
  }, [value]);

  if (!isCoarsePointer) {
    return (
      <Suspense
        fallback={
          // Same footprint as the loaded editor, so the modal doesn't jump when
          // the CodeMirror chunk lands.
          <div
            className={
              'w-full rounded-md border bg-white dark:bg-gray-800 sm:min-h-[11rem] min-h-[5rem] ' +
              BORDER_WITHIN[accent]
            }
          />
        }
      >
        <MarkdownComposerRich ref={richRef} {...props} />
      </Suspense>
    );
  }

  // Fast path: no syntax highlighting, no CodeMirror, just a textarea.
  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => {
        const el = e.target;
        const caret = el.selectionStart ?? el.value.length;
        // The user is driving, so any caret a caller asked for is stale.
        pendingCaretRef.current = null;
        lastRef.current = { value: el.value, caret };
        onChange(el.value, isComposingRef.current ? null : caret);
      }}
      onKeyDown={(e) => onKeyDown?.(e)}
      onSelect={(e) => {
        if (isComposingRef.current) return;
        const el = e.currentTarget;
        const caret = el.selectionStart ?? el.value.length;
        lastRef.current = { value: el.value, caret };
        onCaretMove?.(el.value, caret);
      }}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={(e) => {
        isComposingRef.current = false;
        const el = e.currentTarget;
        const caret = el.selectionStart ?? el.value.length;
        lastRef.current = { value: el.value, caret };
        onCaretMove?.(el.value, caret);
      }}
      placeholder={placeholder}
      rows={3}
      autoFocus={autoFocus}
      disabled={disabled}
      className={
        // sm:min-h-[11rem] matches the textarea this replaced, so tablets wide
        // enough to hit the sm breakpoint keep the taller composer.
        'w-full px-3 py-2 rounded-md border text-sm resize-y disabled:opacity-50 sm:min-h-[11rem] ' +
        'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 ' +
        BORDER[accent]
      }
    />
  );
});

export default MarkdownComposer;
