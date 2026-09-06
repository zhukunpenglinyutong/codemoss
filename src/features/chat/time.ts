import i18n from "@/lib/i18n";

/** Compact relative timestamp for sidebar rows ("now" / "5m" / "3h" / "2d",
 * localized via the time.* resource keys). Beyond 30 days, a locale date. */
export function relativeTime(ms: number | null): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return i18n.t("time.now");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return i18n.t("time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t("time.hours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return i18n.t("time.days", { count: days });
  return new Date(ms).toLocaleDateString();
}
