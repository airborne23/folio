import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

// NOTE on workspace scoping:
// `wsId` is used only as part of queryKey for cache isolation per workspace.
// The actual workspace context comes from ApiClient's X-Workspace-Slug header,
// which is set by the URL-driven [workspaceSlug] layout. Callers must ensure
// the header is in sync with the wsId they pass here — otherwise cache writes
// will be misattributed during a workspace switch race window.
//
// `messages` keys are workspace-independent because channelId is a globally
// unique UUID (no two channels share an id across workspaces).

export const channelKeys = {
  all: (wsId: string) => ["channels", wsId] as const,
  list: (wsId: string) => [...channelKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) => [...channelKeys.all(wsId), "detail", id] as const,
  members: (wsId: string, id: string) => [...channelKeys.all(wsId), "members", id] as const,
  messages: (channelId: string) => ["channel", "messages", channelId] as const,
  thread: (channelId: string, parentId: string) =>
    ["channel", "thread", channelId, parentId] as const,
};

export function channelListOptions(wsId: string) {
  return queryOptions({
    queryKey: channelKeys.list(wsId),
    queryFn: () => api.listChannels(),
    enabled: !!wsId,
    staleTime: Infinity,
  });
}

export function channelDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: channelKeys.detail(wsId, id),
    queryFn: () => api.getChannel(id),
    enabled: !!id,
    staleTime: Infinity,
  });
}

export function channelMembersOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: channelKeys.members(wsId, id),
    queryFn: () => api.listChannelMembers(id),
    enabled: !!id,
    staleTime: Infinity,
  });
}

export function channelMessagesOptions(channelId: string) {
  return queryOptions({
    queryKey: channelKeys.messages(channelId),
    queryFn: () => api.listChannelMessages(channelId),
    enabled: !!channelId,
    staleTime: Infinity,
  });
}

// Thread fetch is workspace-independent for the same reason channel messages
// are: parent ids are globally unique, and the server already enforces
// channel/parent consistency. The dedicated key (channel + parentId) lets the
// thread:rollup WS event invalidate just one drawer at a time.
export function channelThreadOptions(channelId: string, parentId: string) {
  return queryOptions({
    queryKey: channelKeys.thread(channelId, parentId),
    queryFn: () => api.getChannelThread(channelId, parentId),
    enabled: !!channelId && !!parentId,
    staleTime: Infinity,
  });
}
