// Pure decision logic for the "Publish changes" feature -- deliberately free of any
// Obsidian API (App/Vault/TFile/...) so it's unit-testable without a real Obsidian
// environment, same reasoning as pluginSync.ts. Consumed by publishModal.ts, which supplies
// the Obsidian-specific inputs (frontmatter reads, folder membership, content hashing, the
// server file list).
//
// Rewritten to match real Obsidian Publish's actual eligibility rules exactly (see
// 18_publish_게재_자격_실제_옵시디언과_동일화.md -- confirmed via obsidian.asar analysis, not
// guessed): a file is only ever dropped from consideration when it's explicitly excluded
// (publish: false, or a folder-fallback that resolves to false); everything else (explicit
// publish: true, or an undetermined flag that isn't excluded) is listed, differing only in
// whether it starts pre-checked. This also restores folder-based fallback eligibility, which is
// the *only* way a file type that can't carry frontmatter at all (image/canvas/pdf/etc. --
// nothing but .md ever gets a frontmatter cache) can become publishable.

export type DiffType = "new" | "changed" | "unchanged" | "to-delete" | "deleted";

export interface SingleFileDiffItem {
  path: string;
  serverHash: string;
  type: DiffType;
  checked: boolean;
}

export interface Classification {
  type: DiffType;
  checked: boolean;
}

export interface ExistingFileClassification {
  publishFlag: boolean | null;
  contentChanged: boolean;
}

/**
 * Parses a raw `publish` frontmatter value the same way real Obsidian Publish does (confirmed
 * via obsidian.asar analysis -- see 17_옵시디언_퍼블리시_프론트매터_속성.md): a string is
 * lowercased and matched against true/false/yes/no; anything else (including a non-matching
 * string, or a non-string/non-boolean value like a number) falls back to plain JS truthiness,
 * same as real Obsidian's `return !!n`. null/undefined (the field isn't set at all) is the one
 * case treated specially -- it returns null rather than false, since callers need to tell
 * "explicitly turned off" apart from "not mentioned at all" (the latter falls back to folder
 * include/exclude settings, see resolvePublishFlag below).
 */
export function parsePublishFlag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "false" || lower === "no") return false;
    if (lower === "true" || lower === "yes") return true;
  }
  return Boolean(value);
}

/**
 * Parses a raw `permalink` frontmatter value the same way real Obsidian Publish's
 * Site.getPublicHref does (confirmed via obsidian.asar analysis -- see
 * 19_permalink_지원.md): only a truthy string overrides the default path-based URL. Unlike
 * parsePublishFlag, a non-string value (number, boolean, array...) is NOT coerced by
 * truthiness -- it's ignored outright, matching real Obsidian's own `typeof r === "string"`
 * guard. A single leading "/" is stripped (only one -- "//x" keeps one slash).
 */
export function parsePermalink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.startsWith("/") ? value.substring(1) : value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parses a raw `description` frontmatter value. Unlike parsePermalink, real Obsidian's public
 * docs (obsidian.md/help/Obsidian+Publish/Social+media+link+previews -- confirmed via web
 * research, not app.js, since this logic lives in Publish's site-side renderer rather than the
 * desktop app -- see 20_description_image_지원.md) describe no transformation beyond "is it set":
 * a non-empty string passes through unchanged, everything else is "not set".
 */
export function parseDescription(value: unknown): string | null {
  return nonEmptyString(value);
}

/**
 * Parses a raw `image` frontmatter value (real Obsidian treats `cover` as an identical alias,
 * deliberately not supported here per this session's own scoping decision -- see
 * 20_description_image_지원.md). A non-empty string is returned unchanged whether it's a
 * vault-relative path or an external URL -- resolving which is the server's job.
 */
export function parseImagePath(value: unknown): string | null {
  return nonEmptyString(value);
}

/**
 * Parses a raw `aliases` frontmatter value for Publish's old-URL redirect feature (see
 * 22_aliases_리다이렉트_및_파비콘_자동감지.md -- confirmed via obsidian.asar: Site's aliases
 * lookup map is built from exactly this shape). Accepts either a string array (the normal YAML
 * list form) or a single bare string (normalized to a one-element array, since a List-type
 * property's raw frontmatter value is sometimes just a plain string). Each entry is trimmed;
 * empty/whitespace-only or non-string entries are dropped. Returns null when nothing is left.
 */
export function parseAliases(value: unknown): string[] | null {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!raw) return null;
  const cleaned = raw.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(v => v.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Real Obsidian's getPublishFlag folder-fallback: an explicit frontmatter value always wins
 * outright (checked upstream by the caller -- this function is only reached when
 * `explicitFlag` is null, i.e. the frontmatter has no publish field at all, which is every
 * file that isn't .md, plus any .md with no explicit field). Excluded folder is checked before
 * included folder, matching real Obsidian's own precedence.
 */
export function resolvePublishFlag(
  explicitFlag: boolean | null,
  isUnderExcludedFolder: boolean,
  isUnderIncludedFolder: boolean
): boolean | null {
  if (explicitFlag !== null) return explicitFlag;
  if (isUnderExcludedFolder) return false;
  if (isUnderIncludedFolder) return true;
  return null;
}

const SUPPORTED_EXTENSIONS = new Set([
  "bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif",
  "mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus",
  "mp4", "webm", "ogv", "mov", "mkv",
  "pdf", "md", "canvas",
]);
const SUPPORTED_FILENAMES = new Set(["obsidian.css", "publish.css", "favicon.ico", "publish.js"]);

/**
 * Real Obsidian's isFileSupported: an extension whitelist, or one of a handful of special
 * site-asset filenames regardless of extension (site customization files, not real vault
 * content).
 */
export function isPublishSupportedFile(extension: string, filename: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extension.toLowerCase()) || SUPPORTED_FILENAMES.has(filename);
}

/**
 * Decides what to do with a file that's already published on the server, given its resolved
 * publish flag and whether its local content differs from the server's copy. Only
 * `publishFlag === false` drops it into the removal bucket -- a content change is always shown
 * as "changed" (never silently reclassified as a removal) regardless of whether the flag is
 * `true` or merely undetermined (`null`); only the pre-checked state differs. Unchecked by
 * default for the removal bucket too, matching real Obsidian exactly -- pumice's own
 * confirmation modal (always shown before anything actually uploads/removes) is the safety net
 * that makes this safe, not an auto-check.
 */
export function classifyExistingFile({ publishFlag, contentChanged }: ExistingFileClassification): Classification {
  if (publishFlag !== false) {
    if (contentChanged) return { type: "changed", checked: publishFlag === true };
    return { type: "unchanged", checked: false };
  }
  return { type: "to-delete", checked: false };
}

/**
 * Whether a file NOT yet on the server should appear as a "new" publish candidate, and whether
 * it starts pre-checked. Only an explicit (or folder-resolved) `publishFlag === false` excludes
 * it from the list entirely -- an undetermined flag still gets listed, just unchecked, which is
 * what makes a file type that can never carry its own frontmatter (image/canvas/pdf/etc.)
 * publishable again via folder inclusion or a manual check.
 */
export function classifyNewFile(publishFlag: boolean | null): { checked: boolean } | null {
  if (publishFlag === false) return null;
  return { checked: publishFlag === true };
}

/**
 * "Publish current file" (the file context-menu action). Deliberately skips fetching the
 * server's file list (unlike the general scan) since the user already told us what they want;
 * publish:false always produces a to-delete attempt rather than first checking whether the file
 * is actually on the server, trusting the server's own remove endpoint to be a harmless no-op
 * if there was nothing to remove. A null (undetermined) flag is treated the same as true --
 * matches real Obsidian, which never blocks this action on an undetermined flag either.
 */
export function scanSingleFile(path: string, publishFlag: boolean | null): SingleFileDiffItem[] {
  const type: DiffType = publishFlag === false ? "to-delete" : "new";
  return [{ path, serverHash: "", type, checked: true }];
}
