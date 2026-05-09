"use client";

import { cn } from "../../lib/utils";

// Curated 4-colour dopamine palettes. Each entry is [base, accent1, accent2,
// accent3]: `base` paints the disc canvas (a soft pastel that lets the
// brighter accents pop without fighting the cream Anthropic page tone), and
// `accent1..3` are the bold cell colours that get sprinkled across the grid.
// Hash(seedId) → palette pick keeps the same actor always landing on the
// same colour story so muscle memory survives across reloads.
const PALETTES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["#FFE4D2", "#FF6B9D", "#7C5CFF", "#FFD93D"], // peach base · pink violet sun
  ["#D9F5EC", "#10B981", "#22D3EE", "#FF8B3D"], // mint base · emerald cyan orange
  ["#E8DAFF", "#A855F7", "#FF6B9D", "#FFD93D"], // lilac base · violet pink sun
  ["#FFDFE9", "#FF2BD6", "#7C5CFF", "#22D3EE"], // pink-cream base · magenta violet cyan
  ["#FFE9C9", "#FF6B35", "#A855F7", "#10B981"], // sand base · sunset violet emerald
  ["#D5F0FF", "#22D3EE", "#7C5CFF", "#FF6B9D"], // sky base · cyan violet pink
  ["#FFDDC5", "#F472B6", "#FFC857", "#7C5CFF"], // apricot · pink amber violet
  ["#E1FFD9", "#10B981", "#FF8B3D", "#A855F7"], // honeydew · emerald orange violet
];

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const GRID = 5;
const VIEW = 80;
const CELL = VIEW / GRID; // 16

/**
 * Build the cell pattern: 5×5 grid mirrored across the vertical axis (so
 * the left 3 columns drive the right 2 columns), giving 15 hash-decided
 * cells and a symmetric overall identicon. Each cell either fills with a
 * hash-picked accent colour or stays transparent (showing the disc's base
 * fill). ~60% fill rate keeps the discs visually busy without becoming
 * solid blocks.
 */
function buildCells(seed: number): Array<{ x: number; y: number; colour: number }> {
  const cells: Array<{ x: number; y: number; colour: number }> = [];
  let s = seed >>> 0;
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col <= 2; col++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const filled = (s >>> 24) > 100; // ~60% fill rate
      if (!filled) continue;
      const colour = ((s >>> 12) & 0x3); // 0–3, 0 means "skip" (show base)
      if (colour === 0) continue;
      cells.push({ x: col, y: row, colour });
      if (col < 2) {
        cells.push({ x: GRID - 1 - col, y: row, colour });
      }
    }
  }
  return cells;
}

export interface IdenticonAvatarProps {
  /**
   * Stable identifier used to seed both the palette pick and cell pattern.
   * Pass the actor's UUID — same id always renders the same identicon.
   */
  seedId: string;
  size?: number;
  className?: string;
  title?: string;
  /**
   * Wrap the identicon in a perfect circle. Default true. Set false if the
   * caller is composing inside another shape (square thumbnails, etc).
   */
  rounded?: boolean;
}

/**
 * Granular GitHub-identicon-style avatar — generative SVG, no text.
 *
 * 5×5 mirror grid + 8 dopamine palettes + crisp tile rendering. Used
 * everywhere a default actor avatar is needed: channel rows, sidebar
 * agent expansion, agent detail header, member list chips. The same
 * seedId always lights up the same disc so muscle memory survives;
 * different ids never collide.
 */
export function IdenticonAvatar({
  seedId,
  size = 32,
  className,
  title,
  rounded = true,
}: IdenticonAvatarProps) {
  const seed = hashCode(seedId);
  const palette = PALETTES[seed % PALETTES.length]!;
  const idSlug = `id-${seed.toString(36)}`;
  const cells = buildCells(seed);

  const PAD = 1;
  const RX = 2;

  return (
    <svg
      data-slot="identicon"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      className={cn("shrink-0", className)}
      role={title ? "img" : "presentation"}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <defs>
        <mask id={`${idSlug}-mask`}>
          <rect
            width={VIEW}
            height={VIEW}
            rx={rounded ? VIEW / 2 : RX * 2}
            fill="#fff"
          />
        </mask>
      </defs>
      <g mask={`url(#${idSlug}-mask)`}>
        <rect width={VIEW} height={VIEW} fill={palette[0]} />
        {cells.map((c, i) => (
          <rect
            key={i}
            x={c.x * CELL + PAD}
            y={c.y * CELL + PAD}
            width={CELL - PAD * 2}
            height={CELL - PAD * 2}
            rx={RX}
            fill={palette[c.colour]}
          />
        ))}
      </g>
    </svg>
  );
}
