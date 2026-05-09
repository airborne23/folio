import type { IssueStatus } from "@folio/core/types";
import { StatusIcon } from "./status-icon";
import { useT } from "../../i18n";

/**
 * Kanban column / section heading. Anthropic-editorial styling: small caps,
 * tracked-out, with the count rendered in monospace as a marginal annotation
 * rather than an inline number — gives the column header a "magazine
 * department" look (DOING · 04) instead of a UI chip.
 */
export function StatusHeading({
  status,
  count,
}: {
  status: IssueStatus;
  count: number;
}) {
  const { t } = useT("issues");
  return (
    <div className="flex items-baseline gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/85">
        <StatusIcon status={status} className="h-3 w-3" />
        {t(($) => $.status[status])}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
        {count.toString().padStart(2, "0")}
      </span>
    </div>
  );
}
