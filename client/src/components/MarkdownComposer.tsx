import { Suspense, forwardRef, lazy, useImperativeHandle, useRef } from 'react';

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
      setCaret: (pos) => textareaRef.current?.setSelectionRange(pos, pos),
    };
  });

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
        onChange(el.value, isComposingRef.current ? null : el.selectionStart ?? el.value.length);
      }}
      onKeyDown={(e) => onKeyDown?.(e)}
      onSelect={(e) => {
        if (isComposingRef.current) return;
        const el = e.currentTarget;
        onCaretMove?.(el.value, el.selectionStart ?? el.value.length);
      }}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={(e) => {
        isComposingRef.current = false;
        const el = e.currentTarget;
        onCaretMove?.(el.value, el.selectionStart ?? el.value.length);
      }}
      placeholder={placeholder}
      rows={3}
      autoFocus={autoFocus}
      disabled={disabled}
      className={
        'w-full px-3 py-2 rounded-md border text-sm resize-y disabled:opacity-50 ' +
        'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 ' +
        BORDER[accent]
      }
    />
  );
});

export default MarkdownComposer;
