import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const LOG_FILE = path.join(process.cwd(), 'data', 'flux-cost-log.jsonl');

// Flat per-call estimates at ~1 megapixel output (BFL's own published rates —
// see https://github.com/black-forest-labs/skills, skills/bfl-api). This is
// deliberately not billing-accurate: BFL actually prices per-megapixel and
// charges extra for reference images beyond the first, and this bridge never
// sets width/height so real output size is whatever BFL defaults to. It's
// only meant to catch a runaway agent loop before it burns real money, not
// to reconcile against an invoice.
const RATE_USD: Record<string, { t2i: number; i2i: number }> = {
  'flux-2-klein-4b': { t2i: 0.014, i2i: 0.015 },
  'flux-2-klein-9b': { t2i: 0.015, i2i: 0.017 },
  'flux-2-pro': { t2i: 0.03, i2i: 0.045 },
  'flux-2-max': { t2i: 0.07, i2i: 0.10 },
  'flux-2-flex': { t2i: 0.05, i2i: 0.10 },
};

export function estimateCostUsd(model: string, hasInputImages: boolean): number {
  const rate = RATE_USD[model] ?? RATE_USD['flux-2-pro'];
  return hasInputImages ? rate.i2i : rate.t2i;
}

interface LogEntry {
  at: string;
  tool: string;
  model: string;
  costUsd: number;
}

// Re-derived from the log file the first time it's needed each UTC calendar
// month, then kept in memory — avoids re-reading and re-summing the whole
// file on every single call.
let monthTotal: { month: string; usd: number } | null = null;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM, UTC
}

async function loadMonthTotal(): Promise<{ month: string; usd: number }> {
  const month = currentMonth();
  if (monthTotal && monthTotal.month === month) return monthTotal;
  let usd = 0;
  try {
    const raw = await readFile(LOG_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        if (entry.at.slice(0, 7) === month) usd += entry.costUsd;
      } catch {
        // Skip a malformed line rather than failing every future call over it.
      }
    }
  } catch {
    // No log file yet — first call this deployment has ever made.
  }
  monthTotal = { month, usd };
  return monthTotal;
}

/** Throws if FLUX_MONTHLY_CAP_USD is set and this month's logged spend has already reached it. */
export async function checkMonthlyCap(): Promise<void> {
  if (config.fluxMonthlyCapUsd === null) return;
  const { usd } = await loadMonthTotal();
  if (usd >= config.fluxMonthlyCapUsd) {
    throw new Error(
      `FLUX monthly spend cap reached (~$${usd.toFixed(2)} / $${config.fluxMonthlyCapUsd.toFixed(2)} this month, ` +
      `estimated from ${LOG_FILE}) — raise FLUX_MONTHLY_CAP_USD or wait for next month.`,
    );
  }
}

export async function logCost(tool: string, model: string, costUsd: number): Promise<void> {
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  const entry: LogEntry = { at: new Date().toISOString(), tool, model, costUsd };
  await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`);
  // If the in-memory cache is already warm for this month, just add to it.
  // Otherwise let loadMonthTotal() re-derive from disk — the entry we just
  // appended will be included in that read, so adding costUsd here too would
  // double-count it.
  if (monthTotal && monthTotal.month === entry.at.slice(0, 7)) {
    monthTotal.usd += costUsd;
  } else {
    await loadMonthTotal();
  }
}
