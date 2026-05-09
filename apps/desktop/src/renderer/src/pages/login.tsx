import { LoginPage } from "@folio/views/auth";
import { DragStrip } from "@folio/views/platform";
import { FolioIcon } from "@folio/ui/components/common/folio-icon";

export function DesktopLoginPage() {
  return (
    <div className="flex h-screen flex-col">
      <DragStrip />
      <LoginPage
        logo={<FolioIcon bordered size="lg" />}
        onSuccess={() => {
          // Auth store update triggers AppContent re-render → shows DesktopShell.
          // Initial workspace navigation happens in routes.tsx via IndexRedirect.
        }}
      />
    </div>
  );
}
