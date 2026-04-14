async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401 && !url.endsWith('/auth/me')) {
      // Session expired or invalid — notify app to show login screen
      window.dispatchEvent(new Event('auth:expired'));
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url: string;
}

export interface Workspace {
  id: string;
  name: string;
  owner_name: string;
  template_name: string;
  last_used_at: string;
  latest_build: {
    status: string;
    resources: Array<{
      agents?: Array<{
        id: string;
        name: string;
        status: string;
      }>;
    }>;
  };
  listening_ports?: Array<{
    port: number;
    process_name: string;
    url: string;
    title: string | null;
    favicon_url: string | null;
  }>;
  apps?: Array<{
    slug: string;
    display_name: string;
    icon: string;
    favicon_url: string | null;
    url: string;
    external: boolean;
    subdomain: boolean;
  }>;
}

export interface TaskActivity {
  timestamp: string;
  summary: string;
}

export interface RateLimitInfo {
  resetsAt: number;
  rateLimitType: string;
}

export interface Task {
  id: string;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  title: string;
  prompt: string;
  status: string;
  position: number;
  project_dir: string | null;
  claude_session_id: string | null;
  failed_reason: string | null;
  verification_url: string | null;
  branch: string | null;
  git_branch: string | null;
  github_repo_url: string | null;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd?: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  activity: TaskActivity | null;
  rate_limit: RateLimitInfo | null;
}

export interface Message {
  id: string;
  task_id: string;
  role: string;
  content: string;
  cost: number | null;
  username: string | null;
  created_at: string;
}

export interface StreamLogEntry {
  id?: number;
  timestamp: string;
  type: string;
  summary: string;
}

// Auth
export const getAuthConfig = () =>
  request<{ oauth_enabled: boolean; coder_url: string; self_workspace_id: string | null; self_workspace_name: string | null }>('/auth/config');

export const tokenLogin = (token: string) =>
  request<{ user: User }>('/auth/token-login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const logout = () =>
  request<{ ok: boolean }>('/auth/logout', { method: 'POST' });

export const getMe = () =>
  request<{ user: User }>('/auth/me');

// Workspaces
export interface TaskCounts {
  working: number;
  queued: number;
  awaiting_feedback: number;
  failed: number;
  completed: number;
  cancelled: number;
}

export interface TokenTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export interface ClaudeUsage {
  utilization: number;
  rateLimitType: string;
  resetsAt: number;
  updatedAt: number;
}

export const getWorkspaces = () =>
  request<{ workspaces: Workspace[]; taskCounts: Record<string, TaskCounts>; tokenTotals: Record<string, TokenTotals>; githubRepoUrls: Record<string, string>; latestDiscussionMessages: Record<string, string>; claudeUsage: Record<string, ClaudeUsage> }>('/api/workspaces');

export const getWorkspace = (id: string) =>
  request<{ workspace: Workspace }>(`/api/workspaces/${id}`);

export const stopWorkspace = (id: string) =>
  request<{ ok: boolean }>(`/api/workspaces/${id}/stop`, { method: 'POST' });

export const startWorkspace = (id: string) =>
  request<{ ok: boolean }>(`/api/workspaces/${id}/start`, { method: 'POST' });

export const getProjects = (workspaceId: string) =>
  request<{ projects: string[] }>(`/api/workspaces/${workspaceId}/projects`);

export interface ModelInfo {
  id: string;
  display_name: string;
  provider: 'anthropic' | 'ollama-local' | 'ollama-cloud';
}

export const getModels = (workspaceId: string) =>
  request<{ models: ModelInfo[] }>(`/api/workspaces/${workspaceId}/models`);

// Tasks
export const getTasks = (workspaceId: string) =>
  request<{ tasks: Task[] }>(`/api/workspaces/${workspaceId}/tasks`);

export const createTask = (workspaceId: string, prompt: string, branch?: string, model?: string) =>
  request<{ task: Task }>(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ prompt, ...(branch ? { branch } : {}), ...(model ? { model } : {}) }),
  });

export const getTaskDetail = (taskId: string) =>
  request<{ task: Task; messages: Message[] }>(`/api/tasks/${taskId}`);

export const getStreamLog = (taskId: string, afterId?: number) =>
  request<{ streamLog: StreamLogEntry[] }>(`/api/tasks/${taskId}/stream-log${afterId ? `?after=${afterId}` : ''}`);

export const replyToTask = (taskId: string, message: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });

export const completeTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/complete`, { method: 'POST' });

export const reopenTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/reopen`, { method: 'POST' });

export const retryTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/retry`, { method: 'POST' });

export const checkoutTaskBranch = (taskId: string) =>
  request<{ ok: boolean; message: string }>(`/api/tasks/${taskId}/checkout`, { method: 'POST' });

export const interruptTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/interrupt`, { method: 'POST' });

export const cancelTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/cancel`, { method: 'POST' });

export const deleteTask = (taskId: string) =>
  request<{ ok: boolean; taskId: string }>(`/api/tasks/${taskId}`, { method: 'DELETE' });

export const restoreTask = (taskId: string) =>
  request<{ ok: boolean; task: Task }>(`/api/tasks/${taskId}/restore`, { method: 'POST' });

// Discussions
export interface Discussion {
  id: string;
  workspace_id: string;
  workspace_name: string;
  user_id: string;
  claude_session_id: string | null;
  status: string;
  project_dir: string | null;
  full_access: number;
  ssh_pid: number | null;
  activity: TaskActivity | null;
  running: boolean;
  rate_limit: RateLimitInfo | null;
  created_at: string;
  updated_at: string;
}

export interface DiscussionMessage {
  id: string;
  discussion_id: string;
  role: string;
  content: string;
  cost: number | null;
  username: string | null;
  created_at: string;
}

export interface TaskRequestItem {
  id: string;
  discussion_id: string;
  prompt: string;
  branch: string | null;
  status: string;
  created_task_id: string | null;
  created_at: string;
}

export const getDiscussionSettings = (workspaceId: string) =>
  request<{ fullAccess: boolean }>(`/api/workspaces/${workspaceId}/discussion-settings`);

export const updateDiscussionSettings = (workspaceId: string, fullAccess: boolean) =>
  request<{ ok: boolean; fullAccess: boolean }>(`/api/workspaces/${workspaceId}/discussion-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ fullAccess }),
  });

export const getOrCreateDiscussion = (workspaceId: string) =>
  request<{ discussion: Discussion; messages: DiscussionMessage[]; totalMessages?: number; taskRequests: TaskRequestItem[] }>(
    `/api/workspaces/${workspaceId}/discussion`,
    { method: 'POST' }
  );

export const getDiscussionDetail = (discussionId: string, afterId?: string) =>
  request<{ discussion: Discussion; messages: DiscussionMessage[]; totalMessages: number; taskRequests: TaskRequestItem[] }>(
    `/api/discussions/${discussionId}${afterId ? `?after=${afterId}` : ''}`
  );

export const getOlderDiscussionMessages = (discussionId: string, beforeId: string, limit = 50) =>
  request<{ messages: DiscussionMessage[] }>(
    `/api/discussions/${discussionId}/messages?before=${beforeId}&limit=${limit}`
  );

export const updateDiscussionSession = (discussionId: string, claudeSessionId: string) =>
  request<{ ok: boolean; claudeSessionId: string }>(`/api/discussions/${discussionId}/session`, {
    method: 'PATCH',
    body: JSON.stringify({ claudeSessionId }),
  });

export const sendDiscussionMessage = (discussionId: string, message: string) =>
  request<{ ok: boolean }>(`/api/discussions/${discussionId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });

export const closeDiscussion = (discussionId: string) =>
  request<{ ok: boolean }>(`/api/discussions/${discussionId}/close`, { method: 'POST' });

export const approveTaskRequest = (discussionId: string, requestId: string) =>
  request<{ task: Task }>(`/api/discussions/${discussionId}/task-requests/${requestId}/approve`, { method: 'POST' });

export const dismissTaskRequest = (discussionId: string, requestId: string) =>
  request<{ ok: boolean }>(`/api/discussions/${discussionId}/task-requests/${requestId}/dismiss`, { method: 'POST' });
