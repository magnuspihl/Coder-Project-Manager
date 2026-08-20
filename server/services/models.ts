import { sshExec } from './claude.js';

export interface ModelInfo {
  id: string;
  display_name: string;
  provider: 'anthropic' | 'ollama-local' | 'ollama-cloud';
}

const OLLAMA_BASE_URL = 'http://192.168.1.199:11434';

// Cache models per workspace for 1 hour (Anthropic), 5 min (Ollama)
const anthropicCache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
const ANTHROPIC_CACHE_TTL_MS = 60 * 60 * 1000;

let ollamaCache: { models: ModelInfo[]; timestamp: number } | null = null;
const OLLAMA_CACHE_TTL_MS = 5 * 60 * 1000; // Shorter — models can be pulled/removed

// Fallback list when Anthropic API fetch fails.
// NOTE: On Coder workspaces, Claude Code is authenticated through the managed
// Coder/OAuth gateway, so there is usually no `~/.claude/.credentials` apiKey or
// $ANTHROPIC_API_KEY for the live /v1/models fetch to use — meaning this list is
// effectively the source of truth. Keep it current as new models ship.
// Ordered newest-first so the latest model surfaces at the top of the dropdown.
const FALLBACK_ANTHROPIC: ModelInfo[] = [
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', provider: 'anthropic' },
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', provider: 'anthropic' },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', provider: 'anthropic' },
  { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'anthropic' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250514', display_name: 'Claude Sonnet 4.5', provider: 'anthropic' },
];

/**
 * Fetch available models from both Anthropic (via workspace SSH) and Ollama.
 */
export async function getModelsForWorkspace(workspaceName: string): Promise<ModelInfo[]> {
  const [anthropic, ollama] = await Promise.all([
    fetchAnthropicModels(workspaceName),
    fetchOllamaModels(),
  ]);
  return [...anthropic, ...ollama];
}

// ─── Anthropic ──────────────────────────────────────────────────────────

async function fetchAnthropicModels(workspaceName: string): Promise<ModelInfo[]> {
  const cached = anthropicCache.get(workspaceName);
  if (cached && Date.now() - cached.timestamp < ANTHROPIC_CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const raw = await sshExec(workspaceName, `
      KEY=$(cat ~/.claude/.credentials 2>/dev/null | grep -o '"apiKey"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\\(.*\\)"/\\1/')
      if [ -z "$KEY" ]; then
        KEY=$ANTHROPIC_API_KEY
      fi
      if [ -z "$KEY" ]; then
        echo "NO_KEY"
        exit 0
      fi
      curl -s -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" "https://api.anthropic.com/v1/models?limit=100" 2>/dev/null
    `, 20000);

    if (!raw || raw === 'NO_KEY') {
      return useAnthropicFallback(workspaceName);
    }

    const parsed = JSON.parse(raw);
    if (!parsed.data || !Array.isArray(parsed.data)) {
      return useAnthropicFallback(workspaceName);
    }

    const models: ModelInfo[] = parsed.data
      .filter((m: any) => m.id && m.display_name)
      .map((m: any) => ({ id: m.id, display_name: m.display_name, provider: 'anthropic' }))
      .sort((a: ModelInfo, b: ModelInfo) => a.display_name.localeCompare(b.display_name));

    if (models.length === 0) {
      return useAnthropicFallback(workspaceName);
    }

    anthropicCache.set(workspaceName, { models, timestamp: Date.now() });
    return models;
  } catch {
    return useAnthropicFallback(workspaceName);
  }
}

function useAnthropicFallback(workspaceName: string): ModelInfo[] {
  anthropicCache.set(workspaceName, {
    models: FALLBACK_ANTHROPIC,
    timestamp: Date.now() - ANTHROPIC_CACHE_TTL_MS + 5 * 60 * 1000,
  });
  return FALLBACK_ANTHROPIC;
}

// ─── Ollama ─────────────────────────────────────────────────────────────

async function fetchOllamaModels(): Promise<ModelInfo[]> {
  if (ollamaCache && Date.now() - ollamaCache.timestamp < OLLAMA_CACHE_TTL_MS) {
    return ollamaCache.models;
  }

  const [local, cloud] = await Promise.all([
    fetchOllamaLocalModels(),
    fetchOllamaCloudModels(),
  ]);

  // Merge and deduplicate (local models take precedence)
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const m of [...local, ...cloud]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      models.push(m);
    }
  }
  models.sort((a, b) => a.display_name.localeCompare(b.display_name));

  ollamaCache = { models, timestamp: Date.now() };
  return models;
}

/** Fetch locally installed models from Ollama's /api/tags endpoint. */
async function fetchOllamaLocalModels(): Promise<ModelInfo[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];

    const data = await res.json();
    if (!data.models || !Array.isArray(data.models)) return [];

    return data.models.map((m: any) => {
      const name = m.name || m.model;
      return {
        id: `ollama/${name}`,
        display_name: name.replace(/:latest$/, ''),
        provider: 'ollama-local' as const,
      };
    });
  } catch {
    return [];
  }
}

// Cache cloud model list separately (changes rarely)
let ollamaCloudListCache: { names: string[]; timestamp: number } | null = null;
const CLOUD_LIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Scrape available cloud model names from ollama.com/search?c=cloud. */
async function fetchOllamaCloudModels(): Promise<ModelInfo[]> {
  try {
    let names: string[];

    if (ollamaCloudListCache && Date.now() - ollamaCloudListCache.timestamp < CLOUD_LIST_CACHE_TTL_MS) {
      names = ollamaCloudListCache.names;
    } else {
      const res = await fetch('https://ollama.com/search?c=cloud', { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];

      const html = await res.text();
      // Model links follow the pattern href="/library/<model-name>"
      const matches = html.matchAll(/href="\/library\/([^"]+)"/g);
      names = [...new Set([...matches].map(m => m[1]))];
      ollamaCloudListCache = { names, timestamp: Date.now() };
    }

    return names.map(name => ({
      id: `ollama/${name}:cloud`,
      display_name: name,
      provider: 'ollama-cloud' as const,
    }));
  } catch {
    return [];
  }
}

/**
 * Get the Ollama base URL for use in environment variables.
 */
export function getOllamaBaseUrl(): string {
  return OLLAMA_BASE_URL;
}
