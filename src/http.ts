/**
 * The /recap/api JSON API and its browser-trust fence. The fence is
 * behaviorally identical to the /api gateway's (Host-header loopback or a
 * configured trusted authority passes; cross-site browser markers refuse) —
 * the same defense dsh-dashboard's sidebar routes use, re-stated here because
 * the upstream package does not export the helpers. This is a DNS-rebinding
 * / cross-site defense, not authentication.
 *
 * Every method returns `{ok: true, value}` on success and
 * `{ok: false, error: {code, message}}` on failure.
 * @module dsh-recap/http
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from './context-types.ts'
import type { RecapSettings } from './config.ts'
import { RECAP_SETTINGS_NS } from './config.ts'
import type { RecapQueue } from './queue.ts'
import type { RecapStore } from './store.ts'

/** Machine-readable error codes of the recap API. */
export type RecapErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'internal'
  | 'settings-rejected'

/** One API failure with its wire code and HTTP status. */
export class RecapError extends Error {
  constructor(
    readonly code: RecapErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

// ── Trust fence (mirror of dsh-client-connection's api-request-trust) ──────

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Decide whether one recap request may reach the plugin routes. */
export function isTrustedApiRequest(request: { headers: IncomingHttpHeaders }, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── Wire helpers ────────────────────────────────────────────────────────────

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new RecapError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RecapError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response with the given status. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof RecapError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a string, else throw bad-request. */
function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new RecapError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

// ── Route table ─────────────────────────────────────────────────────────────

/** The connection row's resolved trustedHosts (live read; the /api fence's own list). */
function trustedHostsOf(ctx: Context): string[] {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.name === 'connection') {
      const config = entry.options.config as { trustedHosts?: string[] } | undefined
      return config?.trustedHosts ?? []
    }
  }
  return []
}

/** One entry as served on the wire (store shape + live queue facts). */
export interface RecapListEntry {
  index: number
  key: string
  turn: number
  step: number | null
  createdAt: number
  sentence?: string
  status: 'ok' | 'failed'
  error?: string
  route?: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** Root callIds the covered request issued (exact request grouping). */
  callIds: string[]
  deltaStats: { items: number; bytes: number }
}

/** Whole-chain aggregates (the cache-hit share powers the UI badge). */
export interface RecapTotals {
  entries: number
  sentences: number
  failures: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** cacheReadTokens / (inputTokens + cacheReadTokens) over reported calls, 0..1. */
  cacheHitShare: number
}

/** Build the /recap/api route handler bound to the plugin's singletons. */
export function registerRecapRoutes(
  ctx: Context,
  store: RecapStore,
  queue: RecapQueue,
  settingsReader: () => RecapSettings,
  settingsWriter?: (patch: Record<string, unknown>, expectedRevision?: number) => Promise<void>,
): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/recap/api',
    handler: async (req, res) => {
      try {
        if (!isTrustedApiRequest(req, trustedHostsOf(ctx))) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const method = (req.url ?? '').replace(/^\/recap\/api\/?/, '').split('?')[0]
        const payload = await readJsonBody(req)
        switch (method) {
          case 'list': {
            const sessionId = requireString(payload, 'sessionId')
            const limitRaw = (payload as { limit?: unknown }).limit
            const limit = typeof limitRaw === 'number' && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100
            const entries = await store.load(sessionId)
            const totals: RecapTotals = {
              entries: entries.length,
              sentences: entries.filter((entry) => entry.status === 'ok').length,
              failures: entries.filter((entry) => entry.status === 'failed').length,
              inputTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              cacheHitShare: 0,
            }
            for (const entry of entries) {
              totals.inputTokens += entry.usage?.inputTokens ?? 0
              totals.cacheReadTokens += entry.usage?.cacheReadTokens ?? 0
              totals.outputTokens += entry.usage?.outputTokens ?? 0
            }
            const billedInput = totals.inputTokens + totals.cacheReadTokens
            totals.cacheHitShare = billedInput > 0 ? totals.cacheReadTokens / billedInput : 0
            const page: RecapListEntry[] = entries.slice(-limit).reverse().map((entry) => ({
              index: entry.index,
              key: entry.key,
              turn: entry.turn,
              step: entry.step,
              createdAt: entry.createdAt,
              sentence: entry.sentence,
              status: entry.status,
              error: entry.error,
              route: entry.route,
              usage: entry.usage,
              itemIds: entry.itemIds,
              callIds: entry.callIds ?? [],
              deltaStats: entry.deltaStats,
            }))
            writeJson(res, 200, { ok: true, value: { entries: page, totals, queue: queue.stats(sessionId) } })
            return
          }
          case 'generate': {
            const sessionId = requireString(payload, 'sessionId')
            await queue.drainNow(sessionId)
            writeJson(res, 200, { ok: true, value: { drained: true, queue: queue.stats(sessionId) } })
            return
          }
          case 'stats': {
            const sessionId = requireString(payload, 'sessionId')
            const entries = await store.load(sessionId)
            writeJson(res, 200, {
              ok: true,
              value: {
                queue: queue.stats(sessionId),
                store: { entries: entries.length, location: store.location },
                settings: settingsReader(),
              },
            })
            return
          }
          case 'clear': {
            const sessionId = requireString(payload, 'sessionId')
            queue.abort(sessionId)
            await store.clear(sessionId)
            writeJson(res, 200, { ok: true, value: { cleared: true } })
            return
          }
          case 'settings': {
            writeJson(res, 200, { ok: true, value: settingsReader() })
            return
          }
          case 'settings.update': {
            if (settingsWriter === undefined) {
              throw new RecapError('settings-rejected', 'settings service unavailable', 503)
            }
            const patch = (payload as { patch?: unknown }).patch
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              throw new RecapError('bad-request', 'missing "patch" object')
            }
            const revisionRaw = (payload as { expectedRevision?: unknown }).expectedRevision
            const expectedRevision = typeof revisionRaw === 'number' ? revisionRaw : undefined
            await settingsWriter(patch as Record<string, unknown>, expectedRevision)
            writeJson(res, 200, { ok: true, value: settingsReader() })
            return
          }
          case 'providers': {
            const provider = (payload as { provider?: unknown }).provider
            if (typeof provider === 'string' && provider !== '') {
              const models = await ctx.llm.listModels(provider)
              writeJson(res, 200, { ok: true, value: { models } })
              return
            }
            writeJson(res, 200, { ok: true, value: { providers: ctx.llm.listProviders() } })
            return
          }
          default:
            throw new RecapError('not-found', `unknown recap api method "${method}"`, 404)
        }
      } catch (error) {
        writeError(res, error)
      }
    },
  })
}
