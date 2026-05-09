"use client";

import { Bot } from "lucide-react";
import { cn } from "@folio/ui/lib/utils";
import { IdenticonAvatar } from "@folio/ui/components/common/identicon-avatar";

/**
 * Channel-row avatar — wraps the shared <IdenticonAvatar> with a
 * channel-specific Bot overlay. Same `authorId` → same identicon disc the
 * sidebar / agents page / hover cards render, so an agent's avatar reads
 * identically wherever it surfaces; uploading a real avatar is the only
 * thing that toggles the visual (and that's a single source of truth on
 * the agent record).
 */
export function ChannelAuthorAvatar({
  authorId,
  authorName,
  isAgent,
  size = 32,
  className,
}: {
  authorId: string;
  authorName: string;
  isAgent: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      data-slot="channel-avatar"
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <IdenticonAvatar
        seedId={authorId || authorName}
        size={size}
        title={authorName}
      />
      {isAgent && (
        <span
          aria-hidden="true"
          className="absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-full bg-background text-foreground ring-1 ring-foreground/15"
          style={{
            width: Math.round(size * 0.45),
            height: Math.round(size * 0.45),
          }}
        >
          <Bot
            style={{
              width: Math.round(size * 0.3),
              height: Math.round(size * 0.3),
            }}
          />
        </span>
      )}
    </span>
  );
}
