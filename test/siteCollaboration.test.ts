import { describe, expect, it } from "vitest";
import { buildRemoteSiteUrl, sortSharedSites, type SharedSite } from "../src/siteCollaboration";

describe("buildRemoteSiteUrl", () => {
  it("builds an https URL with owner and vaultId percent-encoded", () => {
    const url = buildRemoteSiteUrl("https", "example.com", 8443, { owner: "alice", vaultId: "vault1" });
    expect(url).toBe("https://example.com:8443/publish/alice/vault1/");
  });

  it("builds an http URL", () => {
    const url = buildRemoteSiteUrl("http", "example.com", 8080, { owner: "alice", vaultId: "vault1" });
    expect(url).toBe("http://example.com:8080/publish/alice/vault1/");
  });

  it("substitutes localhost with 127.0.0.1", () => {
    const url = buildRemoteSiteUrl("http", "localhost", 8080, { owner: "alice", vaultId: "vault1" });
    expect(url).toBe("http://127.0.0.1:8080/publish/alice/vault1/");
  });

  it("percent-encodes owner and vaultId containing special characters", () => {
    const url = buildRemoteSiteUrl("https", "example.com", 443, { owner: "a b", vaultId: "My Vault/x" });
    expect(url).toBe("https://example.com:443/publish/a%20b/My%20Vault%2Fx/");
  });
});

describe("sortSharedSites", () => {
  const site = (siteName: string, owner = "owner", vaultId = "v"): SharedSite => ({ owner, vaultId, siteName });

  it("sorts alphabetically by siteName", () => {
    const sites = [site("Zeta"), site("Alpha"), site("Mid")];
    expect(sortSharedSites(sites).map((s) => s.siteName)).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  it("tie-breaks by owner, then vaultId, when siteName is identical", () => {
    const sites = [
      site("Same", "bob", "v2"),
      site("Same", "alice", "v2"),
      site("Same", "alice", "v1"),
    ];
    const sorted = sortSharedSites(sites);
    expect(sorted.map((s) => `${s.owner}/${s.vaultId}`)).toEqual(["alice/v1", "alice/v2", "bob/v2"]);
  });

  it("does not mutate the input array", () => {
    const sites = [site("Zeta"), site("Alpha")];
    const original = [...sites];
    sortSharedSites(sites);
    expect(sites).toEqual(original);
  });

  it("returns an empty array for empty input", () => {
    expect(sortSharedSites([])).toEqual([]);
  });
});
