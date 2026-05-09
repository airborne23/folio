"use client";

import { use } from "react";
import { ChannelView } from "@folio/views/channels";

export default function ChannelDetailRoute({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const { channelId } = use(params);
  return <ChannelView channelId={channelId} />;
}
