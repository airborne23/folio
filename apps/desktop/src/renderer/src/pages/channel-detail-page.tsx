import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChannelView } from "@folio/views/channels";
import { useWorkspaceId } from "@folio/core/hooks";
import { channelDetailOptions } from "@folio/core/channels";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function ChannelDetailPage() {
  const { channelId } = useParams<{ channelId: string }>();
  const wsId = useWorkspaceId();
  const { data: channel } = useQuery({
    ...channelDetailOptions(wsId, channelId ?? ""),
    enabled: !!channelId,
  });

  useDocumentTitle(channel?.name ?? "Channel");

  if (!channelId) return null;
  return <ChannelView channelId={channelId} />;
}
