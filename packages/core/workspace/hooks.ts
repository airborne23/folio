"use client";

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "../hooks";
import { memberListOptions, agentListOptions } from "./queries";

export function useActorName() {
  const wsId = useWorkspaceId();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));

  // Short-id fallback (first 6 hex of UUID) reads like a git SHA stub —
  // always recognisable, never opaque. Used when (a) the lookup query is
  // still in flight, or (b) the actor is genuinely missing (deleted user,
  // archived agent). Both cases are strictly more legible than the stock
  // "Unknown" label, and once the query lands the real name takes over.
  const shortId = (id: string) => id.slice(0, 6);

  const getMemberName = (userId: string) => {
    const m = members.find((m) => m.user_id === userId);
    return m?.name ?? `Member ${shortId(userId)}`;
  };

  const getAgentName = (agentId: string) => {
    const a = agents.find((a) => a.id === agentId);
    return a?.name ?? `Agent ${shortId(agentId)}`;
  };

  const getActorName = (type: string, id: string) => {
    if (type === "member") return getMemberName(id);
    if (type === "agent") return getAgentName(id);
    return "System";
  };

  const getActorInitials = (type: string, id: string) => {
    const name = getActorName(type, id);
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const getActorAvatarUrl = (type: string, id: string): string | null => {
    if (type === "member") return members.find((m) => m.user_id === id)?.avatar_url ?? null;
    if (type === "agent") return agents.find((a) => a.id === id)?.avatar_url ?? null;
    return null;
  };

  return { getMemberName, getAgentName, getActorName, getActorInitials, getActorAvatarUrl };
}
