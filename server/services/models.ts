import { sshExec } from './claude.js';

export interface ModelInfo {
  id: string;
  display_name: string;
  provider: 'anthropic' | 'ollama';
}

const OLLAMA_BASE_URL = 'http://192.168.1.199:11434';

// Cache models per workspace for 1 hour (Anthropic), 5 min (Ollama)
const anthropicCache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
const ANTHROPIC_CACHE_TTL_MS = 60 * 60 * 1000;

let ollamaCache: { models: ModelInfo[]; timestamp: number } | null = null;
const OLLAMA_CACHE_TTL_MS = 5 * 60 * 1000; // Shorter — models can be pulled/removed

// Fallback list when Anthropic API fetch fails
const FALLBACK_ANTHROPIC: ModelInfo[] = [
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
      .map((m: any) => ({ id: m.id, display_name: m.display_name, provider: 'anthropic' as const }))
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

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return cacheOllama([]);

    const data = await res.json();
    if (!data.models || !Array.isArray(data.models)) return cacheOllama([]);

    const models: ModelInfo[] = data.models
      .map((m: any) => {
        const name = m.name || m.model;
        return {
          id: `ollama/${name}`,
          display_name: name.replace(/:latest$/, ''),
          provider: 'ollama' as const,
        };
      })
      .sort((a: ModelInfo, b: ModelInfo) => a.display_name.localeCompare(b.display_name));

    return cacheOllama(models);
  } catch {
    return cacheOllama([]);
  }
}

function cacheOllama(models: ModelInfo[]): ModelInfo[] {
  ollamaCache = { models, timestamp: Date.now() };
  return models;
}

/**
 * Get the Ollama base URL for use in environment variables.
 */
export function getOllamaBaseUrl(): string {
  return OLLAMA_BASE_URL;
}
