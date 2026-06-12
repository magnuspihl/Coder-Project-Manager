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

export interface TaskTurn {
  id: string;
  task_id: string;
  role: 'implementer' | 'reviewer';
  turn_number: number;
  claude_session_id: string | null;
  review_outcome: 'pass' | 'fail' | null;
  review_summary: string | null;
  review_issues: string | null;
  files_changed: number | null;
  started_at: string;
  completed_at: string | null;
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
  git_branch: string | null;
  github_repo_url: string | null;
  worktree_path: string | null;
  port_range_start: number | null;
  model: string | null;
  caveman: string | null;
  auto_review: number;
  review_loop_count: number;
  active_turn_role: 'implementer' | 'reviewer' | null;
  pending_complete?: number;
  session_initialized?: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd?: number;
  source?: string | null;
  client_label?: string | null;
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
  participant_id: string | null;
  turn_id: string | null;
  source?: string | null;
  client_label?: string | null;
  created_at: string;
}

export interface TaskParticipant {
  id: string;
  task_id: string;
  workspace_id: string;
  workspace_name: string;
  claude_session_id: string | null;
  project_dir: string | null;
  status: string;
  running: boolean;
  activity: TaskActivity | null;
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

export interface RateLimitUsage {
  utilization: number;
  resetsAt: number;
  updatedAt: number;
}

export const getWorkspaces = () =>
  request<{ workspaces: Workspace[]; taskCounts: Record<string, TaskCounts>; tokenTotals: Record<string, TokenTotals>; githubRepoUrls: Record<string, string>; claudeUsage: Record<string, ClaudeUsage>; globalRateLimits: Record<string, RateLimitUsage> }>('/api/workspaces');

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

// Uploads
// Tasks
export const getTasks = (workspaceId: string) =>
  request<{ tasks: Task[] }>(`/api/workspaces/${workspaceId}/tasks`);

export const createTask = (workspaceId: string, prompt: string, model?: string, caveman?: string, attachmentIds?: string[], autoReview?: boolean) =>
  request<{ task: Task }>(`/api/workspaces/${workspaceId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ prompt, ...(model ? { model } : {}), ...(caveman ? { caveman } : {}), ...(attachmentIds?.length ? { attachmentIds } : {}), ...(autoReview === false ? { autoReview: false } : {}) }),
  });

export interface AttachmentInfo {
  id: string;
  task_id: string | null;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export const getTaskDetail = (taskId: string) =>
  request<{ task: Task; messages: Message[]; participants: TaskParticipant[]; attachments: AttachmentInfo[]; turns: TaskTurn[]; taskRequests: TaskRequestItem[] }>(`/api/tasks/${taskId}`);

export const approveTaskRequestForTask = (taskId: string, requestId: string, targetWorkspaceId?: string | null) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/task-requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify(targetWorkspaceId === undefined ? {} : { targetWorkspaceId }),
  });

export const dismissTaskRequestForTask = (taskId: string, requestId: string) =>
  request<{ ok: boolean }>(`/api/tasks/${taskId}/task-requests/${requestId}/dismiss`, { method: 'POST' });

export const updateTaskRequestTargetForTask = (taskId: string, requestId: string, targetWorkspaceId: string | null) =>
  request<{ ok: boolean; target: { id: string; name: string } | null }>(
    `/api/tasks/${taskId}/task-requests/${requestId}/target`,
    { method: 'PATCH', body: JSON.stringify({ targetWorkspaceId }) },
  );

export const getStreamLog = (taskId: string, afterId?: number) =>
  request<{ streamLog: StreamLogEntry[] }>(`/api/tasks/${taskId}/stream-log${afterId ? `?after=${afterId}` : ''}`);

export const replyToTask = (taskId: string, message: string, attachmentIds?: string[]) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ message, ...(attachmentIds?.length ? { attachmentIds } : {}) }),
  });

export async function uploadFiles(files: File[]): Promise<AttachmentInfo[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  const res = await fetch('/api/uploads', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event('auth:expired'));
      throw new Error('Session expired');
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }
  const data = await res.json();
  return data.attachments;
}

export const updateTaskTitle = (taskId: string, title: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });

export const completeTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/complete`, { method: 'POST' });

export const reopenTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/reopen`, { method: 'POST' });

export const retryTask = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/retry`, { method: 'POST' });

export const resetTaskSession = (taskId: string, continuationPrompt: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/reset-session`, {
    method: 'POST',
    body: JSON.stringify({ continuationPrompt }),
  });

export const compactTaskSession = (taskId: string) =>
  request<{ task: Task }>(`/api/tasks/${taskId}/compact-session`, { method: 'POST' });

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

// Task Participants
export const getTaskParticipants = (taskId: string) =>
  request<{ participants: TaskParticipant[] }>(`/api/tasks/${taskId}/participants`);

export const addTaskParticipant = (taskId: string, workspaceId: string, workspaceName: string) =>
  request<{ participant: TaskParticipant }>(`/api/tasks/${taskId}/participants`, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, workspaceName }),
  });

export const removeTaskParticipant = (taskId: string, participantId: string) =>
  request<{ ok: boolean }>(`/api/tasks/${taskId}/participants/${participantId}`, { method: 'DELETE' });

export const sendTaskParticipantMessage = (taskId: string, participantId: string, message: string) =>
  request<{ ok: boolean }>(`/api/tasks/${taskId}/participants/${participantId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });

export interface TaskRequestItem {
  id: string;
  discussion_id: string | null;
  task_id: string | null;
  prompt: string;
  status: string;
  created_task_id: string | null;
  target_workspace_id: string | null;
  target_workspace_name: string | null;
  created_at: string;
}

export const getGitSettings = (workspaceId: string) =>
  request<{ gitPushEnabled: boolean }>(`/api/workspaces/${workspaceId}/git-settings`);

export const updateGitSettings = (workspaceId: string, gitPushEnabled: boolean) =>
  request<{ ok: boolean; gitPushEnabled: boolean }>(`/api/workspaces/${workspaceId}/git-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ gitPushEnabled }),
  });

export const getWorkspaceVoiceSettings = (workspaceId: string) =>
  request<{ voiceIds: string[]; defaultVoiceId: string | null }>(`/api/workspaces/${workspaceId}/voice-settings`);

export const updateWorkspaceVoiceSettings = (workspaceId: string, voiceIds: string[]) =>
  request<{ ok: boolean; voiceIds: string[] }>(`/api/workspaces/${workspaceId}/voice-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ voiceIds }),
  });

export const getPreviewSettings = (workspaceId: string) =>
  request<{ previewUrl: string | null }>(`/api/workspaces/${workspaceId}/preview-settings`);

export const updatePreviewSettings = (workspaceId: string, previewUrl: string | null) =>
  request<{ ok: boolean; previewUrl: string | null }>(`/api/workspaces/${workspaceId}/preview-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ previewUrl }),
  });

export const restartCpm = () =>
  request<{ ok: boolean; message: string }>('/api/workspaces/restart', { method: 'POST' });

// Task multi-agent catch-up: nudge the host or a participant agent to catch up
// on the task conversation.
export const sendTaskHostCatchUp = (taskId: string) =>
  request<{ ok: boolean }>(`/api/tasks/${taskId}/catchup`, { method: 'POST' });

export const sendTaskParticipantCatchUp = (taskId: string, participantId: string) =>
  request<{ ok: boolean }>(`/api/tasks/${taskId}/participants/${participantId}/catchup`, { method: 'POST' });

export const touchTask = (taskId: string) =>
  request<{ previousOpenedAt: string | null; openedAt: string }>(`/api/tasks/${taskId}/touch`, { method: 'POST' });
