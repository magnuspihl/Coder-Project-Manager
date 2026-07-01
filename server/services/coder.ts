const CODER_URL = process.env.CODER_URL || '';

export class CoderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoderAuthError';
  }
}

export interface WorkspacePort {
  port: number;
  process_name: string;
  url: string;
  title: string | null;
  favicon_url: string | null;
  // Set by the API layer when the port janitor has attributed this port to an
  // active task's worktree (even if it drifted outside the task's numeric
  // range). Null/absent → the client falls back to the port-range heuristic.
  owner_task_id?: string | null;
}

export interface WorkspaceApp {
  slug: string;
  display_name: string;
  icon: string;
  favicon_url: string | null;
  url: string;
  external: boolean;
  subdomain: boolean;
}

export interface CoderWorkspace {
  id: string;
  name: string;
  owner_name: string;
  template_name: string;
  last_used_at: string;
  latest_build: {
    id: string;
    status: string;
    resources: Array<{
      agents?: Array<{
        id: string;
        name: string;
        status: string;
        apps?: Array<{
          slug: string;
          display_name: string;
          icon: string;
          url: string;
          external: boolean;
          subdomain: boolean;
          health: string;
        }>;
      }>;
    }>;
  };
  listening_ports?: WorkspacePort[];
  apps?: WorkspaceApp[];
}

export interface CoderUser {
  id: string;
  username: string;
  email: string;
  avatar_url: string;
}

export async function validateToken(token: string): Promise<CoderUser> {
  const res = await fetch(`${CODER_URL}/api/v2/users/me`, {
    headers: { 'Coder-Session-Token': token },
  });
  if (!res.ok) {
    throw new Error(`Invalid token: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<CoderUser>;
}

function getCoderBaseDomain(): string | null {
  try {
    const hostname = new URL(CODER_URL).hostname;
    // Strip leading subdomain if it's just "coder.domain.tld" -> "domain.tld"
    // The wildcard app hostname uses the full domain: PORT--agent--ws--owner.domain
    // For CODER_URL like "https://coder.pihl.family", base domain is "coder.pihl.family"
    return hostname;
  } catch {
    return null;
  }
}

function buildPortUrl(port: number, agentName: string, wsName: string, ownerName: string): string {
  const baseDomain = getCoderBaseDomain();
  if (!baseDomain) return '';
  return `https://${port}--${agentName.toLowerCase()}--${wsName.toLowerCase()}--${ownerName.toLowerCase()}.${baseDomain}`;
}

interface PortProbeResult {
  reachable: boolean;
  title: string | null;
  favicon_url: string | null;
  timestamp: number;
}

const probeCache = new Map<string, PortProbeResult>();
const PROBE_TTL_MS = 30_000; // cache probe results for 30s

async function probePortUrl(url: string, token: string): Promise<PortProbeResult> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.timestamp < PROBE_TTL_MS) {
    return cached;
  }

  try {
    const res = await fetch(url, {
      headers: { 'Coder-Session-Token': token },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const result: PortProbeResult = { reachable: false, title: null, favicon_url: null, timestamp: Date.now() };
      probeCache.set(url, result);
      return result;
    }

    const contentType = res.headers.get('content-type') || '';
    let title: string | null = null;
    let faviconUrl: string | null = null;

    if (contentType.includes('text/html')) {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim();

      // Look for <link rel="icon" href="..."> or <link rel="shortcut icon" href="...">
      // Use separate regexes for double-quoted and single-quoted href to handle data URIs
      // (data URIs often contain single quotes, so we can't use [^"'] as the capture group)
      const iconMatch =
        html.match(/<link[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href="([^"]*)"[^>]*>/i) ||
        html.match(/<link[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*href='([^']*)'[^>]*>/i) ||
        html.match(/<link[^>]*href="([^"]*)"[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i) ||
        html.match(/<link[^>]*href='([^']*)'[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i);
      if (iconMatch) {
        const href = iconMatch[1];
        if (href.startsWith('data:')) {
          // Data URIs are self-contained — use directly, no proxying needed
          faviconUrl = href;
        } else if (href.startsWith('http://') || href.startsWith('https://')) {
          faviconUrl = href;
        } else if (href.startsWith('/')) {
          faviconUrl = url + href;
        } else {
          faviconUrl = url + '/' + href;
        }
      }
      // Fallback: try /favicon.ico
      if (!faviconUrl) {
        faviconUrl = url + '/favicon.ico';
      }

      // Verify remote favicon URLs actually return an image (skip for data URIs)
      if (faviconUrl && !faviconUrl.startsWith('data:')) {
        try {
          const iconRes = await fetch(faviconUrl, {
            method: 'HEAD',
            headers: { 'Coder-Session-Token': token },
            signal: AbortSignal.timeout(2000),
          });
          const ct = iconRes.headers.get('content-type') || '';
          if (!iconRes.ok || !ct.startsWith('image/')) {
            faviconUrl = null;
          }
        } catch {
          faviconUrl = null;
        }
      }
    }

    const result: PortProbeResult = { reachable: true, title, favicon_url: faviconUrl, timestamp: Date.now() };
    probeCache.set(url, result);
    return result;
  } catch {
    const result: PortProbeResult = { reachable: false, title: null, favicon_url: null, timestamp: Date.now() };
    probeCache.set(url, result);
    return result;
  }
}

async function getListeningPorts(
  token: string,
  agentId: string,
  agentName: string,
  wsName: string,
  ownerName: string,
): Promise<WorkspacePort[]> {
  try {
    const res = await fetch(`${CODER_URL}/api/v2/workspaceagents/${agentId}/listening-ports`, {
      headers: { 'Coder-Session-Token': token },
    });
    if (!res.ok) return [];
    const data = await res.json() as { ports: Array<{ port: number; process_name: string; network: string }> };

    const rawPorts = (data.ports || []).map((p) => ({
      port: p.port,
      process_name: p.process_name,
      url: buildPortUrl(p.port, agentName, wsName, ownerName),
    }));

    // Probe all ports in parallel, filter to reachable ones
    const probed = await Promise.all(
      rawPorts.map(async (p) => {
        const probe = await probePortUrl(p.url, token);
        if (!probe.reachable) return null;
        return { ...p, title: probe.title, favicon_url: probe.favicon_url };
      }),
    );

    return probed.filter((p): p is WorkspacePort => p !== null);
  } catch {
    return [];
  }
}

async function enrichWorkspaceWithPortsAndApps(token: string, ws: CoderWorkspace): Promise<void> {
  if (ws.latest_build.status !== 'running') return;
  for (const resource of ws.latest_build.resources) {
    if (!resource.agents) continue;
    for (const agent of resource.agents) {
      if (agent.status !== 'connected') continue;
      ws.listening_ports = await getListeningPorts(token, agent.id, agent.name, ws.name, ws.owner_name);
      if (agent.apps && agent.apps.length > 0) {
        const baseDomain = getCoderBaseDomain();
        const appList = agent.apps
          .filter((app) => app.health !== 'initializing')
          .map((app) => {
            let appUrl = app.url;
            if (app.subdomain && baseDomain) {
              appUrl = `https://${app.slug}--${agent.name.toLowerCase()}--${ws.name.toLowerCase()}--${ws.owner_name.toLowerCase()}.${baseDomain}`;
            } else if (!app.external && baseDomain) {
              appUrl = `${CODER_URL}/@${ws.owner_name}/${ws.name}.${agent.name}/apps/${app.slug}/`;
            }
            let icon = app.icon || '';
            if (icon.startsWith('/')) {
              icon = `${CODER_URL}${icon}`;
            }
            return {
              slug: app.slug,
              display_name: app.display_name,
              icon,
              favicon_url: null as string | null,
              url: appUrl,
              external: app.external,
              subdomain: app.subdomain,
            };
          });
        ws.apps = await Promise.all(
          appList.map(async (app) => {
            if (app.subdomain && app.url) {
              const probe = await probePortUrl(app.url, token);
              if (probe.favicon_url) {
                app.favicon_url = probe.favicon_url;
              }
            }
            return app;
          }),
        );
      }
      return;
    }
  }
}

export async function listWorkspaces(token: string): Promise<CoderWorkspace[]> {
  const res = await fetch(`${CODER_URL}/api/v2/workspaces`, {
    headers: { 'Coder-Session-Token': token },
  });
  if (!res.ok) {
    if (res.status === 401) throw new CoderAuthError('Coder token expired');
    throw new Error(`Failed to list workspaces: ${res.status}`);
  }
  const data = await res.json();
  const workspaces = data.workspaces as CoderWorkspace[];
  await Promise.all(workspaces.map((ws) => enrichWorkspaceWithPortsAndApps(token, ws)));
  return workspaces;
}

export async function stopWorkspace(token: string, workspaceId: string): Promise<void> {
  const res = await fetch(`${CODER_URL}/api/v2/workspaces/${workspaceId}/builds`, {
    method: 'POST',
    headers: {
      'Coder-Session-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transition: 'stop' }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new CoderAuthError('Coder token expired');
    throw new Error(`Failed to stop workspace: ${res.status}`);
  }
}

export async function startWorkspace(token: string, workspaceId: string): Promise<void> {
  const res = await fetch(`${CODER_URL}/api/v2/workspaces/${workspaceId}/builds`, {
    method: 'POST',
    headers: {
      'Coder-Session-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transition: 'start' }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new CoderAuthError('Coder token expired');
    throw new Error(`Failed to start workspace: ${res.status}`);
  }
}

export async function getWorkspace(token: string, workspaceId: string): Promise<CoderWorkspace> {
  const res = await fetch(`${CODER_URL}/api/v2/workspaces/${workspaceId}`, {
    headers: { 'Coder-Session-Token': token },
  });
  if (!res.ok) {
    if (res.status === 401) throw new CoderAuthError('Coder token expired');
    throw new Error(`Failed to get workspace: ${res.status}`);
  }
  const ws = await res.json() as CoderWorkspace;
  await enrichWorkspaceWithPortsAndApps(token, ws);
  return ws;
}
