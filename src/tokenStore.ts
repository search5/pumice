import { Platform } from "obsidian";

// Dynamic Node.js module loading fallback (for desktop keychain and local file storage)
let execFile: any = null;
let fs: any = null;
let os: any = null;
let path: any = null;

try {
  if (typeof require !== "undefined") {
    execFile = require("child_process").execFile;
    fs = require("fs");
    os = require("os");
    path = require("path");
  }
} catch (e) {}

const SERVICE = "pumice";
const ACCOUNT = "sync-token";
const LOCAL_STORAGE_KEY = "pumice-token";

function getFallbackFilePath(): string {
  if (os && path) {
    return path.join(os.homedir(), ".obsidian_grpc_sync_token");
  }
  return "";
}

// A promisify-style wrapper for child_process (only used when the child_process module is available)
function execFileAsync(file: string, args: string[], options?: any): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!execFile) {
      return reject(new Error("child_process is not supported in this environment"));
    }
    execFile(file, args, options, (err: any, stdout: string, stderr: string) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export async function saveToken(token: string): Promise<void> {
  // Store in localStorage as well, to cover mobile/browser environments
  localStorage.setItem(LOCAL_STORAGE_KEY, token);

  // On desktop, also try the platform-specific system keychain
  if (execFile) {
    try {
      if (Platform.isMacOS) await saveMac(token);
      else if (Platform.isWin)   await saveWindows(token);
      else await saveLinux(token);
    } catch (e) {
      console.warn("Keychain storage failed, falling back to local file storage:", e);
      await saveFallback(token);
    }
  }
}

export async function loadToken(): Promise<string> {
  // 1. On desktop, try loading from the system keychain first
  if (execFile) {
    try {
      let token = "";
      if (Platform.isMacOS) token = await loadMac();
      else if (Platform.isWin)   token = await loadWindows();
      else token = await loadLinux();
      
      if (token) return token;
    } catch (e) {
      console.warn("Keychain load failed, checking fallback file:");
    }
    
    const fileToken = await loadFallback();
    if (fileToken) return fileToken;
  }
  
  // 2. Fall back to localStorage on mobile/browser, or when there's no system keychain
  return localStorage.getItem(LOCAL_STORAGE_KEY) || "";
}

export async function deleteToken(): Promise<void> {
  localStorage.removeItem(LOCAL_STORAGE_KEY);

  if (execFile) {
    try {
      if (Platform.isMacOS) await deleteMac();
      else if (Platform.isWin)   await deleteWindows();
      else await deleteLinux();
    } catch (e) {
      console.warn("Keychain delete failed:");
    }
    await deleteFallback();
  }
}

export async function hasToken(): Promise<boolean> {
  return (await loadToken()) !== "";
}

// ─── macOS: security CLI ──────────────────────────────────────────────────────
async function saveMac(token: string): Promise<void> {
  await execFileAsync("security", [
    "add-generic-password", "-U",
    "-s", SERVICE, "-a", ACCOUNT, "-w", token,
  ]);
}

async function loadMac(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function deleteMac(): Promise<void> {
  try {
    await execFileAsync("security", [
      "delete-generic-password", "-s", SERVICE, "-a", ACCOUNT,
    ]);
  } catch { /* ignore if the entry doesn't exist */ }
}

// ─── Windows: PasswordVault ───────────────────────────────────────────────────
async function saveWindows(token: string): Promise<void> {
  const script = `
    Add-Type -AssemblyName Windows.Security
    $vault = New-Object Windows.Security.Credentials.PasswordVault
    try { $old = $vault.Retrieve('${SERVICE}','${ACCOUNT}'); $vault.Remove($old) } catch {}
    $c = New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}','${ACCOUNT}',$env:_SYNC_TOKEN)
    $vault.Add($c)
  `;
  await execFileAsync("powershell", ["-Command", script], {
    env: { ...process.env, _SYNC_TOKEN: token },
  });
}

async function loadWindows(): Promise<string> {
  const script = `
    try {
      Add-Type -AssemblyName Windows.Security
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $c = $vault.Retrieve('${SERVICE}','${ACCOUNT}')
      $c.RetrievePassword(); Write-Output $c.Password
    } catch { Write-Output '' }
  `;
  const { stdout } = await execFileAsync("powershell", ["-Command", script]);
  return stdout.trim();
}

async function deleteWindows(): Promise<void> {
  const script = `
    try {
      Add-Type -AssemblyName Windows.Security
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $c = $vault.Retrieve('${SERVICE}','${ACCOUNT}'); $vault.Remove($c)
    } catch {}
  `;
  await execFileAsync("powershell", ["-Command", script]);
}

// ─── Linux: secret-tool (libsecret) ──────────────────────────────────────────
async function saveLinux(token: string): Promise<void> {
  const env = { ...process.env, PATH: `${process.env.PATH || ""}:/usr/bin:/usr/local/bin:/bin` };
  await new Promise<void>((resolve, reject) => {
    if (!execFile) return reject(new Error("child_process is unavailable"));
    const child = execFile(
      "secret-tool",
      ["store", "--label", "Obsidian gRPC Sync Token", "service", SERVICE, "account", ACCOUNT],
      { env },
      (err: any) => (err ? reject(err) : resolve())
    );
    child.stdin?.end(token);
  });
}

async function loadLinux(): Promise<string> {
  const env = { ...process.env, PATH: `${process.env.PATH || ""}:/usr/bin:/usr/local/bin:/bin` };
  try {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup", "service", SERVICE, "account", ACCOUNT,
    ], { env });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function deleteLinux(): Promise<void> {
  const env = { ...process.env, PATH: `${process.env.PATH || ""}:/usr/bin:/usr/local/bin:/bin` };
  try {
    await execFileAsync("secret-tool", [
      "clear", "service", SERVICE, "account", ACCOUNT,
    ], { env });
  } catch {}
}

async function saveFallback(token: string): Promise<void> {
  const file = getFallbackFilePath();
  if (fs && file) {
    await fs.promises.writeFile(file, token, "utf8");
  }
}

async function loadFallback(): Promise<string> {
  const file = getFallbackFilePath();
  if (fs && file) {
    try {
      if (fs.existsSync(file)) {
        return (await fs.promises.readFile(file, "utf8")).trim();
      }
    } catch (e) {
      console.error("Failed to read fallback token file:", e);
    }
  }
  return "";
}

async function deleteFallback(): Promise<void> {
  const file = getFallbackFilePath();
  if (fs && file) {
    try {
      if (fs.existsSync(file)) {
        await fs.promises.unlink(file);
      }
    } catch {}
  }
}
