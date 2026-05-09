"use client";

import { toast } from "sonner";
import { cn } from "@folio/ui/lib/utils";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@folio/core/i18n";
import { useLocaleAdapter } from "@folio/core/i18n/react";
import { useAuthStore } from "@folio/core/auth";
import { api } from "@folio/core/api";
import { useT } from "../../i18n";

export function PreferencesTab() {
  const { t, i18n } = useT("settings");
  const localeAdapter = useLocaleAdapter();
  const user = useAuthStore((s) => s.user);

  // i18next.language can be a region-tagged BCP-47 string (e.g. "en-US",
  // "zh-Hans-CN") returned by intl-localematcher. Normalize to a supported
  // locale before comparing — otherwise the radio shows neither option active.
  const currentLocale: SupportedLocale = SUPPORTED_LOCALES.includes(
    i18n.language as SupportedLocale,
  )
    ? (i18n.language as SupportedLocale)
    : DEFAULT_LOCALE;

  const languageOptions: { value: SupportedLocale; label: string }[] = [
    { value: "en", label: t(($) => $.preferences.language.english) },
    { value: "zh-Hans", label: t(($) => $.preferences.language.chinese) },
  ];

  // Persist locally → sync to user.language → reload. Reload (vs in-place
  // changeLanguage) avoids hydration mismatch and is the i18next-recommended
  // pattern for App Router.
  //
  // If the cross-device sync (PATCH /api/me) fails, the local cookie is
  // already written so the new locale will take effect after reload — but
  // the user's other devices won't see the change. Surface that explicitly
  // via a toast and delay the reload long enough for the toast to be read,
  // otherwise the failure would be invisible.
  const handleLanguageChange = async (next: SupportedLocale) => {
    if (next === currentLocale) return;
    localeAdapter.persist(next);

    let syncFailed = false;
    if (user) {
      try {
        await api.updateMe({ language: next });
      } catch {
        syncFailed = true;
      }
    }

    if (syncFailed) {
      toast.warning(t(($) => $.preferences.language.sync_failed));
      // Give the toast 2.5s of visible time before navigating away.
      setTimeout(() => window.location.reload(), 2500);
      return;
    }
    window.location.reload();
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">
          {t(($) => $.preferences.language.title)}
        </h2>
        <div className="flex gap-3" role="radiogroup">
          {languageOptions.map((opt) => {
            const active = currentLocale === opt.value;
            return (
              <button
                key={opt.value}
                role="radio"
                aria-checked={active}
                onClick={() => handleLanguageChange(opt.value)}
                className={cn(
                  "rounded-md border px-4 py-2 text-sm transition-colors",
                  active
                    ? "border-brand bg-brand/10 font-medium text-foreground"
                    : "border-border text-muted-foreground hover:border-foreground/30"
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
