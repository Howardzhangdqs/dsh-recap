/**
 * The durable recap chain: one append-only JSONL file per session under
 * `<storeDir>/<sessionId>.jsonl` (default `~/.dsh/recap/sessions`). Each line
 * is one recap entry — the distilled sentence of one model request (or a
 * recorded failure) plus the exact facts needed to resume the chain after a
 * host restart:
 *
 * - `sentence` + `status:'ok'` entries rebuild the prompt's history prefix
 *   verbatim (the stored text IS the next request's prefix material, byte for
 *   byte — see generator.ts);
 * - `itemIds` seeds the capture dedup so replayed log events never re-emit a
 *   delta for messages an entry already covers;
 * - `route`/`usage` power the cache-hit badge and diagnostics.
 *
 * The store deliberately never touches the session log: recap persistence is
 * plugin-owned state, which is what keeps the agent loop footprint at zero.
 * @module dsh-recap/store
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Wire shape of one persisted recap entry (fixed key order: the file is
 *  append-only JSONL and human-greppable; keep the serialization stable). */
export interface RecapStoreEntry {
  /** Schema version of this line. */
  v: 1
  /** Positional index of the entry within the session chain (0-based). */
  index: number
  /** The step identity the entry covers (`turn:step`, or `turn:tail`). */
  key: string
  turn: number
  /** Step number, or null for a turn-tail flush (user input that entered no step). */
  step: number | null
  /** Unix epoch milliseconds. */
  createdAt: number
  /** The distilled sentence (present iff status is 'ok'). */
  sentence?: string
  /** 'ok' — sentence distilled; 'failed' — generation failed, delta dropped. */
  status: 'ok' | 'failed'
  /** Failure diagnostic (present iff status is 'failed'). */
  error?: string
  /** The model route that produced the sentence. */
  route?: { provider: string; model: string }
  /** Token usage of the generating call (cacheReadTokens powers the hit badge). */
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  /** Message ids the covered delta contained (resume dedup seed). */
  itemIds: string[]
  /** Root callIds the covered request issued, in order — the exact request
   *  grouping the renderer anchors on (parallel calls share the entry). */
  callIds?: string[]
  /** Coarse size facts of the covered delta. */
  deltaStats: { items: number; bytes: number }
}

/** Default store root: `$DSH_HOME/recap/sessions`, falling back to `~/.dsh`. */
export function defaultStoreDir(): string {
  const home = process.env['DSH_HOME']
  return join(home && home !== '' ? home : join(homedir(), '.dsh'), 'recap', 'sessions')
}

/** Filesystem-safe encoding of one session id (defensive; ids are usually
 *  already uuid/cslug-shaped). */
function fileNameOf(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return `${safe === '' ? 'blank' : safe}.jsonl`
}

/**
 * The per-process recap store. One instance per plugin activation; all
 * mutations serialize per session through an in-memory promise chain, so
 * concurrent queue drains and API reads never interleave half-written lines.
 */
export class RecapStore {
  private readonly dir: string
  private readonly maxEntries: number
  private readonly cache = new Map<string, RecapStoreEntry[]>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(dir: string | undefined, maxEntries: number) {
    this.dir = dir ?? defaultStoreDir()
    this.maxEntries = maxEntries
  }

  /** The resolved store directory (diagnostics). */
  get location(): string {
    return this.dir
  }

  private fileOf(sessionId: string): string {
    return join(this.dir, fileNameOf(sessionId))
  }

  /** Serialize one mutation per session (append or compact). */
  private queue<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(run, run)
    this.chains.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  /**
   * Load (and cache) one session's full chain. Corrupt lines are skipped —
   * an interrupted append must never fence off the rest of the chain.
   */
  load(sessionId: string): Promise<readonly RecapStoreEntry[]> {
    return this.queue(sessionId, async () => {
      const cached = this.cache.get(sessionId)
      if (cached !== undefined) return cached
      let text: string
      try {
        text = await readFile(this.fileOf(sessionId), 'utf8')
      } catch {
        text = '' // missing file (first sight of the session) — empty chain
      }
      const lines = text.split('\n')
      const entries: RecapStoreEntry[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed) as RecapStoreEntry
          if (parsed !== null && typeof parsed === 'object' && parsed.v === 1) entries.push(parsed)
        } catch {
          // skip corrupt line
        }
      }
      this.cache.set(sessionId, entries)
      return entries
    })
  }

  /**
   * Append one entry and maintain the retention cap. The in-memory list is
   * updated only after the durable write succeeds.
   */
  append(sessionId: string, entry: RecapStoreEntry): Promise<void> {
    return this.queue(sessionId, async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.fileOf(sessionId), `${JSON.stringify(entry)}\n`, 'utf8')
      const entries = this.cache.get(sessionId)
      if (entries !== undefined) entries.push(entry)
      // Compaction: when the file holds more than twice the cap, rewrite it
      // down to the newest `maxEntries` lines (write-temp + rename, atomic).
      if (entries !== undefined && entries.length > this.maxEntries * 2) {
        const kept = entries.slice(-this.maxEntries)
        const tmp = `${this.fileOf(sessionId)}.tmp`
        await writeFile(tmp, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
        await rename(tmp, this.fileOf(sessionId))
        this.cache.set(sessionId, kept)
      }
    })
  }

  /** The distilled sentences of one chain, oldest first ('ok' entries only). */
  async sentences(sessionId: string): Promise<string[]> {
    const entries = await this.load(sessionId)
    return entries.filter((entry) => entry.status === 'ok' && typeof entry.sentence === 'string')
      .map((entry) => entry.sentence as string)
  }

  /** Every message id an existing entry already covers (resume dedup seed). */
  async coveredIds(sessionId: string): Promise<Set<string>> {
    const entries = await this.load(sessionId)
    const ids = new Set<string>()
    for (const entry of entries) for (const id of entry.itemIds) ids.add(id)
    return ids
  }

  /** The keys of steps an entry already covers (replayed step/end no-op). */
  async coveredKeys(sessionId: string): Promise<Set<string>> {
    const entries = await this.load(sessionId)
    return new Set(entries.map((entry) => entry.key))
  }

  /** Drop one session's chain file (used by the API's clear operation). */
  async clear(sessionId: string): Promise<void> {
    await this.queue(sessionId, async () => {
      await rm(this.fileOf(sessionId), { force: true })
      await rm(`${this.fileOf(sessionId)}.tmp`, { force: true })
      this.cache.set(sessionId, [])
    })
  }
}
