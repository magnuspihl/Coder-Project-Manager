import { sshExec } from './claude.js';

export interface ModelInfo {
  id: string;
  display_name: string;
}

// Cache models per workspace for 1 hour
const modelCache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

// Fallback list when API fetch fails
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-5-20250514', display_name: 'Claude Sonnet 4.5' },
];

/**
 * Fetch available Claude models by running the Anthropic API call
 * from within a workspace (which has the API key configured).
 */
export async function getModelsForWorkspace(workspaceName: string): Promise<ModelInfo[]> {
  const cached = modelCache.get(workspaceName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    // Read the API key from Claude Code's config on the workspace
    // Claude Code stores credentials in ~/.claude/.credentials
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
      return useFallback(workspaceName);
    }

    const parsed = JSON.parse(raw);
    if (!parsed.data || !Array.isArray(parsed.data)) {
      return useFallback(workspaceName);
    }

    // Filter to chat models and sort by display name
    const models: ModelInfo[] = parsed.data
      .filter((m: any) => m.id && m.display_name)
      .map((m: any) => ({ id: m.id, display_name: m.display_name }))
      .sort((a: ModelInfo, b: ModelInfo) => a.display_name.localeCompare(b.display_name));

    if (models.length === 0) {
      return useFallback(workspaceName);
    }

    modelCache.set(workspaceName, { models, timestamp: Date.now() });
    return models;
  } catch {
    return useFallback(workspaceName);
  }
}

function useFallback(workspaceName: string): ModelInfo[] {
  // Cache the fallback too, but for a shorter period (5 min)
  modelCache.set(workspaceName, { models: FALLBACK_MODELS, timestamp: Date.now() - CACHE_TTL_MS + 5 * 60 * 1000 });
  return FALLBACK_MODELS;
}
