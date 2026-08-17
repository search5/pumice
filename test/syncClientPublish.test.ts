import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "obsidian";
import type { RequestUrlParam } from "obsidian";
import { fakeFileManager, fakeTransport, fakeVault, makeClient } from "./syncClientTestUtils";

// Closes the last gap toward syncClient.ts's 80%+ coverage target (see llm-wiki/10-*.md) --
// the Publish feature's REST methods (getPublishHost through the end of the file). These are a
// separate feature (publishing notes to a public site) bolted onto SyncClient, not sync/E2EE/
// history core logic, but they're mechanically simple REST wrappers around httpFetch()/
// requestUrl(), so covering them is cheap once requestUrl itself can be mocked per test.
//
// test/obsidianTestStub.ts's requestUrl() throws unconditionally (real HTTP is never meant to
// happen in a test) -- vi.mock("obsidian", ...) here overrides just that one export for this
// file only, everything else (TFile, Notice, etc.) keeps coming from the real stub via
// importActual.

vi.mock("obsidian", async (importActual) => {
  const actual = await importActual<typeof import("obsidian")>();
  return { ...actual, requestUrl: vi.fn() };
});

const mockedRequestUrl = vi.mocked(requestUrl);

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
}

function mockHttp(response: MockResponse): void {
  mockedRequestUrl.mockResolvedValue({
    status: response.status,
    headers: response.headers ?? {},
    text: response.text ?? "",
    json: response.json,
    arrayBuffer: response.arrayBuffer ?? new ArrayBuffer(0),
  } as Awaited<ReturnType<typeof requestUrl>>);
}

beforeEach(() => {
  mockedRequestUrl.mockReset();
});

// requestUrl's real signature accepts `string | RequestUrlParam`, so TS can't narrow
// mock.calls[0][0] to the object shape on its own -- every call site in this file always passes
// the object form, so this cast is safe.
function lastCall(): RequestUrlParam {
  return mockedRequestUrl.mock.calls.at(-1)![0] as RequestUrlParam;
}

describe("SyncClient.getPublishHost", () => {
  it("builds the host URL from useTls/serverHost/serverPort", () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    expect(client.getPublishHost()).toBe("http://localhost:8080");
  });
});

describe("SyncClient.getAuthenticatedUsername", () => {
  it("returns the username from /api/token/info", async () => {
    mockHttp({ status: 200, json: { username: "alice" } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const username = await client.getAuthenticatedUsername();

    expect(username).toBe("alice");
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/token/info");
  });

  it("returns null on a non-ok response", async () => {
    mockHttp({ status: 401, json: { username: null } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getAuthenticatedUsername()).toBeNull();
  });

  it("returns null if the request throws", async () => {
    mockedRequestUrl.mockRejectedValue(new Error("network down"));
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getAuthenticatedUsername()).toBeNull();
  });
});

describe("SyncClient.publishFile", () => {
  it("uploads the file's content and returns its hash", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    const hash = await client.publishFile("note.md");

    expect(hash).toHaveLength(64);
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/upload");
    expect(call.headers?.["obs-path"]).toBe(encodeURIComponent("note.md"));
    expect(call.headers?.["obs-hash"]).toBe(hash);
  });

  it("rejects a file over the 50MB limit without making a request", async () => {
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new ArrayBuffer(50 * 1024 * 1024 + 1));
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await expect(client.publishFile("big.md")).rejects.toThrow();
    expect(mockedRequestUrl).not.toHaveBeenCalled();
  });

  it("throws with the server's error text on a failed upload", async () => {
    mockHttp({ status: 500, text: "disk full" });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await expect(client.publishFile("note.md")).rejects.toThrow(/disk full/);
  });

  it("sends the permalink as a URL-encoded obs-permalink header when given", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md", { permalink: "custom/url slug" });

    const call = lastCall();
    expect(call.headers?.["obs-permalink"]).toBe(encodeURIComponent("custom/url slug"));
  });

  it("omits the obs-permalink header when the permalink is missing, null, or empty", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md");
    expect(lastCall().headers?.["obs-permalink"]).toBeUndefined();

    await client.publishFile("note.md", { permalink: null });
    expect(lastCall().headers?.["obs-permalink"]).toBeUndefined();

    await client.publishFile("note.md", { permalink: "" });
    expect(lastCall().headers?.["obs-permalink"]).toBeUndefined();
  });

  it("sends the description as a URL-encoded obs-description header when given", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md", { description: "A neat note about cats & dogs." });

    const call = lastCall();
    expect(call.headers?.["obs-description"]).toBe(encodeURIComponent("A neat note about cats & dogs."));
  });

  it("omits the obs-description header when the description is missing, null, or empty", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md");
    expect(lastCall().headers?.["obs-description"]).toBeUndefined();

    await client.publishFile("note.md", { description: null });
    expect(lastCall().headers?.["obs-description"]).toBeUndefined();

    await client.publishFile("note.md", { description: "" });
    expect(lastCall().headers?.["obs-description"]).toBeUndefined();
  });

  it("sends the image as a URL-encoded obs-image header when given", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md", { image: "Attachments/cover.png" });

    const call = lastCall();
    expect(call.headers?.["obs-image"]).toBe(encodeURIComponent("Attachments/cover.png"));
  });

  it("omits the obs-image header when the image is missing, null, or empty", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md");
    expect(lastCall().headers?.["obs-image"]).toBeUndefined();

    await client.publishFile("note.md", { image: null });
    expect(lastCall().headers?.["obs-image"]).toBeUndefined();

    await client.publishFile("note.md", { image: "" });
    expect(lastCall().headers?.["obs-image"]).toBeUndefined();
  });

  it("sends all four meta headers together when all are given", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md", {
      permalink: "p", description: "d", image: "i.png", aliases: ["Old/Path", "Older/Path"],
    });

    const call = lastCall();
    expect(call.headers?.["obs-permalink"]).toBe("p");
    expect(call.headers?.["obs-description"]).toBe("d");
    expect(call.headers?.["obs-image"]).toBe("i.png");
    expect(call.headers?.["obs-aliases"]).toBe(encodeURIComponent(JSON.stringify(["Old/Path", "Older/Path"])));
  });

  it("omits the obs-aliases header when aliases is missing, null, or empty", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md");
    expect(lastCall().headers?.["obs-aliases"]).toBeUndefined();

    await client.publishFile("note.md", { aliases: null });
    expect(lastCall().headers?.["obs-aliases"]).toBeUndefined();

    await client.publishFile("note.md", { aliases: [] });
    expect(lastCall().headers?.["obs-aliases"]).toBeUndefined();
  });

  // Site collaboration (36_실제_아키텍처_전환_Site_collaboration.md) -- remoteSite is additive
  // and optional, so every test above (which omits it) already covers the unchanged default path.
  it("uses the remote site's vaultId as obs-id and adds obs-owner when remoteSite is given", async () => {
    mockHttp({ status: 200 });
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);
    vault.adapter.readBinary.mockResolvedValue(new TextEncoder().encode("hello").buffer);
    const client = makeClient(fakeTransport(), vault, fakeFileManager());

    await client.publishFile("note.md", undefined, { owner: "alice", vaultId: "alice-vault" });

    const call = lastCall();
    expect(call.headers?.["obs-id"]).toBe("alice-vault");
    expect(call.headers?.["obs-owner"]).toBe("alice");
  });
});

describe("SyncClient.unpublishFile", () => {
  it("posts the path/id/token to /api/remove", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.unpublishFile("note.md");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/remove");
    expect(JSON.parse(call.body as string)).toEqual({ path: "note.md", id: "myvault", token: "test-token" });
  });

  it("throws on failure", async () => {
    mockHttp({ status: 404, text: "not found" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.unpublishFile("note.md")).rejects.toThrow(/not found/);
  });

  it("uses the remote site's vaultId as id and adds owner to the body when remoteSite is given", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.unpublishFile("note.md", { owner: "alice", vaultId: "alice-vault" });

    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({
      path: "note.md", id: "alice-vault", token: "test-token", owner: "alice",
    });
  });
});

describe("SyncClient.getPublishedFiles / listFiles", () => {
  it("getPublishedFiles returns just the paths from /api/list", async () => {
    mockHttp({ status: 200, json: { files: [{ path: "a.md", hash: "h1" }, { path: "b.md", hash: "h2" }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getPublishedFiles()).toEqual(["a.md", "b.md"]);
  });

  it("getPublishedFiles returns an empty array on a non-ok response", async () => {
    mockHttp({ status: 500 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getPublishedFiles()).toEqual([]);
  });

  it("listFiles returns the full path+hash entries", async () => {
    mockHttp({ status: 200, json: { files: [{ path: "a.md", hash: "h1" }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.listFiles()).toEqual([{ path: "a.md", hash: "h1" }]);
  });

  it("getPublishedFiles uses the remote site's vaultId and adds obs-owner when remoteSite is given", async () => {
    mockHttp({ status: 200, json: { files: [] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.getPublishedFiles({ owner: "alice", vaultId: "alice-vault" });

    const call = lastCall();
    expect(call.headers?.["obs-id"]).toBe("alice-vault");
    expect(call.headers?.["obs-owner"]).toBe("alice");
  });

  it("listFiles uses the remote site's vaultId and adds obs-owner when remoteSite is given", async () => {
    mockHttp({ status: 200, json: { files: [] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.listFiles({ owner: "alice", vaultId: "alice-vault" });

    const call = lastCall();
    expect(call.headers?.["obs-id"]).toBe("alice-vault");
    expect(call.headers?.["obs-owner"]).toBe("alice");
  });
});

describe("SyncClient password/slug/site methods (postToBackend/postToFrontend)", () => {
  it("getPasswords posts to api/password with {id, token} and returns the pass list", async () => {
    mockHttp({ status: 200, json: { pass: [{ name: "guest" }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.getPasswords();

    expect(result).toEqual([{ name: "guest" }]);
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/password");
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token" });
  });

  it("addPassword posts {id, token, name, pw}", async () => {
    mockHttp({ status: 200, json: {} });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.addPassword("guest", "secret");

    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token", name: "guest", pw: "secret" });
  });

  it("deletePassword posts {id, token, del}", async () => {
    mockHttp({ status: 200, json: {} });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.deletePassword("guest");

    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token", del: "guest" });
  });

  it("postToBackend throws with the endpoint name and status on failure", async () => {
    mockHttp({ status: 403, text: "forbidden" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.getPasswords()).rejects.toThrow(/api\/password failed: 403/);
  });

  it("getSlugs posts to api/slugs with {token, ids} (no id, per postToFrontend's convention)", async () => {
    mockHttp({ status: 200, json: { myvault: "my-slug" } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.getSlugs();

    expect(result).toEqual({ myvault: "my-slug" });
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/slugs");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", ids: ["myvault"] });
  });

  it("setSlug posts {token, id, host, slug}", async () => {
    mockHttp({ status: 200, json: {} });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.setSlug("my-slug");

    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", id: "myvault", host: "localhost:8080", slug: "my-slug" });
  });

  it("checkSlug posts to api/site and returns the response", async () => {
    mockHttp({ status: 200, json: { id: "myvault", slug: "my-slug", host: "localhost:8080" } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.checkSlug("my-slug")).toEqual({ id: "myvault", slug: "my-slug", host: "localhost:8080" });
  });

  it("postToFrontend throws with the endpoint name and status on failure", async () => {
    mockHttp({ status: 409, text: "taken" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.setSlug("taken-slug")).rejects.toThrow(/api\/slug failed: 409/);
  });
});

// First batch of the "Change site options" dialog (see 25_사이트_옵션_1차_구현.md).
describe("SyncClient.getSiteOptions / setSiteOptions", () => {
  const OPTIONS = {
    siteName: "My Site", indexFile: "Home.md", logo: "logo.png", noindex: true,
    hideTitle: false, readableLineLength: true, strictLineBreaks: false, googleAnalytics: "",
    showSearch: true, showNavigation: false, slidingWindowMode: false,
    navigationOrdering: [], navigationHiddenItems: [],
    defaultTheme: "dark" as const, showThemeToggle: false,
  };

  it("getSiteOptions posts to api/options with {id, token} and an empty body, returning the options", async () => {
    mockHttp({ status: 200, json: { options: OPTIONS } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.getSiteOptions();

    expect(result).toEqual(OPTIONS);
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/options");
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token" });
  });

  it("setSiteOptions posts {id, token, options} with only the changed fields", async () => {
    mockHttp({ status: 200, json: { options: OPTIONS } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.setSiteOptions({ siteName: "My Site", noindex: true });

    expect(result).toEqual(OPTIONS);
    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({
      id: "myvault", token: "test-token", options: { siteName: "My Site", noindex: true },
    });
  });

  it("getSiteOptions throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.getSiteOptions()).rejects.toThrow(/api\/options failed: 500/);
  });
});

// Custom domain (see 26_커스텀_도메인_지원.md) -- unblocks publish.js/googleAnalytics, which
// real Obsidian only activates once a custom domain is configured.
describe("SyncClient.getCustomDomain / setCustomDomain", () => {
  it("getCustomDomain posts {id, token} and returns {url, redirect}", async () => {
    mockHttp({ status: 200, json: { url: "notes.example.com", redirect: true } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.getCustomDomain();

    expect(result).toEqual({ url: "notes.example.com", redirect: true });
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/customurl");
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token" });
  });

  it("setCustomDomain posts {id, token, host, url, redirect}", async () => {
    mockHttp({ status: 200, json: { url: "notes.example.com", redirect: true } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.setCustomDomain("notes.example.com", true);

    expect(result).toEqual({ url: "notes.example.com", redirect: true });
    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({
      id: "myvault", token: "test-token", host: "localhost:8080", url: "notes.example.com", redirect: true,
    });
  });

  it("setCustomDomain throws on 409 (hostname already claimed)", async () => {
    mockHttp({ status: 409, text: "taken" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.setCustomDomain("taken.example.com", false)).rejects.toThrow(/api\/customurl failed: 409/);
  });
});

describe("SyncClient.downloadPublishedFile", () => {
  it("posts {id, token, path} to /api/download and returns the bytes", async () => {
    const data = new TextEncoder().encode("published content").buffer;
    mockHttp({ status: 200, arrayBuffer: data });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.downloadPublishedFile("note.md");

    expect(new TextDecoder().decode(result)).toBe("published content");
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/download");
    expect(JSON.parse(call.body as string)).toEqual({ id: "myvault", token: "test-token", path: "note.md" });
  });

  it("throws on failure", async () => {
    mockHttp({ status: 500, text: "gone" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.downloadPublishedFile("note.md")).rejects.toThrow(/gone/);
  });

  it("uses the remote site's vaultId as id and adds owner to the body when remoteSite is given", async () => {
    mockHttp({ status: 200, arrayBuffer: new ArrayBuffer(0) });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.downloadPublishedFile("note.md", { owner: "alice", vaultId: "alice-vault" });

    const call = lastCall();
    expect(JSON.parse(call.body as string)).toEqual({
      id: "alice-vault", token: "test-token", path: "note.md", owner: "alice",
    });
  });
});

describe("SyncClient.getMyShares", () => {
  it("returns the sites this account has been added as an accepted collaborator on", async () => {
    mockHttp({
      status: 200,
      json: { sites: [{ owner: "alice", vault_id: "vault1", site_name: "Alice's Notes" }] },
    });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const result = await client.getMyShares();

    expect(result).toEqual([{ owner: "alice", vaultId: "vault1", siteName: "Alice's Notes" }]);
    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/publish/share/mine");
  });

  it("returns an empty array on a non-ok response", async () => {
    mockHttp({ status: 500 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getMyShares()).toEqual([]);
  });
});

describe("SyncClient share methods", () => {
  it("getShares posts to publish/share/list and returns the shares list", async () => {
    mockHttp({ status: 200, json: { shares: [{ uid: "u1", email: "a@b.com", name: "A", accepted: true }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getShares()).toEqual([{ uid: "u1", email: "a@b.com", name: "A", accepted: true }]);
  });

  it("getShares returns an empty array when the response omits shares", async () => {
    mockHttp({ status: 200, json: {} });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.getShares()).toEqual([]);
  });

  it("getShares throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.getShares()).rejects.toThrow(/boom/);
  });

  it("inviteShare posts {token, site_uid, email}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.inviteShare("a@b.com");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/publish/share/invite");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", site_uid: "myvault", email: "a@b.com" });
  });

  it("inviteShare throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.inviteShare("a@b.com")).rejects.toThrow(/boom/);
  });

  it("removeShare posts {token, site_uid, share_uid}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.removeShare("u1");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/publish/share/remove");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", site_uid: "myvault", share_uid: "u1" });
  });

  it("removeShare throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.removeShare("u1")).rejects.toThrow(/boom/);
  });

  it("acceptShare posts {token, code}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.acceptShare("invite-code");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/publish/share/accept");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", code: "invite-code" });
  });

  it("acceptShare throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.acceptShare("invite-code")).rejects.toThrow(/boom/);
  });
});

// Vault sync sharing (see 14_vault_sharing_설계.md) -- distinct from the Publish "share" methods
// above (those grant read access to a published *site*, not to the vault's own sync data).
describe("SyncClient vault-sharing methods", () => {
  it("inviteVaultShare posts {token, vault_id, email}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.inviteVaultShare("friend@example.com");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/vault/share/invite");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", vault_id: "myvault", email: "friend@example.com" });
  });

  it("inviteVaultShare throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.inviteVaultShare("friend@example.com")).rejects.toThrow(/boom/);
  });

  it("listVaultShares posts {token, vault_id} and returns the shares list", async () => {
    mockHttp({ status: 200, json: { shares: [{ uid: "u1", email: "friend@example.com", accepted: false, createdAtMs: 1000 }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const shares = await client.listVaultShares();

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/vault/share/list");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", vault_id: "myvault" });
    expect(shares).toEqual([{ uid: "u1", email: "friend@example.com", accepted: false, createdAtMs: 1000 }]);
  });

  it("listVaultShares returns an empty array when the response omits shares", async () => {
    mockHttp({ status: 200, json: {} });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.listVaultShares()).toEqual([]);
  });

  it("listVaultShares throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.listVaultShares()).rejects.toThrow(/boom/);
  });

  it("removeVaultShare posts {token, vault_id, share_uid}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.removeVaultShare("u1");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/vault/share/remove");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", vault_id: "myvault", share_uid: "u1" });
  });

  it("removeVaultShare throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.removeVaultShare("u1")).rejects.toThrow(/boom/);
  });

  it("leaveSharedVault posts {token, ownerUsername, vaultId}", async () => {
    mockHttp({ status: 200 });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await client.leaveSharedVault("alice");

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/vault/share/leave");
    expect(JSON.parse(call.body as string)).toEqual({ token: "test-token", ownerUsername: "alice", vaultId: "myvault" });
  });

  it("leaveSharedVault throws on failure", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    await expect(client.leaveSharedVault("alice")).rejects.toThrow(/boom/);
  });

  it("listSharedWithMe GETs with a bearer token and returns the vault list", async () => {
    mockHttp({ status: 200, json: { vaults: [{ ownerUsername: "alice", vaultId: "vault1", accepted: true, createdAtMs: 1000 }] } });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    const vaults = await client.listSharedWithMe();

    const call = lastCall();
    expect(call.url).toBe("http://localhost:8080/api/vault/shared-with-me");
    expect(call.headers?.["Authorization"]).toBe("Bearer test-token");
    expect(vaults).toEqual([{ ownerUsername: "alice", vaultId: "vault1", accepted: true, createdAtMs: 1000 }]);
  });

  it("listSharedWithMe returns an empty array on failure rather than throwing", async () => {
    mockHttp({ status: 500, text: "boom" });
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());

    expect(await client.listSharedWithMe()).toEqual([]);
  });
});
