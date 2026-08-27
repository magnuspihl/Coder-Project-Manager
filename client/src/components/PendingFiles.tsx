import { useEffect, useMemo, useState } from 'react';
import { useLightbox, type LightboxImage } from './ImageLightbox';

/**
 * Files staged in a composer but not sent yet. Images show as thumbnails (and
 * open in the lightbox on click) so what's about to be sent is visible the same
 * way it will be once it lands in the conversation; everything else stays a
 * name pill.
 *
 * Previews come from object URLs over the local File, so nothing is fetched —
 * the upload has usually already happened by the time this renders, but the
 * attachment id isn't threaded back here and the local bytes are equivalent.
 */
export default function PendingFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const lightbox = useLightbox();
  const [broken, setBroken] = useState<Record<number, boolean>>({});

  // One object URL per image file, revoked whenever the set changes or the
  // composer unmounts — otherwise every attach/detach leaks the file's bytes.
  const urls = useMemo(
    () => files.map(f => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)),
    [files]
  );
  useEffect(() => () => { urls.forEach(u => u && URL.revokeObjectURL(u)); }, [urls]);

  if (!files.length) return null;

  const gallery: LightboxImage[] = [];
  const galleryIndex = new Map<number, number>();
  urls.forEach((url, i) => {
    if (!url || broken[i]) return;
    galleryIndex.set(i, gallery.length);
    gallery.push({ src: url, name: files[i].name });
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {files.map((f, i) => {
        const url = urls[i];
        if (!url || broken[i]) {
          return (
            <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              <span className="truncate max-w-[120px]">{f.name}</span>
              <button type="button" onClick={() => onRemove(i)} className="text-blue-400 hover:text-red-500" title="Remove">&times;</button>
            </span>
          );
        }
        return (
          <span key={i} className="relative group inline-block">
            <button
              type="button"
              onClick={() => lightbox?.open(gallery, galleryIndex.get(i) ?? 0)}
              disabled={!lightbox}
              className="block w-14 h-14 rounded-md overflow-hidden border border-blue-200 dark:border-blue-800 hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
              title={`${f.name} — click to enlarge`}
            >
              <img
                src={url}
                alt={f.name}
                onError={() => setBroken(prev => ({ ...prev, [i]: true }))}
                className="w-full h-full object-cover"
              />
            </button>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-gray-700 text-white text-xs leading-none shadow hover:bg-red-500 transition-colors"
              title="Remove"
            >
              &times;
            </button>
          </span>
        );
      })}
    </div>
  );
}
