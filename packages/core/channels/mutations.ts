import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { createLogger } from "../logger";
import type {
  Channel,
  ChannelKind,
  ChannelMessage,
  SubscribeMode,
} from "../types/channel";
import { channelKeys } from "./queries";

const logger = createLogger("channels.mut");

export function useCreateChannel() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      kind: ChannelKind;
      topic?: string;
      default_subscribe_mode?: SubscribeMode;
      agent_cooldown_ms?: number;
      max_consecutive_agent_turns?: number;
    }) => {
      logger.info("createChannel.start", { kind: input.kind });
      return api.createChannel(input);
    },
    onSuccess: (channel) => {
      logger.info("createChannel.success", { channelId: channel.id });
    },
    onError: (err) => {
      logger.error("createChannel.error", err);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
    },
  });
}

export function usePatchChannel(channelId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      topic?: string;
      default_subscribe_mode?: SubscribeMode;
      agent_cooldown_ms?: number;
      max_consecutive_agent_turns?: number;
    }) => {
      logger.info("patchChannel.start", { channelId });
      return api.patchChannel(channelId, input);
    },
    onMutate: async (input) => {
      // Optimistically merge the patch into the cached detail row so the UI
      // reflects the change immediately. Rolls back on error; final invalidate
      // pulls the authoritative server state on settle.
      const detailKey = channelKeys.detail(wsId, channelId);
      await qc.cancelQueries({ queryKey: detailKey });
      const prevDetail = qc.getQueryData<Channel>(detailKey);
      if (prevDetail) {
        const next: Channel = {
          ...prevDetail,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...(input.default_subscribe_mode !== undefined
            ? { default_subscribe_mode: input.default_subscribe_mode }
            : {}),
          ...(input.agent_cooldown_ms !== undefined
            ? { agent_cooldown_ms: input.agent_cooldown_ms }
            : {}),
          ...(input.max_consecutive_agent_turns !== undefined
            ? { max_consecutive_agent_turns: input.max_consecutive_agent_turns }
            : {}),
        };
        qc.setQueryData(detailKey, next);
      }
      return { prevDetail };
    },
    onSuccess: (channel) => {
      logger.info("patchChannel.success", { channelId: channel.id });
    },
    onError: (err, _input, ctx) => {
      logger.error("patchChannel.error.rollback", { channelId, err });
      if (ctx?.prevDetail) {
        qc.setQueryData(channelKeys.detail(wsId, channelId), ctx.prevDetail);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.detail(wsId, channelId) });
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
    },
  });
}

export function useArchiveChannel() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => {
      logger.info("archiveChannel.start", { channelId: id });
      return api.archiveChannel(id);
    },
    onSuccess: (_data, id) => {
      logger.info("archiveChannel.success", { channelId: id });
    },
    onError: (err) => {
      logger.error("archiveChannel.error", err);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.list(wsId) });
    },
  });
}

export function useSendChannelMessage(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { body: string; parentMessageId?: string }) => {
      logger.debug("sendChannelMessage.start", {
        channelId,
        bodyLength: vars.body.length,
        hasParent: !!vars.parentMessageId,
      });
      return api.sendChannelMessage(channelId, vars.body, vars.parentMessageId);
    },
    onMutate: async (vars) => {
      const key = channelKeys.messages(channelId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ChannelMessage[]>(key) ?? [];
      // author_id is "" — the eventual server row carries the authoritative
      // member id. UI rendering of the optimistic row should not key on this
      // field; the row gets fully replaced on settle.
      const optimistic: ChannelMessage = {
        id: `optimistic-${Date.now()}`,
        channel_id: channelId,
        author_type: "member",
        author_id: "",
        body: vars.body,
        parent_message_id: vars.parentMessageId ?? null,
        mentions: [],
        reply_count: 0,
        last_reply_at: null,
        reply_participants: [],
        delivery_status: "complete",
        failure_reason: null,
        task_id: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        reactions: [],
      };
      qc.setQueryData<ChannelMessage[]>(key, [optimistic, ...prev]);
      logger.debug("sendChannelMessage.optimistic", { channelId });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      logger.error("sendChannelMessage.error.rollback", { channelId, err });
      if (ctx?.prev) {
        qc.setQueryData(channelKeys.messages(channelId), ctx.prev);
      }
    },
    onSettled: () => {
      logger.debug("sendChannelMessage.settled", { channelId });
      qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
    },
  });
}

export function useUpsertChannelMember(channelId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (vars: { memberRef: string; subscribe_mode?: SubscribeMode }) => {
      logger.info("upsertChannelMember.start", { channelId, memberRef: vars.memberRef });
      return api.putChannelMember(channelId, vars.memberRef, {
        subscribe_mode: vars.subscribe_mode,
      });
    },
    onSuccess: (_data, vars) => {
      logger.info("upsertChannelMember.success", { channelId, memberRef: vars.memberRef });
    },
    onError: (err) => {
      logger.error("upsertChannelMember.error", { channelId, err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.members(wsId, channelId) });
    },
  });
}

/**
 * Toggle a reaction (add or remove). Optimistically updates the messages
 * cache so the chip flips immediately; the WS event invalidates afterward
 * to confirm. Server-side both endpoints are idempotent so retries are safe.
 */
export function useToggleChannelReaction(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { messageId: string; emoji: string; mine: boolean }) => {
      logger.debug("toggleReaction.start", { channelId, ...vars });
      if (vars.mine) {
        await api.removeChannelReaction(channelId, vars.messageId, vars.emoji);
      } else {
        await api.addChannelReaction(channelId, vars.messageId, vars.emoji);
      }
      return vars;
    },
    onError: (err) => {
      logger.error("toggleReaction.error", { channelId, err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.messages(channelId) });
    },
  });
}

export function useRemoveChannelMember(channelId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (memberRef: string) => {
      logger.info("removeChannelMember.start", { channelId, memberRef });
      return api.removeChannelMember(channelId, memberRef);
    },
    onSuccess: (_data, memberRef) => {
      logger.info("removeChannelMember.success", { channelId, memberRef });
    },
    onError: (err) => {
      logger.error("removeChannelMember.error", { channelId, err });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: channelKeys.members(wsId, channelId) });
    },
  });
}
