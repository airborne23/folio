"use client";

import { useState, useEffect } from "react";
import { Bot } from "lucide-react";
import { cn } from "@folio/ui/lib/utils";
import { IdenticonAvatar } from "./identicon-avatar";

interface ActorAvatarProps {
  name: string;
  initials: string;
  avatarUrl?: string | null;
  isAgent?: boolean;
  /**
   * Stable identifier (UUID) used to seed the generative identicon shown
   * when no `avatarUrl` is set. Recommended for every actor surface — the
   * identicon is the unified default avatar across channels, sidebar, and
   * detail pages, so passing seedId means uploading / clearing avatar_url
   * is the only thing that toggles the rendering, and the same actor lights
   * up the same disc everywhere.
   */
  seedId?: string;
  size?: number;
  className?: string;
}

/**
 * Render priority:
 *  1. Uploaded image (avatarUrl + load succeeded)
 *  2. Generative identicon (seedId provided) — the modern default
 *  3. Bot glyph for agents without a seedId (legacy / synthesised actors)
 *  4. Text initials as the final fallback
 *
 * The split between "uploaded image overrides identicon" and "deleting an
 * uploaded image returns to identicon" is intentional and gives the data
 * model the simplest contract: avatar_url is the single source of truth.
 */
function ActorAvatar({
  name,
  initials,
  avatarUrl,
  isAgent,
  seedId,
  size = 20,
  className,
}: ActorAvatarProps) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  const hasImage = avatarUrl && !imgError;

  // The identicon paints its own background, so the wrapper only needs the
  // muted bg/text fallback when neither image nor identicon will render.
  const wrapperFallback = !hasImage && !seedId;

  return (
    <div
      data-slot="avatar"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium overflow-hidden",
        wrapperFallback && "bg-muted text-muted-foreground",
        className
      )}
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      title={name}
    >
      {hasImage ? (
        <img
          src={avatarUrl}
          alt={name}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : seedId ? (
        <IdenticonAvatar seedId={seedId} size={size} title={name} />
      ) : isAgent ? (
        <Bot style={{ width: size * 0.55, height: size * 0.55 }} />
      ) : (
        initials
      )}
    </div>
  );
}

export { ActorAvatar, type ActorAvatarProps };
