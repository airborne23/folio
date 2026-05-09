"use client";

import { DashboardLayout } from "@folio/views/layout";
import { FolioIcon } from "@folio/ui/components/common/folio-icon";
import { SearchCommand, SearchTrigger } from "@folio/views/search";
import { StarterContentPrompt } from "@folio/views/onboarding";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardLayout
      loadingIndicator={<FolioIcon className="size-6" />}
      searchSlot={<SearchTrigger />}
      extra={
        <>
          <SearchCommand />
          <StarterContentPrompt />
        </>
      }
    >
      {children}
    </DashboardLayout>
  );
}
