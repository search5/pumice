// Pure logic for Site collaboration (별도 대형 기능, see 36_실제_아키텍처_전환_
// Site_collaboration.md) -- deliberately free of any Obsidian API, same reasoning as
// publishEligibility.ts/navigationOrdering.ts.

export interface SharedSite {
  owner: string;
  vaultId: string;
  siteName: string;
}

// Alphabetical by siteName, tie-broken by owner then vaultId for a stable order when two shared
// sites happen to have the same display name. Non-mutating.
export function sortSharedSites(sites: SharedSite[]): SharedSite[] {
  return [...sites].sort((a, b) =>
    a.siteName.localeCompare(b.siteName) ||
    a.owner.localeCompare(b.owner) ||
    a.vaultId.localeCompare(b.vaultId)
  );
}

// Generalizes PublishModal's own site-URL construction (previously private buildSiteUrl(username),
// which always assumed the current vault's own name) to take an explicit owner+vaultId -- used
// both for a collaborator's remote site and for the caller's own vault. vaultId is now also
// percent-encoded (the original didn't encode it, only username) -- a small, deliberate fix while
// generalizing this: a vault_id containing spaces or other URL-unsafe characters previously
// produced a broken link.
export function buildRemoteSiteUrl(
  protocol: "http" | "https",
  host: string,
  port: string | number,
  site: Pick<SharedSite, "owner" | "vaultId">
): string {
  const resolvedHost = host === "localhost" ? "127.0.0.1" : host;
  return `${protocol}://${resolvedHost}:${port}/publish/${encodeURIComponent(site.owner)}/${encodeURIComponent(site.vaultId)}/`;
}
