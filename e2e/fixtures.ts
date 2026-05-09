/**
 * TestApiClient — lightweight API helper for E2E test data setup/teardown.
 *
 * Uses raw fetch so E2E tests have zero build-time coupling to the web app.
 */

import "./env";
import pg from "pg";

// `||` (not `??`) so an empty `NEXT_PUBLIC_API_URL=` in .env still falls
// back to localhost. dotenv sets unset-vs-empty both as "" — treating them
// the same matches user intent.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://folio:folio@localhost:5432/folio?sslmode=disable";

interface TestWorkspace {
  id: string;
  name: string;
  slug: string;
}

export interface CreatedAgent {
  id: string;
  name: string;
  runtimeId: string;
}

export interface ChannelTask {
  id: string;
  agent_id: string;
  channel_id: string;
  status: string;
  priority: number;
}

export class TestApiClient {
  private token: string | null = null;
  private workspaceSlug: string | null = null;
  private workspaceId: string | null = null;
  private createdIssueIds: string[] = [];
  private createdChannelIds: string[] = [];
  private createdAgentIds: string[] = [];
  private createdRuntimeIds: string[] = [];

  async login(email: string, name: string) {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      // Keep each E2E login isolated so previous test runs do not trip the
      // per-email send-code rate limit.
      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      // Step 1: Send verification code
      const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!sendRes.ok) {
        throw new Error(`send-code failed: ${sendRes.status}`);
      }

      // Step 2: Read code from database
      const result = await client.query(
        "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      if (result.rows.length === 0) {
        throw new Error(`No verification code found for ${email}`);
      }

      // Step 3: Verify code to get JWT
      const verifyRes = await fetch(`${API_BASE}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: result.rows[0].code }),
      });
      if (!verifyRes.ok) {
        throw new Error(`verify-code failed: ${verifyRes.status}`);
      }
      const data = await verifyRes.json();

      this.token = data.token;

      // Update user name if needed
      if (name && data.user?.name !== name) {
        await this.authedFetch("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      }

      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      return data;
    } finally {
      await client.end();
    }
  }

  async getWorkspaces(): Promise<TestWorkspace[]> {
    const res = await this.authedFetch("/api/workspaces");
    return res.json();
  }

  setWorkspaceId(id: string) {
    this.workspaceId = id;
  }

  setWorkspaceSlug(slug: string) {
    this.workspaceSlug = slug;
  }

  async ensureWorkspace(name = "E2E Workspace", slug = "e2e-workspace") {
    const workspaces = await this.getWorkspaces();
    const workspace = workspaces.find((item) => item.slug === slug) ?? workspaces[0];
    if (workspace) {
      this.workspaceId = workspace.id;
      this.workspaceSlug = workspace.slug;
      return workspace;
    }

    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      const created = (await res.json()) as TestWorkspace;
      this.workspaceId = created.id;
      return created;
    }

    const refreshed = await this.getWorkspaces();
    const created = refreshed.find((item) => item.slug === slug) ?? refreshed[0];
    if (created) {
      this.workspaceId = created.id;
      return created;
    }

    throw new Error(`Failed to ensure workspace ${slug}: ${res.status} ${res.statusText}`);
  }

  async createIssue(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/issues", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    const issue = await res.json();
    this.createdIssueIds.push(issue.id);
    return issue;
  }

  async deleteIssue(id: string) {
    await this.authedFetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  async createChannel(name: string, kind: "public" | "private" = "public") {
    const res = await this.authedFetch("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name, kind }),
    });
    const channel = await res.json();
    this.createdChannelIds.push(channel.id);
    return channel as { id: string; name: string; kind: string };
  }

  async deleteChannel(id: string) {
    await this.authedFetch(`/api/channels/${id}`, { method: "DELETE" });
  }

  /**
   * Register a channel id for cleanup that was created by a UI flow rather than
   * by `createChannel()`. Without this, e2e tests that drive the create dialog
   * leak rows on every run.
   */
  trackChannel(id: string) {
    this.createdChannelIds.push(id);
  }

  /**
   * Create a stub agent via direct DB insert.
   *
   * Creating an agent via the REST API requires a valid runtime_id in the
   * workspace, which may not exist in a freshly-seeded E2E environment.
   * Instead we insert the required agent_runtime + agent rows directly so the
   * test controls all fields and the agent is visible in the UI agent-picker
   * (agentListOptions lists non-archived agents regardless of status).
   *
   * The created runtime and agent are both tracked for cleanup.
   */
  async createAgent(name: string): Promise<CreatedAgent> {
    if (!this.workspaceId) {
      throw new Error("createAgent requires ensureWorkspace to be called first");
    }
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      // Insert a dedicated agent_runtime for this test agent.
      const runtimeResult = await client.query<{ id: string }>(
        `INSERT INTO agent_runtime (
          workspace_id, daemon_id, name, runtime_mode, provider,
          status, device_info, metadata, last_seen_at
        ) VALUES ($1, NULL, $2, 'cloud', 'e2e_stub', 'online', '{}'::jsonb, '{}'::jsonb, now())
        RETURNING id`,
        [this.workspaceId, `e2e-runtime-${name}`],
      );
      const runtimeId = runtimeResult.rows[0].id;
      this.createdRuntimeIds.push(runtimeId);

      // Look up the user_id from the workspace member for owner_id.
      const memberResult = await client.query<{ user_id: string }>(
        `SELECT user_id FROM member WHERE workspace_id = $1 LIMIT 1`,
        [this.workspaceId],
      );
      const ownerId = memberResult.rows[0]?.user_id ?? null;

      // Insert the agent. visibility='workspace' so the agent-picker lists it.
      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agent (
          workspace_id, name, description, runtime_mode, runtime_config,
          runtime_id, visibility, max_concurrent_tasks, owner_id,
          instructions, custom_env, custom_args
        ) VALUES ($1, $2, '', 'cloud', '{}'::jsonb, $3, 'workspace', 6, $4, '', '{}'::jsonb, '[]'::jsonb)
        RETURNING id`,
        [this.workspaceId, name, runtimeId, ownerId],
      );
      const agentId = agentResult.rows[0].id;
      this.createdAgentIds.push(agentId);

      return { id: agentId, name, runtimeId };
    } finally {
      await client.end();
    }
  }

  /**
   * Add an agent to a channel via direct DB insert.
   *
   * Using the REST API (PUT /api/channels/{id}/members/agent:{id}) requires the
   * running server binary to support agent channel members; if the binary is
   * stale the endpoint may return 400. Direct SQL is always in sync with the
   * current migration state.
   */
  async addAgentToChannel(
    channelId: string,
    agentId: string,
    subscribeMode: "mention_only" | "subscribe" = "mention_only",
  ): Promise<void> {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query(
        `INSERT INTO channel_member (channel_id, member_type, member_id, subscribe_mode)
         VALUES ($1, 'agent', $2, $3)
         ON CONFLICT (channel_id, member_type, member_id) DO NOTHING`,
        [channelId, agentId, subscribeMode],
      );
    } finally {
      await client.end();
    }
  }

  /**
   * List agent_task_queue rows for a given channel_id.
   * Uses a direct DB query so there is no need for a dedicated server endpoint.
   */
  async listChannelTasks(channelId: string): Promise<ChannelTask[]> {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query<ChannelTask>(
        `SELECT id, agent_id, channel_id, status, priority
         FROM agent_task_queue
         WHERE channel_id = $1
         ORDER BY created_at ASC`,
        [channelId],
      );
      return result.rows;
    } finally {
      await client.end();
    }
  }

  /** Clean up all issues, channels, and agents created during this test. */
  async cleanup() {
    for (const id of this.createdIssueIds) {
      try {
        await this.deleteIssue(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdIssueIds = [];
    for (const id of this.createdChannelIds) {
      try {
        await this.deleteChannel(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdChannelIds = [];

    // Agents and runtimes have FK chains: agent → agent_runtime.
    // Delete agents first, then runtimes.
    if (this.createdAgentIds.length > 0) {
      const client = new pg.Client(DATABASE_URL);
      await client.connect();
      try {
        for (const id of this.createdAgentIds) {
          await client.query(`DELETE FROM agent WHERE id = $1`, [id]).catch(() => {/* ignore */});
        }
        for (const id of this.createdRuntimeIds) {
          await client.query(`DELETE FROM agent_runtime WHERE id = $1`, [id]).catch(() => {/* ignore */});
        }
      } finally {
        await client.end();
      }
    }
    this.createdAgentIds = [];
    this.createdRuntimeIds = [];
  }

  getToken() {
    return this.token;
  }

  private async authedFetch(path: string, init?: RequestInit) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
    else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }
}
