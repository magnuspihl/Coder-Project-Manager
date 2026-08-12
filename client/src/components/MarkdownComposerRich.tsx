import 'easymde/dist/easymde.min.css';
import './MarkdownComposer.css';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import SimpleMDE from 'react-simplemde-editor';
import type EasyMDE from 'easymde';
import type { ComposerHandle, ComposerProps } from './MarkdownComposer';

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

  const cmCaret = (cm: EasyMDE['codemirror']) => cm.indexFromPos(cm.getCursor());

  useImperativeHandle(ref, (): ComposerHandle => ({
    focus() {
      instanceRef.current?.codemirror.focus();
    },
    getCaret() {
      const cm = instanceRef.current?.codemirror;
      return cm ? cmCaret(cm) : value.length;
    },
    setCaret(pos: number) {
      const cm = instanceRef.current?.codemirror;
      cm?.setCursor(cm.posFromIndex(pos));
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
