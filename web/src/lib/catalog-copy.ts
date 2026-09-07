/**
 * Localization for text that originates in the app-server model catalog.
 *
 * The app-server has no locale primitive — neither `model/list` nor
 * `initialize` accepts one — so catalog copy always arrives in English. This
 * app already keys its translations by the English source string, so a lookup
 * covers whatever we have translated and leaves everything else in English.
 */
import i18n from '@/i18n';

/**
 * Returns the translation for a catalog string, or the string unchanged.
 *
 * Deliberately not a bare `t(value)`: i18next resolves `$t(...)` nesting even
 * for a missing key, so passing arbitrary upstream prose through `t()` can
 * silently rewrite it. Checking for an actual entry first means untranslated
 * copy is reproduced verbatim.
 *
 * @param value - English copy exactly as the catalog supplied it.
 * @returns The localized string when one exists, otherwise `value` untouched.
 */
export function catalogCopy(value: string): string {
  return i18n.exists(value) ? i18n.t(value) : value;
}
