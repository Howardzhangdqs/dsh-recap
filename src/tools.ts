/**
 * Two optional model-facing tools over the recap chain. Registered only when
 * the deployment opts in (`toolsEnabled`, default OFF): a tool schema list is
 * request state — registering unconditionally would add rows to every request
 * of every session, which is exactly the loop footprint this plugin refuses
 * to make. With the gate on, the schemas enter only sessions whose operators
 * asked for them.
 *
 * Conventions (per DSH plugin conventions): parameters schema-validated
 * before execute; execute returns one canonical JSON value with render as a
 * separate pure projection; exec.signal checked before work; the calling
 * agent's session is the scope — the model never passes a sessionId.
 * @module dsh-recap/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from './context-types.ts'
import type { RecapStore } from './store.ts'
import type { RecapQueue } from './queue.ts'

/** Pure text projection helper (the canonical value is already structured). */
function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}

/** Register the recap tools against the host tool registry. */
export function registerRecapTools(ctx: Context, store: RecapStore, queue: RecapQueue): () => void {
  const read = defineTool({
    name: 'recap_read',
    description: 'Read the running one-sentence-per-request recap of this session: what the user asked and what was done, in order. '
      + 'Use it to reorient yourself in a long conversation without replaying it. '
      + 'The recap is generated in the background and may lag the newest few requests.',
    parameters: {
      limit: {
        type: 'number',
        description: 'Maximum sentences to return (newest first). Default 30.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sentences: {
            type: 'array',
            required: true,
            description: 'Recap sentences, newest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true, description: 'Position in the chain (0-based).' },
                turn: { type: 'number', required: true, description: 'Turn the covered request belonged to.' },
                sentence: { type: 'string', required: true, description: 'The distilled sentence.' },
              },
            },
          },
          total: { type: 'number', required: true, description: 'Total sentences in the chain.' },
        },
      },
      render: textRender((v: { sentences: Array<{ index: number; sentence: string }>; total: number }) =>
        v.sentences.length === 0
          ? 'No recap entries yet.'
          : `${v.sentences.map((row) => `#${row.index}: ${row.sentence}`).join('\n')}\n(${v.sentences.length} of ${v.total} entries, newest first)`),
    },
    execute: async (args: { limit?: number }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('recap tools require an initiating agent')
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 30
      const entries = (await store.load(sessionId)).filter((entry) => entry.status === 'ok')
      const rows = entries.slice(-limit).reverse().map((entry) => ({
        index: entry.index,
        turn: entry.turn,
        sentence: entry.sentence ?? '',
      }))
      return { sentences: rows, total: entries.length }
    },
  })

  const refresh = defineTool({
    name: 'recap_refresh',
    description: 'Force the background recap chain of this session to catch up now (generate sentences for queued requests). '
      + 'Returns the queue state after draining. Normally unnecessary — the chain keeps itself current.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: { type: 'number', required: true, description: 'Requests still awaiting a sentence (0 when caught up).' },
          sentences: { type: 'number', required: true, description: 'Sentences in the in-memory chain view.' },
        },
      },
      render: textRender((v: { pending: number; sentences: number }) =>
        v.pending === 0 ? `Recap chain caught up (${v.sentences} sentences).` : `Recap drained; ${v.pending} requests still pending.`),
    },
    execute: async (_args: Record<string, never>, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('recap tools require an initiating agent')
      await queue.drainNow(sessionId)
      const stats = queue.stats(sessionId)
      return { pending: stats.pending, sentences: stats.sentences }
    },
  })

  const disposers = [ctx.tools.register(read), ctx.tools.register(refresh)]
  return () => { for (const dispose of disposers) dispose() }
}
