import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface LightboxImage {
  /** What to render in the overlay (and, for attachments, also the download URL). */
  src: string;
  /** Caption / download filename. */
  name?: string;
}

interface LightboxApi {
  /** Show `images`, starting at `index`. Passing an empty list is a no-op. */
  open: (images: LightboxImage[], index?: number) => void;
}

const LightboxContext = createContext<LightboxApi | null>(null);

/**
 * Opens images in an in-app overlay instead of a new browser tab.
 *
 * Returns null when no provider is mounted so callers can fall back to a plain
 * link — Markdown renders in a few places and shouldn't hard-require the
 * provider.
 */
export function useLightbox(): LightboxApi | null {
  return useContext(LightboxContext);
}

/**
 * Full-screen image viewer, mounted once at the app root so it sits above every
 * other overlay (task detail, settings modals — all z-50).
 *
 * Escape is handled in the *capture* phase on window and stops propagation, so
 * closing the lightbox doesn't also close the modal that opened it: those
 * modals listen in the bubble phase, which never runs once capture stops the
 * event.
 */
export function ImageLightboxProvider({ children }: { children: ReactNode }) {
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const openRef = useRef(false);

  const open = useCallback((next: LightboxImage[], startIndex = 0) => {
    if (!next.length) return;
    setImages(next);
    setIndex(Math.min(Math.max(startIndex, 0), next.length - 1));
    setFailed(false);
  }, []);

  const close = useCallback(() => setImages([]), []);

  const isOpen = images.length > 0;
  openRef.current = isOpen;

  const step = useCallback((delta: number) => {
    setIndex(prev => {
      const nextIndex = (prev + delta + images.length) % images.length;
      if (nextIndex !== prev) setFailed(false);
      return nextIndex;
    });
  }, [images.length]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (!openRef.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowRight' && images.length > 1) {
        e.stopPropagation();
        step(1);
      } else if (e.key === 'ArrowLeft' && images.length > 1) {
        e.stopPropagation();
        step(-1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, images.length, close, step]);

  const current = images[index];

  return (
    <LightboxContext.Provider value={{ open }}>
      {children}
      {current && (
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={current.name || 'Image preview'}
        >
          {/* Toolbar */}
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 text-white/90"
            onClick={e => e.stopPropagation()}
          >
            <div className="min-w-0 text-sm truncate">
              {current.name && <span className="truncate">{current.name}</span>}
              {images.length > 1 && (
                <span className="ml-2 text-white/50 tabular-nums">{index + 1} / {images.length}</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <a
                href={current.src}
                download={current.name || ''}
                className="p-2 rounded-md hover:bg-white/10 transition-colors"
                title="Download"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" /></svg>
              </a>
              <a
                href={current.src}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-md hover:bg-white/10 transition-colors"
                title="Open in new tab"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M19 14v5H5V5h5" /></svg>
              </a>
              <button
                type="button"
                onClick={close}
                className="p-2 rounded-md hover:bg-white/10 transition-colors"
                title="Close (Esc)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          {/* Stage — clicking the backdrop around the image closes, the image itself doesn't */}
          <div className="relative flex-1 min-h-0 flex items-center justify-center px-4 pb-4">
            {images.length > 1 && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); step(-1); }}
                className="absolute left-2 p-3 rounded-full bg-black/40 text-white/80 hover:bg-black/70 hover:text-white transition-colors"
                title="Previous (←)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
              </button>
            )}
            {failed ? (
              <div className="text-sm text-white/60">Couldn't load this image.</div>
            ) : (
              <img
                src={current.src}
                alt={current.name || ''}
                onClick={e => e.stopPropagation()}
                onError={() => setFailed(true)}
                className="max-h-full max-w-full object-contain rounded shadow-2xl"
              />
            )}
            {images.length > 1 && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); step(1); }}
                className="absolute right-2 p-3 rounded-full bg-black/40 text-white/80 hover:bg-black/70 hover:text-white transition-colors"
                title="Next (→)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </button>
            )}
          </div>
        </div>
      )}
    </LightboxContext.Provider>
  );
}
