import { cn } from "../../lib/utils";

interface AsteriskProps extends React.ComponentProps<"span"> {
  /**
   * Whether to slightly tilt the glyph for a hand-set printed look. Useful in
   * editorial section dividers; off by default so list-prefix usage stays
   * grid-aligned with surrounding numerals.
   */
  tilt?: boolean;
}

/**
 * Editorial ✻ asterisk motif (U+273B). Used as a secondary brand glyph for
 * section dividers, list-item prefixes, and chapter markers — counterpart to
 * <FolioIcon /> which remains the primary identity mark.
 *
 * Renders the character, not an SVG: this lets it inherit font-feature-settings
 * and obeys text-autospace alongside CJK content (sidebars and headings often
 * mix both). Caller controls colour via text-* utilities; default uses the
 * caramel brand accent so the glyph reads as a deliberate motif rather than a
 * neutral bullet.
 */
export function Asterisk({ className, tilt = false, ...props }: AsteriskProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block font-serif text-brand leading-none select-none",
        tilt && "rotate-[8deg]",
        className,
      )}
      {...props}
    >
      ✻
    </span>
  );
}
