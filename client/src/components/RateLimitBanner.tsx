import { useState, useEffect } from 'react';
import type { RateLimitInfo } from '../api/client';

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface RateLimitBannerProps {
  rateLimit: RateLimitInfo;
  onResume?: () => void;
  resumeLabel?: string;
}

export default function RateLimitBanner({ rateLimit, onResume, resumeLabel = 'Resume' }: RateLimitBannerProps) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.floor(rateLimit.resetsAt - Date.now() / 1000))
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.floor(rateLimit.resetsAt - Date.now() / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [rateLimit.resetsAt]);

  const expired = secondsLeft <= 0;
  const resetTime = new Date(rateLimit.resetsAt * 1000);

  return (
    <div className="rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-amber-600 dark:text-amber-400 text-sm font-medium">
          Rate Limited
        </span>
        <span className="text-xs text-amber-500 dark:text-amber-500">
          {rateLimit.rateLimitType.replace(/_/g, ' ')}
        </span>
      </div>
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
        {expired ? (
          'Rate limit has expired — ready to resume.'
        ) : (
          <>
            Resets in <span className="font-mono font-medium">{formatCountdown(secondsLeft)}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">
              ({resetTime.toLocaleTimeString()})
            </span>
          </>
        )}
      </p>
      {onResume && (
        <button
          onClick={onResume}
          disabled={!expired}
          className={`text-sm px-4 py-1.5 rounded-md font-medium transition-colors ${
            expired
              ? 'bg-amber-600 text-white hover:bg-amber-700 cursor-pointer'
              : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
          }`}
        >
          {expired ? resumeLabel : `${resumeLabel} in ${formatCountdown(secondsLeft)}`}
        </button>
      )}
    </div>
  );
}
