/**
 * The recap generator: one auxiliary model call per delta, framed so the
 * provider's prefix cache hits everything but the newest tail.
 *
 * Prompt structure (the cache contract — see docs/plans design note):
 *
 * ```
 * system:   fixed instruction (never changes)
 * user:     1. R1                     ← sentences 1..k-1, verbatim from the
 *           …                            store; bare numbered lines so the
 *           k-1. Rk-1                   next request extends this text exactly
 *           <new_delta>{…Δk JSON…}</new_delta>
 *           总结本次模型请求的数据，输出下一句。
 * assistant: Rk                        ← the model's output
 * ```
 *
 * The divergence point of call k sits at sentence line k-1's newline:
 * everything before — system + all prior sentence lines — is a byte-stable
 * prefix the provider serves from cache. The only fresh input tokens are the
 * new delta and the framing tail. The store's persisted sentence IS the next
 * request's prefix material, so the chain never drifts from what was sent.
 *
 * The call itself is a plain `ctx.llm.stream()` auxiliary request — it never
 * enters the agent loop, any request waterfall, or the session log
 * (`purpose: 'recap'` marks it for any observer), and thinking is disabled
 * (`reasoningEffort: 'off'`, stepping down 'low' → adapter-default only on
 * routes that reject the rung; both per the plugin's zero-footprint contract).
 * Note the runtime converts adapter/config throws into terminal `finish`
 * chunks — the effort ladder therefore matches on the failure's machine code
 * carried through `finishError`, not on a caught throw.
 * @module dsh-recap/generator
 */
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from "@deepseek-ai/dsh-llm"
import type { RecapEffort, ResolvedRecapConfig } from './config.ts'
import type { Context } from './context-types.ts'

/** Hard backstop on one distilled sentence (the system prompt aims tighter). */
export const SENTENCE_MAX_CHARS = 160

/** The fixed system instruction (byte-stable across every call of a chain).
 *  Style: natural, complete sentences the way a person would retell the
 *  work — NO telegraphic compression, no shorthand like "模型edit改X" or
 *  semicolon-chained fragments. */
export function recapSystemPrompt(): string {
  return [
    '你是 AI 编程助手会话的记录员。用户消息的结构是：开头若干行已定稿的编号记录句（每行一句，只读，禁止改写、重排或复述），随后一个 <new_delta> 块包含本次模型请求新增数据的严格 JSON，结尾是本次指令。',
    '仅针对 <new_delta> 中的新增数据写下一句记录：用完整、自然的叙述说明这次请求里用户要什么、模型做了什么、调用了哪些工具及结果如何（若本次请求只有用户输入没有模型响应，就记录用户输入）。',
    '写作风格：像同事复述刚发生的工作一样说话——主谓宾完整、动词用正常表达（如"运行了测试并全部通过"而不是"跑测试全过"）、文件名和命令可保留原文，其余一律用自然语言。禁止缩写堆砌、禁止把动作压成名词短语、禁止用分号串联多个动作。',
    '输出要求：恰好一行；不超过 60 个 CJK 字符或 30 个西文单词；与历史句风格一致、按时间顺序衔接；不输出编号、引号、Markdown、解释或任何前后缀。',
  ].join('\n')
}

/**
 * Serialize history sentences deterministically as bare numbered lines (no
 * closing wrapper): the next request's message then extends this text
 * verbatim with one new line, so the provider prefix cache's divergence point
 * sits exactly at the newest sentence — nothing older ever re-heats. This
 * exact format is the cache prefix's tail — never change it for an existing
 * chain (it would reframe every future request and reheat the cache).
 */
export function frameHistory(sentences: readonly string[]): string {
  const lines: string[] = []
  for (let i = 0; i < sentences.length; i += 1) {
    lines.push(`${i + 1}. ${sentences[i]}`)
  }
  return lines.join('\n')
}

/** The complete user message of one recap call (history first, delta last). */
export function frameUserMessage(sentences: readonly string[], deltaFramed: string): string {
  const history = frameHistory(sentences)
  return [
    ...(history === '' ? [] : [history]),
    '<new_delta>',
    deltaFramed,
    '</new_delta>',
    '请总结本次模型请求的数据，输出下一句。',
  ].join('\n')
}

/** Normalize one model output into a storable single-line sentence. */
export function normalizeSentence(raw: string): string {
  let text = raw.trim()
  // First non-empty line only.
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '')
  text = firstLine ?? ''
  // Strip common wrappers the model may add despite instructions: numbering,
  // bullets, quotes, bold markers.
  text = text.replace(/^\d+[.、)]\s*/, '').replace(/^[-*•]\s*/, '')
  text = text.replace(/^["'「『"']+/, '').replace(/["'」』"']+$/, '')
  text = text.replace(/\*\*/g, '')
  // Collapse inner whitespace/newlines onto one line.
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > SENTENCE_MAX_CHARS) text = `${text.slice(0, SENTENCE_MAX_CHARS - 1)}…`
  return text
}

/** Brand a plain session id string for the GenerateOptions field (the
 *  constructor lives in dsh-session, which this package need not depend on). */
function asSessionId(id: string): GenerateOptions['sessionId'] {
  return id as unknown as GenerateOptions['sessionId']
}

/** The generation-time route + effort policy (resolved per call). */
export interface RecapCallPolicy {
  provider: string
  model: string
  /** 'off' attempts thinking-disabled first ('low' fallback); 'follow' omits. */
  effort: RecapEffort
}

/** One generation outcome. */
export interface RecapGeneration {
  sentence: string
  route: { provider: string; model: string }
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

/** Per-route effort actually usable, learned from rejections (per process).
 *  Effort rides outside the message prefix, so stepping it down never
 *  invalidates the provider prefix cache. */
const routeEffort = new Map<string, RecapEffort>()

/** The effort ladder: each step is tried after the previous one was rejected
 *  by the route ('off' → 'low' → 'follow', i.e. thinking-disabled → lowest →
 *  adapter default). Models whose info carries no reasoning vocabulary reject
 *  EVERY requested effort, so 'follow' (omit the field) is the terminal rung. */
function stepDown(effort: RecapEffort): RecapEffort | undefined {
  if (effort === 'off') return 'low'
  if (effort === 'low') return 'follow'
  return undefined
}

function isUnsupportedEffort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { code?: unknown }).code === 'UNSUPPORTED_REASONING_EFFORT') return true
  // Belt and braces: some wrapping layers drop the code — the provider's
  // message is stable enough to match as a fallback.
  return /does not support reasoning effort/i.test(error.message)
}

/** Translate a terminal finish into an error (session-title-llm's mapping,
 *  preserving the provider failure's own machine code for callers downstream). */
function finishError(finish: { kind: string; failure?: { message?: unknown; code?: unknown } } | undefined): Error | undefined {
  switch (finish?.kind) {
    case 'stop':
      return undefined
    case 'aborted':
    case 'error': {
      const message = typeof finish.failure?.message === 'string' ? finish.failure.message : String(finish.kind)
      const code = typeof finish.failure?.code === 'string' ? finish.failure.code : finish.kind === 'aborted' ? 'ABORTED' : 'LLM_ERROR'
      const error = new Error(message)
      ;(error as { code?: unknown }).code = code
      return error
    }
    case 'max-tokens':
      return new Error('recap: sentence output reached maxTokens')
    default:
      return new Error(`recap: unsupported finish reason "${String(finish?.kind)}"`)
  }
}

/**
 * Generate one recap sentence for one delta.
 *
 * @param ctx - host context carrying the llm service.
 * @param config - resolved plugin config (deadline, output cap).
 * @param policy - route + effort (already resolved by the queue).
 * @param sentences - the chain's prior sentences (prefix material, verbatim).
 * @param deltaFramed - the delta's framed JSON (the only fresh input).
 * @param sessionId - routing/cancellation identity stamped on the call.
 * @param signal - outer cancellation (session abort).
 * @returns the normalized sentence and the call's accounting.
 */
export async function generateRecap(
  ctx: Context,
  config: ResolvedRecapConfig,
  policy: RecapCallPolicy,
  sentences: readonly string[],
  deltaFramed: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<RecapGeneration> {
  const attempt = async (effort: RecapEffort | undefined): Promise<RecapGeneration> => {
    const deadline = new AbortController()
    const onOuterAbort = () => deadline.abort()
    signal.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => deadline.abort(), config.requestTimeoutMs)
    try {
      const options = {
        provider: policy.provider,
        model: policy.model,
        messages: [createUserMessage({
          content: [{ type: 'text' as const, text: frameUserMessage(sentences, deltaFramed) }],
          source: { kind: 'plugin' as const, plugin: 'dsh-recap' },
        })],
        system: recapSystemPrompt(),
        maxTokens: config.maxTokens,
        sessionId: asSessionId(sessionId),
        // `purpose` is typed as a closed union upstream, but the runtime
        // treats unknown values as an ordinary auxiliary classification
        // (dsh-llm core does not validate it; adapters only special-case
        // their own known values) — the custom tag lets observers filter
        // recap calls out of telemetry and stats.
        purpose: 'recap' as GenerateOptions['purpose'],
        signal: deadline.signal,
        ...(effort !== undefined && effort !== 'follow' ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
      }
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) {
        deadline.signal.throwIfAborted()
        assembler.push(chunk)
      }
      deadline.signal.throwIfAborted()
      const terminal = finishError(assembler.finish)
      if (terminal !== undefined) throw terminal
      const blocks = assembler.blocks()
      if (blocks.some((block) => block.type === 'tool-call')) {
        throw new Error('recap: output must contain text only')
      }
      const text = blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join(' ')
      const sentence = normalizeSentence(text)
      if (sentence === '') throw new Error('recap: model produced no usable text')
      return {
        sentence,
        route: { provider: policy.provider, model: policy.model },
        usage: assembler.usage === undefined ? undefined : {
          inputTokens: assembler.usage.inputTokens,
          outputTokens: assembler.usage.outputTokens,
          cacheReadTokens: assembler.usage.cacheReadTokens,
          cacheWriteTokens: assembler.usage.cacheWriteTokens,
        },
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuterAbort)
    }
  }

  const routeKey = `${policy.provider}/${policy.model}`
  // Effort ladder with per-route memory: try the remembered (or configured)
  // rung, step down on rejection until one works, and memoize the winner.
  let effort: RecapEffort | undefined = routeEffort.get(routeKey) ?? policy.effort
  for (;;) {
    try {
      const result = await attempt(effort)
      if (effort !== undefined && effort !== policy.effort) routeEffort.set(routeKey, effort)
      return result
    } catch (error) {
      const next: RecapEffort | undefined = isUnsupportedEffort(error) && effort !== undefined ? stepDown(effort) : undefined
      if (next === undefined) throw error
      effort = next
    }
  }
}
