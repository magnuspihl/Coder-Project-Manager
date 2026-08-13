import 'easymde/dist/easymde.min.css';
import './MarkdownComposer.css';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import SimpleMDE from 'react-simplemde-editor';
import type EasyMDE from 'easymde';
import type { ComposerHandle, ComposerProps } from './MarkdownComposer';
import { clampCaret, mapCaret } from './composerCaret';

/*
 * The rich half of MarkdownComposer: EasyMDE over CodeMirror 5.
 *
 * It lives in its own module so the whole CodeMirror/EasyMDE payload lands in a
 * lazily-loaded chunk. Touch devices never render this branch, so they never
 * download it either — see MarkdownComposer for the split.
 *
 * CodeMirror 5 rather than 6 is deliberate: CM6 takes input through a
 * contenteditable, which drops keypresses under mobile virtual keyboards. CM5
 * types into a hidden textarea.
 */

const MarkdownComposerRich = forwardRef<ComposerHandle, ComposerProps>(function MarkdownComposerRich(
  { value, onChange, onCaretMove, onKeyDown, placeholder, disabled = false, autoFocus = false, accent = 'blue' },
  ref,
) {
  const instanceRef = useRef<EasyMDE | null>(null);

  // Latest callbacks behind a ref, so the CodeMirror listeners below can be
  // registered exactly once on mount without ever going stale.
  const cbRef = useRef({ onChange, onCaretMove, onKeyDown });
  cbRef.current = { onChange, onCaretMove, onKeyDown };

  // Editor state as of the last commit, captured before react-simplemde-editor
  // gets a chance to overwrite the document. See the two effects below.
  const beforeRef = useRef<{ value: string; caret: number; scrollTop: number } | null>(null);
  // A caret position a caller asked for that must survive the next value push.
  const pendingCaretRef = useRef<number | null>(null);

  const cmCaret = (cm: EasyMDE['codemirror']) => cm.indexFromPos(cm.getCursor());

  // scroll: false because CM5's setCursor otherwise scrolls the cursor into view
  // itself, which would stomp on a scroll position we are about to restore.
  // Revealing, when wanted, is done explicitly by the callers below.
  const applyCaret = (pos: number) => {
    const cm = instanceRef.current?.codemirror;
    if (!cm) return;
    cm.setCursor(cm.posFromIndex(clampCaret(pos, cm.getValue().length)), undefined, { scroll: false });
  };

  // scrollIntoView is a no-op in the window right after setValue — the display
  // hasn't remeasured, so it decides nothing needs revealing. Scrolling to the
  // cursor's own coordinates works, and only moves the view if the caret really
  // has gone off-screen.
  const revealCaret = () => {
    const cm = instanceRef.current?.codemirror;
    if (!cm) return;
    const caret = cm.cursorCoords(null, 'local');
    const { top, clientHeight } = cm.getScrollInfo();
    if (caret.top < top || caret.bottom > top + clientHeight) {
      cm.scrollTo(null, Math.max(0, caret.top - clientHeight / 2));
    }
  };

  useImperativeHandle(ref, (): ComposerHandle => ({
    focus() {
      instanceRef.current?.codemirror.focus();
    },
    getCaret() {
      const cm = instanceRef.current?.codemirror;
      return cm ? cmCaret(cm) : value.length;
    },
    setCaret(pos: number) {
      // Remembered as well as applied: callers set the caret in the same tick as
      // the value change that motivated it, and the editor won't have absorbed
      // that value yet. The effect below re-applies it once it has.
      pendingCaretRef.current = pos;
      applyCaret(pos);
      revealCaret();
    },
  }));

  // Static — no deps, so EasyMDE is never torn down and rebuilt on re-render.
  // Placeholder and disabled are pushed in through the instance effects below.
  const options = useMemo<EasyMDE.Options>(() => ({
    toolbar: false,
    status: false,
    spellChecker: false,
    nativeSpellcheck: true,
    lineWrapping: true,
    // The toolbar is hidden, so skip EasyMDE's default Font Awesome CDN fetch.
    autoDownloadFontAwesome: false,
    autosave: { enabled: false, uniqueId: '' },
    minHeight: '176px',
    maxHeight: '352px',
    // EasyMDE binds these by default and merges whatever we pass over its own
    // map, with null meaning "don't bind". All three assume a toolbar that can
    // undo them, which we don't render: preview (Cmd/Ctrl-P, which also eats the
    // browser's Print shortcut) covers the composer with an opaque overlay, and
    // side-by-side (F9) / fullscreen (F11) position: fixed the editor out of the
    // task modal entirely with no way back.
    shortcuts: {
      togglePreview: null,
      toggleSideBySide: null,
      toggleFullScreen: null,
    },
  }), []);

  // Stable identity, so react-simplemde-editor's [editor, getMdeInstance] effect
  // doesn't re-fire on every parent render and stack duplicate listeners.
  const getMdeInstance = useCallback((instance: EasyMDE) => {
    instanceRef.current = instance;
    const cm = instance.codemirror;

    // CM5 runs the DOM keydown handler before its own keymaps and bails out
    // entirely if that handler prevents default — so callers get first refusal on
    // Ctrl+Enter, the mention-menu keys and the scroll shortcuts, while plain
    // Enter falls through to EasyMDE's markdown list continuation. (agent-box
    // uses addKeyMap instead; a DOM listener is used here because the mention
    // menu's key handling depends on React state that a static keymap can't see.)
    cm.on('keydown', (_cm, event) => {
      cbRef.current.onKeyDown?.(event);
      if (event.defaultPrevented) return;
      // Tab has to move focus, the way it did when this was a plain textarea.
      // EasyMDE binds it to list indent/outdent and never returns CodeMirror.Pass,
      // which traps keyboard users in the composer with no way to reach Send.
      // codemirrorIgnore makes CM5 skip its own handling so the browser performs
      // native focus navigation.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (event.key === 'Tab') (event as any).codemirrorIgnore = true;
    });

    cm.on('cursorActivity', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((cm as any).display?.input?.composing) return;
      cbRef.current.onCaretMove?.(cm.getValue(), cmCaret(cm));
    });

    // Placeholder can't live in the frozen options object, so seed it here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cm as any).setOption('placeholder', placeholder ?? '');

    if (disabled) cm.setOption('readOnly', 'nocursor');
    if (autoFocus && !disabled) cm.focus();
    // Mount-only: placeholder and disabled changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout effects flush before any passive effect, so this snapshot is taken
  // while the document is still whatever the user last saw — react-simplemde-
  // editor's value push is a passive effect and runs after it.
  useLayoutEffect(() => {
    const cm = instanceRef.current?.codemirror;
    if (!cm) return;
    beforeRef.current = { value: cm.getValue(), caret: cmCaret(cm), scrollTop: cm.getScrollInfo().top };
  });

  // react-simplemde-editor answers an external `value` change with EasyMDE
  // value() -> CM5 setValue, which scrolls to the top and collapses the cursor
  // to 0,0. Without this, every interim voice transcript would yank the caret
  // back to the start of the draft mid-dictation.
  useEffect(() => {
    const cm = instanceRef.current?.codemirror;
    const before = beforeRef.current;
    const pending = pendingCaretRef.current;
    pendingCaretRef.current = null;
    if (!cm || !before) return;
    // Same text means the change came from the editor and no setValue ran, so
    // the cursor is already exactly where the user put it.
    if (before.value === value && pending === null) return;

    const caret = pending ?? mapCaret(before.value, value, before.caret);
    // Follow the caret only when the edit actually moved it (dictation landing
    // new text at the cursor). If the caret sat before the edit it hasn't moved,
    // and yanking the view to it would undo the scroll restore for no reason.
    const reveal = pending !== null || caret !== before.caret;
    applyCaret(caret);
    // setValue scrolled to the top either way: follow the caret, or put the
    // viewport back exactly where the user left it.
    if (reveal) revealCaret();
    else cm.scrollTo(null, before.scrollTop);
  }, [value]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instanceRef.current?.codemirror as any)?.setOption('placeholder', placeholder ?? '');
  }, [placeholder]);

  useEffect(() => {
    // 'nocursor' rather than true, so the caret disappears instead of lingering.
    instanceRef.current?.codemirror.setOption('readOnly', disabled ? 'nocursor' : false);
  }, [disabled]);

  const handleChange = useCallback((next: string) => {
    const cm = instanceRef.current?.codemirror;
    // The user is driving, so any caret a caller asked for is stale.
    pendingCaretRef.current = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composing = Boolean((cm as any)?.display?.input?.composing);
    cbRef.current.onChange(next, cm && !composing ? cmCaret(cm) : null);
  }, []);

  return (
    <div
      className={
        `cpm-composer${accent === 'teal' ? ' cpm-composer-teal' : ''} ` +
        'w-full rounded-md border bg-white dark:bg-gray-800 overflow-hidden ' +
        'focus-within:outline-none focus-within:ring-2 ' +
        (accent === 'teal'
          ? 'border-teal-300 dark:border-teal-700 focus-within:ring-teal-500'
          : 'border-gray-300 dark:border-gray-700 focus-within:ring-blue-500') +
        (disabled ? ' opacity-50' : '')
      }
    >
      <SimpleMDE
        value={value}
        onChange={handleChange}
        getMdeInstance={getMdeInstance}
        options={options}
      />
    </div>
  );
});

export default MarkdownComposerRich;
