import type { ReactNode } from 'react';

const URL_RE = /(https?:\/\/[^\s<>"')\]},;]+)/g;

export function linkify(text: string): ReactNode {
  const parts = text.split(URL_RE);
  if (parts.length === 1) return text;

  return parts.map((part, i) =>
    URL_RE.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 underline hover:text-blue-800 dark:hover:text-blue-300 break-all"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}
