import { useState, useEffect } from "react";
import { cn } from "../../lib/utils";

interface FolioIconProps extends React.ComponentProps<"span"> {
  /** Play a one-time entrance fade-in. The legacy spin doesn't fit a
   *  spread-of-pages glyph that has a clear vertical axis, so we keep
   *  the prop but remove the rotation animation. */
  animate?: boolean;
  /** Legacy — kept for API compatibility, no longer wires to anything. */
  noSpin?: boolean;
  /** Frame the glyph in a rounded square with a 1px ink-line border. */
  bordered?: boolean;
  /** Size of the bordered icon: "sm" (default), "md", "lg". */
  size?: "sm" | "md" | "lg";
}

const borderedSizes = {
  sm: { wrapper: "p-1.5", icon: "size-3.5" },
  md: { wrapper: "p-2", icon: "size-4" },
  lg: { wrapper: "p-2.5", icon: "size-5" },
};

/**
 * Folio brand mark — open-spread folio: two ink-stroked pages with a
 * caramel spine seam. Six faint inner rules suggest ruled paper. Uses
 * stroke colour `currentColor` for the page outlines so the icon picks
 * up the surrounding text colour (sidebar foreground in headers, etc),
 * while the caramel spine stays anchored to the brand token.
 *
 * Renders as inline SVG (not a clip-path polygon, the way the legacy
 * 8-point asterisk did) — geometric strokes don't survive clip-path,
 * and the spread + spine + rule lines need real <line> primitives to
 * stay crisp at every size.
 */
export function FolioIcon({
  className,
  animate = false,
  bordered = false,
  size = "sm",
  ...props
}: FolioIconProps) {
  const [entranceDone, setEntranceDone] = useState(!animate);

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setEntranceDone(true), 600);
    return () => clearTimeout(timer);
  }, [animate]);

  const glyph = (
    <svg
      viewBox="0 0 80 80"
      xmlns="http://www.w3.org/2000/svg"
      className="block size-full"
      aria-hidden="true"
    >
      {/* Left page — pulled outward to fill more of the 80×80 viewBox so
          small renders (24-48px) still read as "two pages, not two
          dots." */}
      <rect
        x="8"
        y="14"
        width="28"
        height="52"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
      />
      {/* Right page */}
      <rect
        x="44"
        y="14"
        width="28"
        height="52"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
      />
      {/* Caramel spine — extends slightly beyond the page tops/bottoms
          so it reads as a binding seam rather than a fill bar. */}
      <line
        x1="40"
        y1="11"
        x2="40"
        y2="69"
        stroke="var(--color-brand, #CC785C)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Page rules — two per side, kept faint. We intentionally don't
          try to hide them at small sizes: at 16px they collapse into
          texture rather than render as crisp lines, which is fine. */}
      <g stroke="currentColor" strokeWidth="1.2" opacity="0.20">
        <line x1="14" y1="28" x2="32" y2="28" />
        <line x1="14" y1="36" x2="30" y2="36" />
        <line x1="48" y1="28" x2="66" y2="28" />
        <line x1="48" y1="36" x2="64" y2="36" />
      </g>
    </svg>
  );

  if (bordered) {
    const sizeConfig = borderedSizes[size];
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center border border-border rounded-md",
          sizeConfig.wrapper,
          className,
        )}
        aria-hidden="true"
        {...props}
      >
        <span
          className={cn(
            "block",
            sizeConfig.icon,
            !entranceDone && "animate-onboarding-enter",
          )}
        >
          {glyph}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-block size-[1em]",
        !entranceDone && "animate-onboarding-enter",
        className,
      )}
      aria-hidden="true"
      {...props}
    >
      {glyph}
    </span>
  );
}
