import { useState } from 'react';
import type { WorkspacePreviewState } from '../hooks/useWorkspacePreview';

export default function WorkspacePreviewPanel({ state }: { state: WorkspacePreviewState }) {
  const { candidates, savedPreviewUrl, activePreviewUrl, setActivePreviewUrl, togglePreview, previewKey, reloadPreview } = state;
  const [menuOpen, setMenuOpen] = useState(false);

  const handlePick = (url: string) => {
    setActivePreviewUrl(url);
    setMenuOpen(false);
  };

  return (
    <div className="bg-white dark:bg-gray-950 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-800 flex-1 min-w-0 max-h-[90vh] flex flex-col">
      <div className="flex items-center gap-2 p-2 border-b border-gray-200 dark:border-gray-800">
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="w-full text-left text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:border-blue-300 dark:hover:border-blue-700 truncate font-mono"
            title={activePreviewUrl || 'No preview URL'}
          >
            {activePreviewUrl ?? 'No preview URL detected'}
          </button>
          {menuOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl z-10 max-h-72 overflow-y-auto">
              {candidates.length === 0 && !savedPreviewUrl && (
                <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                  No listening ports detected. Start a dev server in the workspace, or set a URL in workspace settings.
                </div>
              )}
              {savedPreviewUrl && !candidates.some(c => c.url === savedPreviewUrl) && (
                <button
                  onClick={() => handlePick(savedPreviewUrl)}
                  className="w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2"
                >
                  <span className="text-blue-500">●</span>
                  <span className="font-mono truncate">{savedPreviewUrl}</span>
                  <span className="ml-auto text-[10px] text-gray-400">saved</span>
                </button>
              )}
              {candidates.map(c => (
                <button
                  key={c.url}
                  onClick={() => handlePick(c.url)}
                  className={`w-full text-left text-xs px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-100 dark:border-gray-800 last:border-0 flex items-center gap-2 ${c.url === activePreviewUrl ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                >
                  <span className={c.url === activePreviewUrl ? 'text-blue-500' : 'text-gray-300'}>●</span>
                  <span className="truncate">{c.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={reloadPreview}
          disabled={!activePreviewUrl}
          className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-30"
          title="Reload preview"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        {activePreviewUrl && (
          <a
            href={activePreviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            title="Open in new tab"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
        <button
          onClick={togglePreview}
          className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          title="Hide preview"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-gray-50 dark:bg-gray-900 rounded-b-xl overflow-hidden">
        {activePreviewUrl ? (
          <iframe
            key={`${activePreviewUrl}|${previewKey}`}
            src={activePreviewUrl}
            title="Workspace preview"
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-full flex items-center justify-center p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            Start a dev server in the workspace, or set a URL in workspace settings.
          </div>
        )}
      </div>
    </div>
  );
}

export function PreviewToggleButton({ state }: { state: WorkspacePreviewState }) {
  const { isMobile, previewEffective, togglePreview } = state;
  if (isMobile) return null;
  return (
    <button
      onClick={togglePreview}
      className={`p-1 transition-colors ${previewEffective ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
      title={previewEffective ? 'Hide preview' : 'Show preview'}
      aria-pressed={previewEffective}
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
      </svg>
    </button>
  );
}
