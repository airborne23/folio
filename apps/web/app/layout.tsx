import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Inter, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@folio/ui/components/ui/sonner";
import { cn } from "@folio/ui/lib/utils";
import { WebProviders } from "@/components/web-providers";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@folio/core/i18n";
import { RESOURCES } from "@folio/views/locales";
import "./globals.css";

// Font stack: Inter for Latin UI text + system Chinese fonts for zh content.
// Desktop app uses the same stack via apps/desktop/src/renderer/src/globals.css —
// keep the CJK fallback tail in sync across both files. The Inter primary family
// differs by design: next/font produces `__Inter_xxx` (with a synthetic size-adjusted
// fallback face to prevent FOUT layout shift); desktop uses fontsource's "Inter Variable".
// Both resolve to Inter glyphs, so rendering is identical in practice.
// Currently covers English + Simplified Chinese. When ja/ko i18n lands, extend
// the tail with Hiragino Kaku Gothic ProN / Yu Gothic / Apple SD Gothic Neo / Malgun Gothic.
// Per-character fallback: Latin chars render with Inter, Chinese chars with
// PingFang SC (macOS) / Microsoft YaHei (Windows) / Noto Sans CJK SC (Linux).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "PingFang SC",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "sans-serif",
  ],
});
// Mono font has no explicit CJK fallback: CJK chars in code blocks are inherently
// non-aligned with a mono grid (Chinese is proportional), so listing CJK fonts
// here would falsely signal alignment guarantees. Browser default fallback handles
// the rare mixed case correctly.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
// Editorial serif used for onboarding headlines. Italic support for h1 em
// accents (e.g. "...on one shared board."). Only loaded on routes that
// render the font; layout-shift-prevention handled by next/font's synthetic
// fallback metrics, same as Inter.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  fallback: [
    "ui-serif",
    "Iowan Old Style",
    "Apple Garamond",
    "Baskerville",
    "Times New Roman",
    "serif",
  ],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // App is locked to a single cream theme (forcedTheme="light" in
  // ThemeProvider); using one warm-cream colour for both prefers-color-scheme
  // values keeps the mobile address-bar tint consistent with the canvas
  // regardless of the OS preference.
  themeColor: "#f5f0e5",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.folio.ai"),
  title: {
    default: "Folio — Project Management for Human + Agent Teams",
    template: "%s | Folio",
  },
  description:
    "Open-source platform that turns coding agents into real teammates. Assign tasks, track progress, compound skills.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
  },
  openGraph: {
    type: "website",
    siteName: "Folio",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@folio_hq",
    creator: "@folio_hq",
  },
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

function isSupportedLocale(value: string | null): value is SupportedLocale {
  return value !== null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// HTML lang attribute uses BCP-47 region tags that screen readers and font
// stacks recognize widely. i18next keeps `zh-Hans` as its internal locale
// (script subtag is what we actually translate against), but the html element
// expects a region-flavoured tag for accessibility tooling and CJK fallback.
const HTML_LANG: Record<SupportedLocale, string> = {
  en: "en",
  "zh-Hans": "zh-CN",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const h = await headers();
  const headerLocale = h.get("x-folio-locale");
  const locale: SupportedLocale = isSupportedLocale(headerLocale)
    ? headerLocale
    : DEFAULT_LOCALE;
  const resources = { [locale]: RESOURCES[locale] };

  return (
    <html
      lang={HTML_LANG[locale]}
      suppressHydrationWarning
      className={cn("antialiased font-sans h-full", inter.variable, geistMono.variable, sourceSerif.variable)}
    >
      <body className="h-full overflow-hidden">
        <ThemeProvider>
          <WebProviders locale={locale} resources={resources}>
            {children}
          </WebProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
