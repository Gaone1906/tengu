import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import { resolveJinnInstance } from "../shared/home.js";

export const AUTH_COOKIE = "jinn_auth";
export const AUTH_DEVICE_COOKIE = "jinn_device";
export const LOCAL_BOOTSTRAP_GRANT_HEADER = "x-jinn-bootstrap-grant";
export const LOCAL_BOOTSTRAP_GRANT_TTL_MS = 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const AUTOMATED_AUTH_SESSION_TTL_MS = 60 * 60 * 1000;
// touchAuthSession persists lastSeenAt at most once per window per device to
// avoid a disk write on every authenticated request.
export const AUTH_SESSION_TOUCH_THROTTLE_MS = 60 * 1000;

export interface PairingCodeEntry {
  expiresAt: number;
}

/**
 * Minimal store surface shared by the in-memory Map (tests, default) and the
 * durable file-backed store used in production. A plain Map satisfies it.
 */
export interface PairingCodeStore {
  get(hash: string): PairingCodeEntry | undefined;
  set(hash: string, entry: PairingCodeEntry): void;
  delete(hash: string): void;
  entries(): IterableIterator<[string, PairingCodeEntry]>;
}

const pairingCodes: PairingCodeStore = new Map();

/**
 * Persist pairing codes under JINN_HOME so a gateway restart within the 5-minute
 * TTL no longer silently invalidates an outstanding code. Only salted hashes and
 * expiries are stored (never the raw code), at mode 0600, and always per-instance
 * (each instance has its own JINN_HOME) — a code still only pairs the instance
 * that minted it, which is the intended boundary.
 */
export function createFilePairingCodeStore(jinnHome: string): PairingCodeStore {
  const file = path.join(jinnHome, "pairing-codes.json");
  const load = (): Map<string, PairingCodeEntry> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, { expiresAt?: unknown }>;
      const map = new Map<string, PairingCodeEntry>();
      for (const [hash, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.expiresAt === "number") map.set(hash, { expiresAt: entry.expiresAt });
      }
      return map;
    } catch {
      return new Map();
    }
  };
  const save = (map: Map<string, PairingCodeEntry>): void => {
    const obj: Record<string, PairingCodeEntry> = {};
    for (const [hash, entry] of map) obj[hash] = { expiresAt: entry.expiresAt };
    fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
  };
  return {
    get: (hash) => load().get(hash),
    set: (hash, entry) => { const map = load(); map.set(hash, entry); save(map); },
    delete: (hash) => { const map = load(); map.delete(hash); save(map); },
    entries: () => load().entries(),
  };
}

export interface LocalBootstrapGrantEntry {
  expiresAt: number;
}

export type LocalBootstrapGrantStore = Map<string, LocalBootstrapGrantEntry>;

const localBootstrapGrants: LocalBootstrapGrantStore = new Map();

export type AuthSessionKind = "local" | "remote" | "token";

export interface AuthSessionDevice {
  id: string;
  name: string;
  kind: AuthSessionKind;
  createdAt: string;
  lastSeenAt: string;
  lastIp?: string;
  userAgent?: string;
}

interface StoredAuthSessionDevice extends AuthSessionDevice {
  tokenHash: string;
}

export interface PublicAuthSessionDevice extends AuthSessionDevice {
  current: boolean;
}

export function createAuthToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashLocalBootstrapGrant(grant: string): string {
  return crypto.createHash("sha256").update(`jinn-local-bootstrap:${grant}`).digest("base64url");
}

export function issueLocalBootstrapGrant(
  store: LocalBootstrapGrantStore = localBootstrapGrants,
  now = Date.now(),
  grantFactory: () => string = createAuthToken,
): string {
  cleanupExpiredLocalBootstrapGrants(store, now);
  const grant = grantFactory();
  store.set(hashLocalBootstrapGrant(grant), { expiresAt: now + LOCAL_BOOTSTRAP_GRANT_TTL_MS });
  return grant;
}

export function consumeLocalBootstrapGrant(
  rawGrant: string | undefined | null,
  store: LocalBootstrapGrantStore = localBootstrapGrants,
  now = Date.now(),
): boolean {
  if (typeof rawGrant !== "string" || rawGrant.length < 16) return false;
  const hash = hashLocalBootstrapGrant(rawGrant);
  const entry = store.get(hash);
  if (!entry) return false;
  store.delete(hash);
  return entry.expiresAt >= now;
}

export function cleanupExpiredLocalBootstrapGrants(
  store: LocalBootstrapGrantStore = localBootstrapGrants,
  now = Date.now(),
): void {
  for (const [hash, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(hash);
  }
}

export function ensureGatewayAuthToken(jinnHome: string): string {
  fs.mkdirSync(jinnHome, { recursive: true });
  const file = path.join(jinnHome, "gateway.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    existing = {};
  }
  if (typeof existing.token === "string" && existing.token.length >= 32) {
    try { fs.chmodSync(file, 0o600); } catch {}
    return existing.token;
  }
  const token = createAuthToken();
  const next = { ...existing, token };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return token;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function matchesGatewayAuthToken(candidate: string | undefined, expectedToken: string | undefined): boolean {
  return typeof candidate === "string" && typeof expectedToken === "string" && safeEqual(candidate, expectedToken);
}

export function verifyGatewayAuth(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined,
  jinnHome?: string,
): boolean {
  if (!expectedToken) return false;
  if (hasGatewayBearerAuth(headers, expectedToken)) return true;
  const cookieRaw = headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  const parsed = parseCookieHeader(cookie);
  const token = parsed[authCookieName(jinnHome)];
  const deviceId = parsed[authDeviceCookieName(jinnHome)];
  if (jinnHome && typeof token === "string" && typeof deviceId === "string" && verifyAuthSession(jinnHome, deviceId, token)) {
    return true;
  }
  return false;
}

export function hasGatewayBearerAuth(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const authHeaderRaw = headers.authorization;
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  if (typeof authHeader !== "string") return false;
  const [scheme, ...rest] = authHeader.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && safeEqual(rest.join(" "), expectedToken);
}

export function authenticateGatewayRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
  expectedToken: string | undefined,
  jinnHome?: string,
): { ok: boolean; reason?: string } {
  if (!expectedToken) return { ok: false, reason: "Gateway auth token is not configured" };
  return verifyGatewayAuth(req.headers, expectedToken, jinnHome)
    ? { ok: true }
    : { ok: false, reason: "Missing or invalid gateway auth token" };
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const raw = host.trim().toLowerCase();
  const h = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]") >= 0 ? raw.indexOf("]") : undefined)
    : isIP(raw) > 0 ? raw : raw.replace(/:\d+$/, "");
  return h === "localhost"
    || h.endsWith(".localhost")
    || h === "127.0.0.1"
    || h === "::1"
    || h === "0:0:0:0:0:0:0:1";
}

export function isNetworkHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || !isLoopbackHost(h);
}

export function authRequiredForRequest(method: string | undefined, pathname: string): boolean {
  if (pathname === "/api/status") return false;
  if (pathname === "/api/auth/state" && (method || "GET").toUpperCase() === "GET") return false;
  if (pathname === "/api/auth/bootstrap" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/pairing-challenges" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/pairing-codes" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/pair" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/logout" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/internal/hook" && (method || "GET").toUpperCase() === "POST") return false;
  // Route-local auth accepts either the gateway token or a per-binding workflow-event
  // token. The generic middleware only knows the gateway token, so this route must
  // verify its own auth and fail closed for anonymous requests.
  if (pathname === "/api/workflow-events" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname.startsWith("/api/")) return true;
  if (pathname === "/ws" || pathname.startsWith("/ws/pty/")) return true;
  return false;
}

export function shouldRequireGatewayAuth(config: Pick<JinnConfig, "gateway">): boolean {
  const gateway = config.gateway as JinnConfig["gateway"] & {
    authRequired?: boolean;
    authDisabled?: boolean;
  };
  if (gateway.authDisabled === true) return false;
  if (gateway.authRequired === true) return true;
  return isNetworkHost(gateway.host);
}

export function validateGatewayExposure(config: Pick<JinnConfig, "gateway">): { ok: true } | { ok: false; error: string } {
  const gateway = config.gateway as JinnConfig["gateway"] & {
    authDisabled?: boolean;
    insecureAllowUnauthenticatedNetwork?: boolean;
  };
  if (isNetworkHost(gateway.host) && gateway.authDisabled === true && gateway.insecureAllowUnauthenticatedNetwork !== true) {
    return { ok: false, error: "Refusing network-exposed gateway without auth. Set gateway.insecureAllowUnauthenticatedNetwork=true to override." };
  }
  return { ok: true };
}

/**
 * Cookies are scoped by host but NOT by port (RFC 6265), so two gateway
 * instances on the same host (e.g. one behind `tailscale serve`) would clobber
 * each other's `jinn_auth`/`jinn_device` cookie and log each other out. Namespace
 * the cookie name per instance to keep their sessions independent. Only real
 * `~/.<name>` instance homes are namespaced: the default `jinn` keeps the bare
 * names (no forced re-pair on upgrade) and ad-hoc/test homes stay hermetic.
 */
function cookieNamespace(jinnHome?: string): string {
  const home = jinnHome ?? process.env.JINN_HOME;
  if (!home) return "";
  const base = path.basename(path.resolve(home));
  if (!base.startsWith(".")) return "";
  const name = base.slice(1).replace(/[^A-Za-z0-9_-]/g, "");
  return name && name !== "jinn" ? name : "";
}

export function authCookieName(jinnHome?: string): string {
  const ns = cookieNamespace(jinnHome);
  return ns ? `${AUTH_COOKIE}_${ns}` : AUTH_COOKIE;
}

export function authDeviceCookieName(jinnHome?: string): string {
  const ns = cookieNamespace(jinnHome);
  return ns ? `${AUTH_DEVICE_COOKIE}_${ns}` : AUTH_DEVICE_COOKIE;
}

export function authCookieHeader(token: string, jinnHome?: string): string {
  return `${authCookieName(jinnHome)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export function authDeviceCookieHeader(deviceId: string, jinnHome?: string): string {
  return `${authDeviceCookieName(jinnHome)}=${encodeURIComponent(deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export function authCookieHeaders(secret: string, deviceId: string, jinnHome?: string): string[] {
  return [authCookieHeader(secret, jinnHome), authDeviceCookieHeader(deviceId, jinnHome)];
}

export function clearAuthCookieHeader(jinnHome?: string): string {
  return `${authCookieName(jinnHome)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthDeviceCookieHeader(jinnHome?: string): string {
  return `${authDeviceCookieName(jinnHome)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthCookieHeaders(jinnHome?: string): string[] {
  return [clearAuthCookieHeader(jinnHome), clearAuthDeviceCookieHeader(jinnHome)];
}

export function createAuthState(
  config: Pick<JinnConfig, "gateway">,
  req: Pick<IncomingMessage, "headers" | "socket">,
  expectedToken: string | undefined,
  jinnHome?: string,
): {
  authRequired: boolean;
  authenticated: boolean;
  canBootstrapLocal: boolean;
  networkExposed: boolean;
  instance: string;
} {
  const authRequired = shouldRequireGatewayAuth(config);
  const authenticated = authRequired ? verifyGatewayAuth(req.headers, expectedToken, jinnHome) : true;
  return {
    authRequired,
    authenticated,
    canBootstrapLocal: Boolean(expectedToken && isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(headerValue(req.headers, "host"))),
    networkExposed: isNetworkHost(config.gateway.host),
    // Lets the browser show the exact `jinn -i <instance> pair` command for the
    // gateway it is actually talking to, so multi-instance operators mint on the
    // right one instead of the default.
    instance: resolveJinnInstance(jinnHome),
  };
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

function authDevicesPath(jinnHome: string): string {
  return path.join(jinnHome, "auth-devices.json");
}

function authSessionHash(secret: string): string {
  return crypto.createHash("sha256").update(`jinn-auth-session:${secret}`).digest("base64url");
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function loadStoredAuthSessions(jinnHome: string): StoredAuthSessionDevice[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(authDevicesPath(jinnHome), "utf-8")) as { devices?: unknown };
    if (!Array.isArray(parsed.devices)) return [];
    return parsed.devices.filter((device): device is StoredAuthSessionDevice => {
      if (!device || typeof device !== "object") return false;
      const d = device as Record<string, unknown>;
      return typeof d.id === "string"
        && typeof d.name === "string"
        && typeof d.kind === "string"
        && typeof d.createdAt === "string"
        && typeof d.lastSeenAt === "string"
        && typeof d.tokenHash === "string";
    });
  } catch {
    return [];
  }
}

function saveStoredAuthSessions(jinnHome: string, devices: StoredAuthSessionDevice[]): void {
  fs.mkdirSync(jinnHome, { recursive: true });
  const file = authDevicesPath(jinnHome);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // A failed write (e.g. ENOSPC) must not leave a half-written tmp behind for
    // the same pid to trip over on the next attempt. Clean it up and rethrow so
    // callers that require durability (createAuthSession) still see the failure;
    // best-effort callers (touchAuthSession) swallow it.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function pruneStaleAutomatedAuthSessions(
  jinnHome: string,
  devices: StoredAuthSessionDevice[],
  now = Date.now(),
): StoredAuthSessionDevice[] {
  const next = devices.filter((device) => {
    if (!/HeadlessChrome|Playwright/i.test(device.userAgent || "")) return true;
    const lastSeenAt = Date.parse(device.lastSeenAt);
    return !Number.isFinite(lastSeenAt) || now - lastSeenAt <= AUTOMATED_AUTH_SESSION_TTL_MS;
  });
  if (next.length !== devices.length) saveStoredAuthSessions(jinnHome, next);
  return next;
}

function inferAuthSessionName(req: Pick<IncomingMessage, "headers" | "socket">, kind: AuthSessionKind): string {
  if (kind === "local") return "This Mac";
  const ua = headerValue(req.headers, "user-agent") || "";
  if (/iphone|ipad/i.test(ua)) return "iPhone or iPad browser";
  if (/android/i.test(ua)) return "Android browser";
  if (/macintosh|mac os/i.test(ua)) return "Mac browser";
  if (/windows/i.test(ua)) return "Windows browser";
  if (/linux/i.test(ua)) return "Linux browser";
  return kind === "token" ? "Setup-token browser" : "Remote browser";
}

export function createAuthSession(
  jinnHome: string,
  req: Pick<IncomingMessage, "headers" | "socket">,
  opts: { name?: string; kind?: AuthSessionKind; now?: number } = {},
): { secret: string; device: AuthSessionDevice } {
  const now = opts.now ?? Date.now();
  const kind = opts.kind ?? (isLoopbackAddress(req.socket.remoteAddress) ? "local" : "remote");
  const secret = createAuthToken();
  const userAgent = headerValue(req.headers, "user-agent");
  const devices = pruneStaleAutomatedAuthSessions(jinnHome, loadStoredAuthSessions(jinnHome), now);
  const device: AuthSessionDevice = {
    id: `d_${crypto.randomBytes(12).toString("base64url")}`,
    name: opts.name || inferAuthSessionName(req, kind),
    kind,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ...(req.socket.remoteAddress ? { lastIp: req.socket.remoteAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
  const stored: StoredAuthSessionDevice = { ...device, tokenHash: authSessionHash(secret) };
  saveStoredAuthSessions(jinnHome, [...devices.filter((existing) => existing.id !== stored.id), stored]);
  return { secret, device };
}

export function verifyAuthSession(jinnHome: string, deviceId: string | undefined, secret: string | undefined): boolean {
  if (!deviceId || !secret) return false;
  const device = loadStoredAuthSessions(jinnHome).find((d) => d.id === deviceId);
  if (!device) return false;
  return safeEqual(device.tokenHash, authSessionHash(secret));
}

export function touchAuthSession(
  jinnHome: string,
  req: Pick<IncomingMessage, "headers" | "socket">,
  now = Date.now(),
): AuthSessionDevice | null {
  const cookieRaw = req.headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  const parsed = parseCookieHeader(cookie);
  const secret = parsed[authCookieName(jinnHome)];
  const deviceId = parsed[authDeviceCookieName(jinnHome)];
  if (!verifyAuthSession(jinnHome, deviceId, secret)) return null;
  const devices = loadStoredAuthSessions(jinnHome);
  const idx = devices.findIndex((d) => d.id === deviceId);
  if (idx < 0) return null;
  const existing = devices[idx];
  const nextIp = req.socket.remoteAddress;
  const nextUa = headerValue(req.headers, "user-agent");
  // Write-amplification guard: touchAuthSession runs on EVERY authenticated
  // request. Persisting lastSeenAt each time hammers the disk (and, when the
  // disk is full, floods the log with ENOSPC on the same tmp file). Only persist
  // when a device attribute actually changed or the recorded lastSeenAt is stale
  // beyond the throttle window.
  const lastSeenMs = Date.parse(existing.lastSeenAt);
  const stale = !Number.isFinite(lastSeenMs) || now - lastSeenMs >= AUTH_SESSION_TOUCH_THROTTLE_MS;
  const attrsChanged = (nextIp !== undefined && nextIp !== existing.lastIp)
    || (nextUa !== undefined && nextUa !== existing.userAgent);
  const updated = {
    ...existing,
    lastSeenAt: new Date(now).toISOString(),
    ...(nextIp ? { lastIp: nextIp } : {}),
    ...(nextUa ? { userAgent: nextUa } : {}),
  };
  const { tokenHash: _tokenHash, ...device } = updated;
  if (!stale && !attrsChanged) return device; // skip the write entirely
  devices[idx] = updated;
  // Best-effort: a lastSeenAt refresh must never fail the request it rode in on.
  try { saveStoredAuthSessions(jinnHome, devices); } catch { /* transient FS/ENOSPC — keep serving */ }
  return device;
}

export function currentAuthDeviceId(
  headers: Record<string, string | string[] | undefined>,
  jinnHome?: string,
): string | undefined {
  const cookieRaw = headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  return parseCookieHeader(cookie)[authDeviceCookieName(jinnHome)];
}

export function listAuthSessions(jinnHome: string, currentDeviceId?: string, now = Date.now()): PublicAuthSessionDevice[] {
  return pruneStaleAutomatedAuthSessions(jinnHome, loadStoredAuthSessions(jinnHome), now)
    .map(({ tokenHash: _tokenHash, ...device }) => ({
      ...device,
      current: Boolean(currentDeviceId && device.id === currentDeviceId),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function revokeAuthSession(jinnHome: string, deviceId: string): boolean {
  const devices = loadStoredAuthSessions(jinnHome);
  const next = devices.filter((device) => device.id !== deviceId);
  if (next.length === devices.length) return false;
  saveStoredAuthSessions(jinnHome, next);
  return true;
}

function hashPairingCode(raw: string): string {
  return crypto.createHash("sha256").update(normalizePairingCode(raw)).digest("base64url");
}

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function createPairingCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) {
    raw += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function issuePairingCode(
  store: PairingCodeStore = pairingCodes,
  now = Date.now(),
  codeFactory: () => string = createPairingCode,
): { code: string; expiresAt: number } {
  cleanupExpiredPairingCodes(store, now);
  const code = codeFactory();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  store.set(hashPairingCode(code), { expiresAt });
  return { code, expiresAt };
}

export function consumePairingCode(
  store: PairingCodeStore = pairingCodes,
  rawCode: string | undefined,
  now = Date.now(),
): boolean {
  if (!rawCode) return false;
  const normalized = normalizePairingCode(rawCode);
  if (normalized.length === 0) return false;
  const hash = hashPairingCode(normalized);
  const entry = store.get(hash);
  if (!entry) return false;
  store.delete(hash);
  return entry.expiresAt >= now;
}

export function cleanupExpiredPairingCodes(store: PairingCodeStore = pairingCodes, now = Date.now()): void {
  for (const [hash, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(hash);
  }
}
