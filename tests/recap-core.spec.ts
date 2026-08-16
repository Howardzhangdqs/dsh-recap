/**
 * Core-seam specs for the dsh-recap host half: capture folding (attribution,
 * dedup, seed+mirror merge, resume, compaction, turn-tail), store round-trip,
 * generator prompt framing (the cache-prefix property) and live call behavior
 * (effort ladder, output normalization), and queue seriality/resilience.
 * All cordis/llm dependencies are structural doubles — no runtime services.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecapCapture, type StepDelta } from '../src/capture.ts'
import { resolveRecapConfig, resolveRecapSettings } from '../src/config.ts'
import { frameHistory, frameUserMessage, generateRecap, normalizeSentence, recapSystemPrompt } from '../src/generator.ts'
import { RecapQueue } from '../src/queue.ts'
import { RecapStore, type RecapStoreEntry } from '../src/store.ts'
import type { Context, RecapSessionEvent } from '../src/context-types.ts'

// ── Event synthesis helpers ─────────────────────────────────────────────────

let seq = 0
const nextSeq = (): number => (seq += 1)

function ev(type: string, data: unknown): RecapSessionEvent {
  return { type, seq: nextSeq(), time: Date.now(), data } as RecapSessionEvent
}

function userMessage(id: string, text: string): RecapSessionEvent {
  return ev('user/message', {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'human' },
  })
}

function assistantMessage(turn: number, step: number, id: string, text: string, provider = 'deepseek', model = 'test-model'): RecapSessionEvent {
  return ev('assistant/message', {
    turn,
    step,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider, model },
    },
    usage: { inputTokens: 100, outputTokens: 10 },
  })
}

function toolCall(turn: number, step: number, callId: string, name: string, args: Record<string, unknown>): RecapSessionEvent {
  return ev('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
}

function toolResult(turn: number, step: number, id: string, callId: string, text: string, error = false): RecapSessionEvent {
  return ev('tool/result', {
    turn,
    step,
    message: {
      id,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', tool: 'x' },
    },
    ...(error ? { error: { name: 'Error', code: 'E' } } : {}),
  })
}

/** A realistic one-turn / two-step conversation log. */
function sampleLog(): RecapSessionEvent[] {
  return [
    ev('request/context', { provider: 'deepseek', model: 'test-model', contextWindow: 64000 }),
    ev('turn/start', { turn: 1 }),
    userMessage('u1', '帮我看下这个仓库的结构'),
    ev('step/start', { turn: 1, step: 1 }),
    assistantMessage(1, 1, 'a1', '我先列出目录。'),
    toolCall(1, 1, 'c1', 'bash', { command: 'ls -la' }),
    toolResult(1, 1, 'r1', 'c1', 'src/ tests/ package.json'),
    ev('step/end', { turn: 1, step: 1 }),
    ev('step/start', { turn: 1, step: 2 }),
    assistantMessage(1, 2, 'a2', '仓库结构如上，接下来读 README。'),
    ev('step/end', { turn: 1, step: 2 }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]
}

function collect(): { deltas: Array<{ sessionId: string; delta: StepDelta }>; hooks: { onDelta: (sessionId: string, delta: StepDelta) => void } } {
  const deltas: Array<{ sessionId: string; delta: StepDelta }> = []
  return {
    deltas,
    hooks: {
      onDelta: (sessionId, delta) => deltas.push({ sessionId, delta }),
    },
  }
}

const config = resolveRecapConfig({ debounceMs: 0, requestTimeoutMs: 5_000 })

// ── Capture ─────────────────────────────────────────────────────────────────

describe('capture folding', () => {
  it('attributes one delta per step with the data that step produced', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    for (const event of sampleLog()) capture.handleEvent('s1', event)
    expect(deltas.map((row) => row.delta.key)).toEqual(['1:1', '1:2'])
    const first = deltas[0]?.delta
    expect(first?.turn).toBe(1)
    expect(first?.step).toBe(1)
    expect(first?.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool-call', 'tool-result'])
    expect(first?.items[2]?.name).toBe('bash')
    // The tool result names its call through the pairing tool/call.
    expect(first?.items[3]?.name).toBe('bash')
    expect(first?.itemIds).toContain('u1')
    expect(first?.route).toEqual({ provider: 'deepseek', model: 'test-model' })
    // The second step carries only its own assistant message.
    expect(deltas[1]?.delta.items.map((item) => item.kind)).toEqual(['assistant'])
  })

  it('is idempotent across a seed replay and the live mirror', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    const log = sampleLog()
    for (const event of log) capture.handleEvent('s1', event)
    const count = deltas.length
    // The same events arrive again from the store snapshot (restart replay).
    for (const event of log) capture.handleEvent('s1', event)
    expect(deltas.length).toBe(count)
  })

  it('flushes user input that entered no step as the turn tail', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 2 }))
    capture.handleEvent('s1', userMessage('u9', '后面再继续'))
    capture.handleEvent('s1', ev('turn/end', { turn: 2, reason: 'stopped' }))
    expect(deltas.map((row) => row.delta.key)).toEqual(['2:tail'])
    expect(deltas[0]?.delta.step).toBeNull()
    expect(deltas[0]?.delta.items[0]?.text).toBe('后面再继续')
  })

  it('includes the assistant reasoning alongside its visible text', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 9 }))
    capture.handleEvent('s1', userMessage('u1', '跑一下测试'))
    capture.handleEvent('s1', ev('step/start', { turn: 9, step: 1 }))
    capture.handleEvent('s1', ev('assistant/message', {
      turn: 9,
      step: 1,
      message: {
        id: 'a9',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先跑 vitest，失败再看堆栈' },
          { type: 'text', text: '测试全部通过。' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }))
    capture.handleEvent('s1', ev('step/end', { turn: 9, step: 1 }))
    const item = deltas[0]?.delta.items.find((row) => row.kind === 'assistant')
    expect(item?.text).toContain('先跑 vitest')
    expect(item?.text).toContain('测试全部通过。')
  })

  it('holds a step closed early until its last tool result lands', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 4 }))
    capture.handleEvent('s1', userMessage('u4', '查一下状态'))
    capture.handleEvent('s1', ev('step/start', { turn: 4, step: 1 }))
    capture.handleEvent('s1', assistantMessage(4, 1, 'a4', '我来查。'))
    capture.handleEvent('s1', toolCall(4, 1, 'c4', 'bash', { command: 'systemctl status dsh' }))
    // step/end arrives while the tool is still executing (the result has not
    // landed): the delta must NOT close here.
    capture.handleEvent('s1', ev('step/end', { turn: 4, step: 1 }))
    expect(deltas.length).toBe(0)
    // The result lands: NOW the delta closes, and it contains the result.
    capture.handleEvent('s1', toolResult(4, 1, 'r4', 'c4', 'active (running)'))
    expect(deltas.map((row) => row.delta.key)).toEqual(['4:1'])
    expect(deltas[0]?.delta.items.some((item) => item.kind === 'tool-result' && item.text.includes('active'))).toBe(true)
    // The normal ordering (result before step/end) is unaffected.
    capture.handleEvent('s1', ev('turn/end', { turn: 4, reason: 'stop' }))
    expect(deltas.length).toBe(1)
  })

  it('flushes a parked bucket when the turn ends without its result', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 5 }))
    capture.handleEvent('s1', ev('step/start', { turn: 5, step: 1 }))
    capture.handleEvent('s1', assistantMessage(5, 1, 'a5', '执行中…'))
    capture.handleEvent('s1', toolCall(5, 1, 'c5', 'bash', { command: 'sleep 100' }))
    capture.handleEvent('s1', ev('step/end', { turn: 5, step: 1 }))
    expect(deltas.length).toBe(0) // parked: tool never completed
    capture.handleEvent('s1', ev('turn/end', { turn: 5, reason: 'interrupted' }))
    // The turn closing flushes the frozen bucket (call present, result absent).
    expect(deltas.map((row) => row.delta.key)).toEqual(['5:1'])
    expect(deltas[0]?.delta.items.some((item) => item.kind === 'tool-call')).toBe(true)
    expect(deltas[0]?.delta.items.some((item) => item.kind === 'tool-result')).toBe(false)
  })

  it('distills one delta per request; parallel calls share it, consecutive requests do not', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 3 }))
    capture.handleEvent('s1', userMessage('u3', '修一下这个 bug'))
    // Step 1: ONE request issuing TWO parallel calls — one delta.
    capture.handleEvent('s1', ev('step/start', { turn: 3, step: 1 }))
    capture.handleEvent('s1', ev('assistant/message', {
      turn: 3, step: 1,
      message: {
        id: 'a31', role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c31', name: 'bash', arguments: '{}' },
          { type: 'tool-call', id: 'c31b', name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }))
    capture.handleEvent('s1', toolCall(3, 1, 'c31', 'bash', { command: 'ls' }))
    capture.handleEvent('s1', toolCall(3, 1, 'c31b', 'read', { path: 'x' }))
    capture.handleEvent('s1', toolResult(3, 1, 'r31', 'c31', 'file list'))
    capture.handleEvent('s1', toolResult(3, 1, 'r31b', 'c31b', 'contents'))
    capture.handleEvent('s1', ev('step/end', { turn: 3, step: 1 }))
    expect(deltas.map((row) => row.delta.key)).toEqual(['3:1'])
    // The exact request grouping rides the delta for the renderer.
    expect(deltas[0]?.delta.callIds).toEqual(['c31', 'c31b'])
    expect(deltas[0]?.delta.items.filter((item) => item.kind === 'tool-call')).toHaveLength(2)
    // Step 2: the NEXT request — its own delta, interleaved during the work.
    capture.handleEvent('s1', ev('step/start', { turn: 3, step: 2 }))
    capture.handleEvent('s1', toolCall(3, 2, 'c32', 'edit', { path: 'x' }))
    capture.handleEvent('s1', toolResult(3, 2, 'r32', 'c32', 'edited'))
    capture.handleEvent('s1', ev('step/end', { turn: 3, step: 2 }))
    expect(deltas.map((row) => row.delta.key)).toEqual(['3:1', '3:2'])
    expect(deltas[1]?.delta.callIds).toEqual(['c32'])
  })

  it('flushes a parked interrupted step at the turn end with its call grouping', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    capture.handleEvent('s1', ev('turn/start', { turn: 4 }))
    capture.handleEvent('s1', ev('step/start', { turn: 4, step: 1 }))
    capture.handleEvent('s1', ev('assistant/message', {
      turn: 4, step: 1,
      message: { id: 'a41', role: 'assistant', content: [{ type: 'tool-call', id: 'c41', name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }))
    capture.handleEvent('s1', toolCall(4, 1, 'c41', 'bash', { command: 'true' }))
    capture.handleEvent('s1', ev('step/end', { turn: 4, step: 1 }))
    expect(deltas.length).toBe(0) // parked: tool never completed
    capture.handleEvent('s1', ev('turn/end', { turn: 4, reason: 'interrupted' }))
    // The turn closing flushes the frozen request (call present, result absent).
    expect(deltas.map((row) => row.delta.key)).toEqual(['4:1'])
    expect(deltas[0]?.delta.callIds).toEqual(['c41'])
    expect(deltas[0]?.delta.items.some((item) => item.kind === 'tool-call')).toBe(true)
    expect(deltas[0]?.delta.items.some((item) => item.kind === 'tool-result')).toBe(false)
  })

  it('folds compaction replacement messages as new data (fresh ids)', () => {
    const { deltas, hooks } = collect()
    const capture = new RecapCapture(config, hooks)
    for (const event of sampleLog()) capture.handleEvent('s1', event)
    const before = deltas.length
    // Compaction replaces the surface: a new summary message with a new id.
    capture.handleEvent('s1', ev('turn/start', { turn: 3 }))
    capture.handleEvent('s1', userMessage('summary-1', '此前会话的压缩摘要……'))
    capture.handleEvent('s1', ev('step/start', { turn: 3, step: 1 }))
    capture.handleEvent('s1', assistantMessage(3, 1, 'a3', '收到，继续。'))
    capture.handleEvent('s1', ev('step/end', { turn: 3, step: 1 }))
    expect(deltas.length).toBe(before + 1)
    expect(deltas.at(-1)?.delta.items[0]?.text).toContain('压缩摘要')
  })

  it('resumes from store coverage without re-emitting covered deltas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recap-store-'))
    try {
      const store = new RecapStore(dir, 100)
      const covered: RecapStoreEntry = {
        v: 1,
        index: 0,
        key: '1:1',
        turn: 1,
        step: 1,
        createdAt: Date.now(),
        sentence: '用户要求查看仓库结构，模型列出了目录。',
        status: 'ok',
        itemIds: ['u1', 'a1', 'call:c1', 'r1'],
        deltaStats: { items: 4, bytes: 100 },
      }
      await store.append('s1', covered)
      const { deltas, hooks } = collect()
      const capture = new RecapCapture(config, hooks)
      await capture.prime('s1', store, sampleLog())
      // The covered step re-emits nothing; only step 1:2 remains.
      expect(deltas.map((row) => row.delta.key)).toEqual(['1:2'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── Store ───────────────────────────────────────────────────────────────────

describe('store round-trip', () => {
  let dir: string
  beforeEach(async (): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), 'recap-store-'))
  })
  afterEach(async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  })

  const entry = (index: number, key: string, sentence: string, itemIds: string[] = []): RecapStoreEntry => ({
    v: 1,
    index,
    key,
    turn: index + 1,
    step: 1,
    createdAt: 1_700_000_000_000 + index,
    sentence,
    status: 'ok',
    itemIds,
    deltaStats: { items: 1, bytes: 10 },
  })

  it('round-trips entries, sentences, and coverage', async () => {
    const store = new RecapStore(dir, 100)
    await store.append('s1', entry(0, '1:1', '第一句', ['u1']))
    await store.append('s1', entry(1, '1:2', '第二句', ['u2']))
    await store.append('s1', { ...entry(2, '1:3', '失败的一句', ['u3']), status: 'failed', sentence: undefined, error: 'boom' })
    expect(await store.sentences('s1')).toEqual(['第一句', '第二句'])
    expect([...await store.coveredIds('s1')].sort()).toEqual(['u1', 'u2', 'u3'])
    expect(await store.coveredKeys('s1')).toEqual(new Set(['1:1', '1:2', '1:3']))
  })

  it('skips corrupt lines and reloads a fresh instance from disk', async () => {
    const { appendFile, writeFile } = await import('node:fs/promises')
    const file = join(dir, 's2.jsonl')
    await writeFile(file, `${JSON.stringify(entry(0, '1:1', '好句'))}\n{{{not json\n`, 'utf8')
    await appendFile(file, `${JSON.stringify(entry(1, '1:2', '次句'))}\n`, 'utf8')
    const store = new RecapStore(dir, 100)
    expect((await store.load('s2')).length).toBe(2)
    expect(await store.sentences('s2')).toEqual(['好句', '次句'])
  })

  it('clears the chain file', async () => {
    const store = new RecapStore(dir, 100)
    await store.append('s1', entry(0, '1:1', '第一句'))
    await store.clear('s1')
    expect(await store.sentences('s1')).toEqual([])
    await expect(readFile(join(dir, 's1.jsonl'), 'utf8')).rejects.toThrow()
  })
})

/** The longest common byte prefix of two strings. */
function commonPrefix(a: string, b: string): string {
  let end = 0
  while (end < a.length && end < b.length && a[end] === b[end]) end += 1
  return a.slice(0, end)
}

// ── Generator: framing (the cache contract) ────────────────────────────────

describe('generator framing', () => {
  it('normalizes model output into a single clean line', () => {
    expect(normalizeSentence('  1. "模型调用了 bash 列出目录"  \n')).toBe('模型调用了 bash 列出目录')
    expect(normalizeSentence('- **读取 README**\n第二行被丢弃')).toBe('读取 README')
    expect(normalizeSentence('x'.repeat(400))).toHaveLength(160)
    expect(normalizeSentence('\n\n')).toBe('')
  })

  it('keeps the request prefix byte-stable as the chain grows', () => {
    const sentences = ['用户要求查看仓库结构。', '模型列出目录并读取 README。', '模型修改了配置文件。']
    const deltas = ['{"request":{"turn":1,"step":1},"items":[]}', '{"request":{"turn":1,"step":2},"items":[]}', '{"request":{"turn":2,"step":1},"items":[]}']
    // Call k embeds history lines 1..k-1 then Δk. The message of call k+1
    // extends call k's history verbatim by exactly one line, so the byte
    // divergence sits at the newest sentence — nothing older ever re-heats.
    const message1 = frameUserMessage(sentences.slice(0, 1), deltas[1] ?? '')
    const message2 = frameUserMessage(sentences.slice(0, 2), deltas[2] ?? '')
    const historyOfFirst = frameHistory(sentences.slice(0, 1))
    expect(message2.startsWith(`${historyOfFirst}\n`)).toBe(true)
    expect(message1.startsWith(historyOfFirst)).toBe(true)
    // Their common prefix is exactly the older history (both start with it;
    // they diverge right after — at line 2 vs the delta tag).
    const common = commonPrefix(message1, message2)
    expect(common).toBe(`${historyOfFirst}\n`)
    // Determinism: identical inputs, identical bytes.
    expect(frameUserMessage(sentences, deltas[0] ?? '')).toBe(frameUserMessage(sentences, deltas[0] ?? ''))
    // The system prompt is a constant function.
    expect(recapSystemPrompt()).toBe(recapSystemPrompt())
  })
})

// ── Generator: live call against a mocked llm service ──────────────────────

/** Build a Context double whose llm.stream replays the given chunk program. */
function llmContext(program: (options: Record<string, unknown>) => Array<Record<string, unknown>>): Context {
  return {
    llm: {
      stream: (options: Record<string, unknown>) => {
        const chunks = program(options)
        return (async function* (): AsyncIterable<Record<string, unknown>> {
          for (const chunk of chunks) yield chunk as never
        })()
      },
    },
    get: () => undefined,
  } as unknown as Context
}

const textChunks = (text: string): Array<Record<string, unknown>> => [
  { type: 'text-delta', index: 0, text },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 500 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('generator live call', () => {
  const policy = { provider: 'deepseek', model: 'test-model', effort: 'off' as const }

  it('distills text, stamps purpose, and reports usage', async () => {
    let seen: Record<string, unknown> | undefined
    const ctx = llmContext((options) => {
      seen = options
      return textChunks('模型调用 bash 列出了目录。')
    })
    const result = await generateRecap(ctx, config, policy, ['历史句一'], '{"items":[]}', 's1', new AbortController().signal)
    expect(result.sentence).toBe('模型调用 bash 列出了目录。')
    expect(result.usage?.cacheReadTokens).toBe(500)
    expect(seen?.['purpose']).toBe('recap')
    expect(seen?.['provider']).toBe('deepseek')
    expect(seen?.['reasoningEffort']).toBe('off')
    const message = (seen?.['messages'] as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text ?? ''
    expect(message).toContain('1. 历史句一')
    expect(message.indexOf('1. 历史句一')).toBeLessThan(message.indexOf('<new_delta>'))
  })

  it('steps down the effort ladder when rungs are rejected (off → low → follow)', async () => {
    // The real runtime converts config/adapter throws into terminal
    // finish-error chunks (never rethrows), so rejection must ride the
    // chunk stream — exactly what this program reproduces.
    const unsupported = (effort: string): Array<Record<string, unknown>> => [
      { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: `provider "zai" model "glm" does not support reasoning effort "${effort}"` } } },
    ]
    const efforts: Array<string | undefined> = []
    const ctx = llmContext((options) => {
      const effort = options['reasoningEffort'] as string | undefined
      efforts.push(effort)
      if (effort === 'off') return unsupported('off')
      if (effort === 'low') return unsupported('low')
      return textChunks('省略努力后的输出。')
    })
    const result = await generateRecap(ctx, config, policy, [], '{"items":[]}', 's1', new AbortController().signal)
    expect(result.sentence).toBe('省略努力后的输出。')
    expect(efforts).toEqual(['off', 'low', undefined])
    // The terminal rung is remembered per route: a second call goes straight
    // to the omitted field (no wasted rejections).
    const efforts2: Array<string | undefined> = []
    const ctx2 = llmContext((options) => {
      efforts2.push(options['reasoningEffort'] as string | undefined)
      return textChunks('再次输出。')
    })
    await generateRecap(ctx2, config, policy, [], '{"items":[]}', 's1', new AbortController().signal)
    expect(efforts2).toEqual([undefined])
  })

  it('falls back to low when only off is rejected, and remembers it', async () => {
    const efforts: Array<string | undefined> = []
    const ctx = llmContext((options) => {
      const effort = options['reasoningEffort'] as string | undefined
      efforts.push(effort)
      if (effort === 'off') {
        return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'does not support reasoning effort "off"' } } }]
      }
      return textChunks('低努力输出。')
    })
    const result = await generateRecap(ctx, config, { ...policy, model: 'other-model' }, [], '{"items":[]}', 's1', new AbortController().signal)
    expect(result.sentence).toBe('低努力输出。')
    expect(efforts).toEqual(['off', 'low'])
  })

  it('rejects tool-call outputs and empty outputs', async () => {
    const toolCtx = llmContext(() => [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '{}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(generateRecap(toolCtx, config, policy, [], '{"items":[]}', 's1', new AbortController().signal)).rejects.toThrow(/text only/)
    const emptyCtx = llmContext(() => [{ type: 'finish', reason: { kind: 'stop' } }])
    await expect(generateRecap(emptyCtx, config, policy, [], '{"items":[]}', 's1', new AbortController().signal)).rejects.toThrow(/no usable text/)
  })
})

// ── Queue: seriality, ordering, resilience ─────────────────────────────────

describe('queue', () => {
  let dir: string
  beforeEach(async (): Promise<void> => {
    dir = await mkdtemp(join(tmpdir(), 'recap-queue-'))
  })
  afterEach(async (): Promise<void> => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const deltaOf = (key: string, turn: number, step: number, ids: string[]): StepDelta => ({
    key,
    turn,
    step,
    items: [{ kind: 'assistant', text: `Δ ${key}` }],
    itemIds: ids,
    callIds: [],
    framed: `{"request":{"turn":${turn},"step":${step}},"items":[{"kind":"assistant","text":"Δ ${key}"}]}`,
    route: { provider: 'deepseek', model: 'test-model' },
  })

  function queueWith(ctx: Context, settingsValue?: Partial<ReturnType<typeof resolveRecapSettings>>): { queue: RecapQueue; store: RecapStore } {
    const store = new RecapStore(dir, 100)
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir, debounceMs: 0, requestTimeoutMs: 5_000 }),
      store,
      settings: () => resolveRecapSettings({ enabled: true, effort: 'off', ...settingsValue }),
    })
    return { queue, store }
  }

  it('drains serially, in order, appending one entry per delta', async () => {
    const ctx = llmContext(() => textChunks(`第 N 句`))
    const { queue, store } = queueWith(ctx)
    queue.offer('s1', deltaOf('1:1', 1, 1, ['a1']))
    queue.offer('s1', deltaOf('1:2', 1, 2, ['a2']))
    queue.offer('s1', deltaOf('2:1', 2, 1, ['a3']))
    await queue.drainNow('s1')
    const entries = await store.load('s1')
    expect(entries.length).toBe(3)
    expect(entries.map((row) => row.key)).toEqual(['1:1', '1:2', '2:1'])
    expect(entries.every((row) => row.status === 'ok')).toBe(true)
    expect(await store.sentences('s1')).toHaveLength(3)
    expect(queue.stats('s1').pending).toBe(0)
  })

  it('records failures and keeps the chain going', async () => {
    let calls = 0
    const ctx = llmContext(() => {
      calls += 1
      if (calls <= 1) throw new Error('route down')
      return textChunks('恢复后的句子')
    })
    const { queue, store } = queueWith(ctx)
    queue.offer('s1', deltaOf('1:1', 1, 1, ['a1']))
    queue.offer('s1', deltaOf('1:2', 1, 2, ['a2']))
    await queue.drainNow('s1')
    const entries = await store.load('s1')
    expect(entries.map((row) => row.status)).toEqual(['failed', 'ok'])
    expect(entries[1]?.sentence).toBe('恢复后的句子')
    // Failed coverage still dedups: their itemIds are recorded.
    expect([...await store.coveredIds('s1')].sort()).toEqual(['a1', 'a2'])
  })

  it('requeues a rate-limited generation and retries after the backoff', async () => {
    // zai's 429/1305「访问量过大」 arrives as a RATE_LIMIT finish error: the
    // delta is fine, the route is busy — it must requeue (no failure entry,
    // ids stay uncovered) and succeed once the backoff elapses.
    let calls = 0
    const ctx = llmContext(() => {
      calls += 1
      if (calls === 1) {
        return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429: {"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}' } } }]
      }
      return textChunks('限流恢复后的句子')
    })
    const store = new RecapStore(dir, 100)
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir, debounceMs: 0, requestTimeoutMs: 5_000, retryBackoffMs: 20 }),
      store,
      settings: () => resolveRecapSettings({ enabled: true, effort: 'off' }),
    })
    queue.offer('s1', deltaOf('1:1', 1, 1, ['a1']))
    await queue.drainNow('s1')
    expect(await store.load('s1')).toHaveLength(0) // no failure entry punched
    expect(queue.stats('s1').pending).toBe(1) // the delta requeued
    const waiting = queue.stats('s1').items[0]
    expect(waiting?.state).toBe('retrying') // surfaced for the inline chip
    expect(waiting?.retryInMs).toBeGreaterThan(0)
    expect(waiting?.retryInMs).toBeLessThanOrEqual(20)
    expect([...await store.coveredIds('s1')].sort()).toEqual([]) // replay still eligible
    await new Promise((resolve) => setTimeout(resolve, 80)) // backoff (20ms) + the retry drain
    const entries = await store.load('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe('ok')
    expect(entries[0]?.sentence).toBe('限流恢复后的句子')
    expect(queue.stats('s1').pending).toBe(0)
  })

  it('widens the backoff exponentially on repeated rate limits', async () => {
    // Each consecutive transient failure re-arms the timer with base × 2^(n-1)
    // — the stats face's live countdown is the observable.
    let calls = 0
    const ctx = llmContext(() => {
      calls += 1
      return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 busy' } } }]
    })
    const store = new RecapStore(dir, 100)
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir, debounceMs: 0, requestTimeoutMs: 5_000, retryBackoffMs: 100 }),
      store,
      settings: () => resolveRecapSettings({ enabled: true, effort: 'off' }),
    })
    queue.offer('s1', deltaOf('1:1', 1, 1, ['a1']))
    await queue.drainNow('s1') // attempt 1 → backoff 100ms (2^0)
    const first = queue.stats('s1').items[0]?.retryInMs ?? 0
    expect(first).toBeGreaterThan(50)
    expect(first).toBeLessThanOrEqual(100)
    await new Promise((resolve) => setTimeout(resolve, 130)) // first timer fires → attempt 2 → backoff 200ms (2^1)
    const second = queue.stats('s1').items[0]?.retryInMs ?? 0
    expect(second).toBeGreaterThan(100)
    expect(second).toBeLessThanOrEqual(200)
    expect(queue.stats('s1').items[0]?.state).toBe('retrying')
    queue.abort('s1') // drop the 200ms timer
  })

  it('parks after a failure streak and resumes on the next trigger', async () => {
    const ctx = llmContext(() => {
      throw new Error('route down')
    })
    const { queue, store } = queueWith(ctx)
    for (let i = 1; i <= 6; i += 1) queue.offer('s1', deltaOf(`1:${i}`, 1, i, [`a${i}`]))
    await queue.drainNow('s1')
    const entries = await store.load('s1')
    expect(entries.length).toBe(3) // the streak parks after three failures
    expect(queue.stats('s1').pending).toBe(3)
    expect(queue.stats('s1').consecutiveFailures).toBe(3)
  })

  it('merges the oldest pending deltas under backpressure', () => {
    const ctx = llmContext(() => textChunks('句'))
    const { queue } = queueWith(ctx)
    const tiny = resolveRecapConfig({ maxPending: 3 })
    const capped = new RecapQueue({
      ctx,
      config: { ...tiny, storeDir: dir },
      store: new RecapStore(dir, 100),
      settings: () => resolveRecapSettings({ enabled: true }),
    })
    for (let i = 1; i <= 5; i += 1) capped.offer('s1', deltaOf(`1:${i}`, 1, i, [`a${i}`]))
    const stats = capped.stats('s1')
    expect(stats.pending).toBe(3) // 5 offered → 3 merged + 2 recent
  })

  it('gates the step-end trigger to every interval-th delta (intervalElapsed)', () => {
    const ctx = llmContext(() => textChunks('句'))
    const { queue } = queueWith(ctx, { interval: 3 })
    const fires: boolean[] = []
    for (let i = 1; i <= 6; i += 1) {
      queue.offer('s1', deltaOf(`1:${i}`, 1, i, [`a${i}`]))
      fires.push(queue.intervalElapsed('s1'))
    }
    expect(fires).toEqual([false, false, true, false, false, true])
    // Interval 1 (the default) fires on every delta — the per-request cadence.
    const { queue: perRequest } = queueWith(ctx)
    expect(perRequest.intervalElapsed('s1')).toBe(true)
  })

  it('folds interval batches into one sentence per N requests', async () => {
    const ctx = llmContext(() => textChunks('合并句'))
    const { queue, store } = queueWith(ctx, { interval: 2 })
    for (let i = 1; i <= 4; i += 1) queue.offer('s1', deltaOf(`1:${i}`, 1, i, [`a${i}`]))
    await queue.drainNow('s1')
    const entries = await store.load('s1')
    expect(entries.length).toBe(2) // 4 deltas → 2 batch sentences
    expect(entries.every((row) => row.status === 'ok')).toBe(true)
    expect(entries.map((row) => row.key)).toEqual(['merged:1:1..1:2', 'merged:1:3..1:4'])
    // A batch row is step-null (a [T<turn>] coordinate) covering every id.
    expect(entries.every((row) => row.step === null && row.turn === 1)).toBe(true)
    expect(entries[0]?.itemIds).toEqual(['a1', 'a2'])
    expect(await store.sentences('s1')).toHaveLength(2)
  })

  it('keeps the incomplete interval tail per-delta until the batch fills', async () => {
    const ctx = llmContext(() => textChunks('句'))
    const { queue, store } = queueWith(ctx, { interval: 3 })
    for (let i = 1; i <= 4; i += 1) queue.offer('s1', deltaOf(`1:${i}`, 1, i, [`a${i}`]))
    await queue.drainNow('s1')
    const entries = await store.load('s1')
    // 4 deltas at interval 3 → one folded batch of 3 + the tail delta as-is.
    expect(entries.map((row) => row.key)).toEqual(['merged:1:1..1:3', '1:4'])
    expect(entries[1]?.step).toBe(4)
  })

  it('applies a live interval change to the next gate call', () => {
    // The cadence gate reads the setting on every call — widening the
    // granularity mid-session affects the very next trigger, not the next
    // plugin reload. (The drain's batching reads the same live value.)
    const ctx = llmContext(() => textChunks('句'))
    let interval = 1
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir, debounceMs: 0, requestTimeoutMs: 5_000 }),
      store: new RecapStore(dir, 100),
      settings: () => resolveRecapSettings({ enabled: true, effort: 'off', interval }),
    })
    expect(queue.intervalElapsed('s1')).toBe(true) // interval 1 fires on every delta
    interval = 3
    const fires = [1, 2, 3].map(() => queue.intervalElapsed('s1'))
    expect(fires).toEqual([false, false, true])
  })

  it('exposes pending work items with coordinates (queued → generating → gone)', async () => {
    // A gated generator freezes the drain mid-call so the stats face can be
    // observed in every lifecycle state — the client renders one 总结中 chip
    // per item at the item's own request position.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ctx = {
      llm: {
        stream: () => (async function* () {
          await gate
          yield { type: 'text-delta', index: 0, text: '第一句' } as never
          yield { type: 'finish', reason: { kind: 'stop' } } as never
        })(),
      },
      get: () => undefined,
    } as unknown as Context
    const { queue } = queueWith(ctx)
    queue.offer('s1', { ...deltaOf('1:1', 1, 1, ['a1']), callIds: ['call-1'] })
    queue.offer('s1', { ...deltaOf('1:2', 1, 2, ['a2']), callIds: ['call-2a', 'call-2b'] })
    expect(queue.stats('s1').items).toEqual([
      { key: '1:1', turn: 1, step: 1, callIds: ['call-1'], state: 'queued' },
      { key: '1:2', turn: 1, step: 2, callIds: ['call-2a', 'call-2b'], state: 'queued' },
    ])
    const drained = queue.drainNow('s1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(queue.stats('s1').items).toEqual([
      { key: '1:1', turn: 1, step: 1, callIds: ['call-1'], state: 'generating' },
      { key: '1:2', turn: 1, step: 2, callIds: ['call-2a', 'call-2b'], state: 'queued' },
    ])
    release?.()
    await drained
    expect(queue.stats('s1').items).toEqual([])
  })

  it('keeps the shifted delta when parking for a missing route', async () => {
    const ctx = llmContext(() => textChunks('never'))
    const store = new RecapStore(dir, 100)
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir, debounceMs: 0 }),
      store,
      settings: () => resolveRecapSettings({ enabled: true }),
    })
    queue.offer('s1', { ...deltaOf('1:1', 1, 1, ['a1']), route: undefined })
    await queue.drainNow('s1')
    expect(await store.load('s1')).toHaveLength(0)
    // The park must not silently drop the work — it stays queued (and thus
    // keeps its 总结中 chip) until a route exists.
    expect(queue.stats('s1').items.map((item) => item.key)).toEqual(['1:1'])
  })

  it('parks generation when the master switch is off', async () => {
    const ctx = llmContext(() => textChunks('句'))
    const store = new RecapStore(dir, 100)
    const queue = new RecapQueue({
      ctx,
      config: resolveRecapConfig({ storeDir: dir }),
      store,
      settings: () => resolveRecapSettings({ enabled: false }),
    })
    queue.offer('s1', deltaOf('1:1', 1, 1, ['a1']))
    await queue.drainNow('s1')
    expect(await store.load('s1')).toHaveLength(0)
    expect(queue.stats('s1').pending).toBe(1)
  })
})
