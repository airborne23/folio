import { ChannelsListPage as ChannelsListPageView } from "@folio/views/channels";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function ChannelsListPage() {
  useDocumentTitle("Channels");
  return <ChannelsListPageView />;
}
