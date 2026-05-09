"use client";

import { use } from "react";
import { AutopilotDetailPage } from "@folio/views/autopilots/components";

export default function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <AutopilotDetailPage autopilotId={id} />;
}
