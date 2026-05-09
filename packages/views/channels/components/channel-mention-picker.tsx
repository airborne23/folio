"use client";

import { useEffect, useRef, type RefObject } from "react";
import { cn } from "@folio/ui/lib/utils";

export interface MentionCandidate {
  type: "agent" | "member";
  id: string;
  name: string;
  /** Subline shown below the name. Empty agents/members get a fallback. */
  subtitle?: string;
}

/**
 * Floating picker mounted above the composer when the user is typing an
 * @token. Pure presentation — keyboard handling lives in the composer
 * (single source of focus / cursor truth) and gets piped in via props.
 *
 * Anchored absolutely to the parent — caller should `position: relative` the
 * wrapper. Avoids cursor-position math; "above the textarea, left-aligned"
 * is good enough for a 2-row composer.
 */
export function ChannelMentionPicker({
  candidates,
  selectedIndex,
  onPick,
  onHover,
  emptyHint,
  containerRef,
}: {
  candidates: MentionCandidate[];
  selectedIndex: number;
  onPick: (c: MentionCandidate) => void;
  onHover: (index: number) => void;
  emptyHint: string;
  containerRef?: RefObject<HTMLDivElement | null>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? internalRef;

  // Scroll the active item into view when keyboard navigation moves the
  // selection out of the visible window.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      `[data-mention-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, ref]);

  return (
    <div
      ref={ref}
      data-testid="channel-mention-picker"
      role="listbox"
      className="absolute bottom-full left-0 mb-1 z-20 w-64 max-h-64 overflow-y-auto rounded-md border bg-popover shadow-md"
    >
      {candidates.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">{emptyHint}</div>
      ) : (
        <ul className="py-1">
          {candidates.map((c, i) => (
            <li
              key={`${c.type}:${c.id}`}
              role="option"
              aria-selected={i === selectedIndex}
              data-testid="channel-mention-option"
              data-mention-index={i}
              onMouseDown={(e) => {
                // Prevent textarea blur which would close the picker before
                // onPick fires.
                e.preventDefault();
                onPick(c);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                "px-3 py-1.5 text-sm cursor-pointer flex items-center gap-2",
                i === selectedIndex && "bg-accent",
              )}
            >
              <span
                className={cn(
                  "inline-block w-12 shrink-0 text-[10px] uppercase tracking-wide rounded px-1 text-center",
                  c.type === "agent"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {c.type}
              </span>
              <span className="truncate">{c.name}</span>
              {c.subtitle && (
                <span className="ml-auto text-xs text-muted-foreground truncate">
                  {c.subtitle}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
