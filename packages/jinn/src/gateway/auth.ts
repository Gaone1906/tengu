import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { JinnConfig } from "../shared/types.js";

export const AUTH_COOKIE = "jinn_auth";
export const AUTH_DEVICE_COOKIE = "jinn_device";
export const LOCAL_BOOTSTRAP_GRANT_HEADER = "x-jinn-bootstrap-grant";
export const LOCAL_BOOTSTRAP_GRANT_TTL_MS = 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export interface PairingCodeEntry {
  expiresAt: number;
}

export type PairingCodeStore = Map<string, PairingCodeEntry>;

const pairingCodes: PairingCodeStore = new Map();

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
  const token = parsed[AUTH_COOKIE];
  const deviceId = parsed[AUTH_DEVICE_COOKIE];
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
    : raw.replace(/:\d+$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
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

export function authCookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export function authDeviceCookieHeader(deviceId: string): string {
  return `${AUTH_DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export function authCookieHeaders(secret: string, deviceId: string): string[] {
  return [authCookieHeader(secret), authDeviceCookieHeader(deviceId)];
}

export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthDeviceCookieHeader(): string {
  return `${AUTH_DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function clearAuthCookieHeaders(): string[] {
  return [clearAuthCookieHeader(), clearAuthDeviceCookieHeader()];
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
} {
  const authRequired = shouldRequireGatewayAuth(config);
  const authenticated = authRequired ? verifyGatewayAuth(req.headers, expectedToken, jinnHome) : true;
  return {
    authRequired,
    authenticated,
    canBootstrapLocal: Boolean(expectedToken && isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(headerValue(req.headers, "host"))),
    networkExposed: isNetworkHost(config.gateway.host),
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
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
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
  const devices = loadStoredAuthSessions(jinnHome);
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
  const secret = parsed[AUTH_COOKIE];
  const deviceId = parsed[AUTH_DEVICE_COOKIE];
  if (!verifyAuthSession(jinnHome, deviceId, secret)) return null;
  const devices = loadStoredAuthSessions(jinnHome);
  const idx = devices.findIndex((d) => d.id === deviceId);
  if (idx < 0) return null;
  devices[idx] = {
    ...devices[idx],
    lastSeenAt: new Date(now).toISOString(),
    ...(req.socket.remoteAddress ? { lastIp: req.socket.remoteAddress } : {}),
    ...(headerValue(req.headers, "user-agent") ? { userAgent: headerValue(req.headers, "user-agent") } : {}),
  };
  saveStoredAuthSessions(jinnHome, devices);
  const { tokenHash: _tokenHash, ...device } = devices[idx];
  return device;
}

export function currentAuthDeviceId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const cookieRaw = headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  return parseCookieHeader(cookie)[AUTH_DEVICE_COOKIE];
}

export function listAuthSessions(jinnHome: string, currentDeviceId?: string): PublicAuthSessionDevice[] {
  return loadStoredAuthSessions(jinnHome)
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
