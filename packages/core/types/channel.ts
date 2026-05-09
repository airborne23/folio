export type ChannelKind = "public" | "private" | "group_dm";
export type SubscribeMode = "mention_only" | "subscribe";
export type ChannelMemberType = "member" | "agent";
export type DeliveryStatus = "streaming" | "complete" | "failed";

export interface Channel {
  id: string;
  workspace_id: string;
  name: string | null;
  kind: ChannelKind;
  topic: string | null;
  creator_member_id: string | null;
  archived_at: string | null;
  default_subscribe_mode: SubscribeMode;
  agent_cooldown_ms: number;
  max_consecutive_agent_turns: number;
  consecutive_agent_turns: number;
  created_at: string;
  updated_at: string;
}

export interface ChannelMember {
  id: string;
  channel_id: string;
  member_type: ChannelMemberType;
  member_id: string;
  subscribe_mode: SubscribeMode | null;
  last_replied_at: string | null;
  provider_session_id: string | null;
  last_known_good_session_id: string | null;
  joined_at: string;
}

export interface ChannelMention {
  type: ChannelMemberType;
  id: string;
}

export interface ChannelMessage {
  id: string;
  channel_id: string;
  author_type: ChannelMemberType;
  author_id: string;
  body: string;
  parent_message_id: string | null;
  mentions: ChannelMention[];
  reply_count: number;
  last_reply_at: string | null;
  reply_participants: ChannelMention[];
  delivery_status: DeliveryStatus;
  /**
   * When `delivery_status === "failed"`, this is the server's classification of
   * why the agent reply failed. Known values mirror the chat path:
   * `"agent_error"`, `"connection_error"`, `"timeout"`. The UI maps these to
   * user-facing labels and renders a destructive bubble. `null` for `complete`
   * and `streaming` rows.
   */
  failure_reason: string | null;
  task_id: string | null;
  created_at: string;
  edited_at: string | null;
  /** All reactions on this message. The server attaches this in one round-trip. */
  reactions: ChannelReaction[];
}

export interface ChannelReaction {
  id: string;
  message_id: string;
  reactor_type: ChannelMemberType;
  reactor_id: string;
  emoji: string;
  created_at: string;
}
