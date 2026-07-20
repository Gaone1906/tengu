export interface AuthState {
  authRequired: boolean
  authenticated: boolean
  canBootstrapLocal: boolean
  networkExposed: boolean
  /** Instance name serving this page, so pairing hints can name `jinn -i <instance> pair`. */
  instance?: string
}

export interface PairingCode {
  code: string
  expiresAt: string
  ttlSeconds?: number
}

export interface PairedDevice {
  id: string
  name: string
  kind?: "local" | "remote" | "token"
  createdAt?: string
  lastSeenAt?: string
  lastIp?: string
  userAgent?: string
  current?: boolean
}

const BASE =
  typeof window !== "undefined" && window.location.origin !== "null"
    ? window.location.origin
    : "http://localhost:3000"

const LOCAL_BOOTSTRAP_HASH_KEY = "jinn-bootstrap"
const WORKSPACE_PAIRING_HASH_KEY = "jinn-pair"

function takeHashValue(key: string): string | undefined {
  if (typeof window === "undefined") return undefined
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""))
  const value = params.get(key)?.trim()
  if (!value) return undefined
  params.delete(key)
  const nextHash = params.toString()
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
  )
  return value
}

function takeLocalBootstrapGrant(): string | undefined {
  return takeHashValue(LOCAL_BOOTSTRAP_HASH_KEY)
}

/** Consume the short-lived pairing code returned by authenticated workspace
 * creation. URL fragments never reach the server or referrer, and are removed
 * before the code is exchanged for the new instance's HttpOnly cookie. */
export function takeWorkspacePairingCode(): string | undefined {
  return takeHashValue(WORKSPACE_PAIRING_HASH_KEY)
}

function urlFor(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`
}

function withCredentials(init: RequestInit = {}): RequestInit {
  return { ...init, credentials: "include" }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `API error: ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
      else if (body?.message) message = String(body.message)
    } catch {
      /* keep fallback */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

export async function getAuthState(): Promise<AuthState> {
  const res = await fetch(urlFor("/api/auth/state"), withCredentials({ method: "GET" }))
  return jsonOrThrow<AuthState>(res)
}

export async function bootstrapLocalAuth(): Promise<boolean> {
  const grant = takeLocalBootstrapGrant()
  if (!grant) return false
  const res = await fetch(urlFor("/api/auth/bootstrap"), withCredentials({
    method: "POST",
    headers: { "X-Jinn-Bootstrap-Grant": grant },
  }))
  await jsonOrThrow(res)
  return true
}

export async function pairBrowser(secret: string, mode: "code" | "token" = "code"): Promise<void> {
  const res = await fetch(
    urlFor("/api/auth/pair"),
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "token" ? { token: secret } : { code: secret }),
    }),
  )
  await jsonOrThrow(res)
}

export async function createPairingCode(): Promise<PairingCode> {
  const res = await fetch(
    urlFor("/api/auth/pairing-codes"),
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  )
  return jsonOrThrow<PairingCode>(res)
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
  const res = await fetch(urlFor("/api/auth/devices"), withCredentials({ method: "GET" }))
  const body = await jsonOrThrow<{ devices: PairedDevice[] }>(res)
  return body.devices
}

export async function unpairDevice(deviceId: string): Promise<void> {
  const res = await fetch(
    urlFor(`/api/auth/devices/${encodeURIComponent(deviceId)}`),
    withCredentials({ method: "DELETE" }),
  )
  await jsonOrThrow(res)
}

export async function logoutBrowser(): Promise<void> {
  const res = await fetch(urlFor("/api/auth/logout"), withCredentials({ method: "POST", body: "{}" }))
  await jsonOrThrow(res)
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = urlFor(input)
  const first = await fetch(url, withCredentials(init))
  if (first.status !== 401) return first

  let state: AuthState
  try {
    state = await getAuthState()
  } catch {
    return first
  }
  if (!state.authRequired || state.authenticated || !state.canBootstrapLocal) return first

  try {
    if (!await bootstrapLocalAuth()) return first
  } catch {
    return first
  }
  return fetch(url, withCredentials(init))
}
