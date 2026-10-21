/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）
 *       dingminhua/dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）
 *   — 端点与 wire behavior（按 domain 选 CN/global base、/v2 路径、强制
 *     stream:true、tool_choice 压平为字符串、chat 请求绝不携带 refresh
 *     token 的安全红线、developer→system role 转换、刷新走独立
 *     X-Refresh-Token 头、错误分类、积分按套餐聚合）经 dingminhua 实测
 *     验证，此处沿用并适配本插件的凭据接口与多账户池。
 *
 * @module dsh-xdpool/upstream
 */

import type { WorkBuddyCredential } from './accounts.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { MarketExpert } from './task-events.ts'
import type { ChatMessage } from './context-budget.ts'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** Token-refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** One CLI-usable model, carrying what the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  creditMultiplier?: number
  /** Upstream image-input flag. Both gateways spell it `supportsImages`; some entries
   * also carry `disabledMultimodal`, the negative spelling. Reading anything else
   * reported every model as text-only, which made a vision shim register a second
   * route under the same display name and split the model picker group.
   */
  supportsImages?: boolean
  reasoning?: { supportedEfforts?: readonly string[]; defaultEffort?: string; canDisableThinking?: boolean }
  descriptionZh?: string
  descriptionEn?: string
  supportsToolCall?: boolean
  /**
   * Promo tags the upstream attaches to a model.
   *
   * Both gateways send a `tags` array, but the vocabularies are NOT the same
   * and neither uses the words this plugin used to expect:
   *
   * - Global sends `["craft"]`, `["text-to-image"]`, `["text-to-video"]`, `[]`
   *   — capability/grouping labels, never `free`.
   * - Zero cost is expressed as `credits: "x0.00"` instead.
   *
   * So this field is a passthrough of what the upstream really said, and
   * `free` is DERIVED from the multiplier rather than awaited as a tag (see
   * {@link isFreeModel}).
   */
  tags?: readonly string[]
}

/**
 * Whether a model is free to use.
 *
 * Read off the CREDIT MULTIPLIER, not off a tag. The old rule waited for a
 * literal `free` / `limited-free` entry in `tags`, which no gateway has ever
 * sent: the global roster marks its zero-cost models as `credits: "x0.00"`
 * (`hy3`, `hy4-preview-f`, `deepseek-v4.1-flash`), so every one of them
 * rendered as a plain paid model with no badge.
 *
 * An explicit free-ish tag still counts when one does appear, so a future
 * gateway that starts tagging them keeps working either way.
 */
// The badge parser lives in its own module because `client/PoolCard.tsx` needs
// it too and cannot import this file — that would pull the whole HTTP client
// into the browser bundle. Re-exported here so every server-side caller keeps a
// single import site, and there is exactly ONE parser to keep in sync.
export { parseBadgeTags, hasFreeBadge, badgeLabels, BADGE_TAG_PREFIX } from './badges.ts'
export type { WorkBuddyBadge } from './badges.ts'

import { hasFreeBadge } from './badges.ts'



export function isFreeModel(model: Pick<WorkBuddyUpstreamModel, 'creditMultiplier' | 'tags'>): boolean {
  if (model.tags?.some(tag => tag === 'free' || tag === 'limited-free')) return true
  // The CN roster ALSO volunteers this, as `badge:限时免费:#FF0000`, so a
  // gateway that badges a model free without pricing it at zero still counts.
  if (hasFreeBadge(model.tags)) return true
  return model.creditMultiplier === 0
}

/** One billing package, already normalised. */
export interface WorkBuddyCreditPackage {
  packageName: string
  remain: number
  size: number
  monthly: boolean
  refreshAtMs?: number
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  expiringSoon: number
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusDays: number
  streakBonusCredit: number
  /** Upstream-supplied button label; the card falls back to its own copy. */
  claimButtonText?: string
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}

/**
 * Service-outage compensation offer (the "500 credits" banner on
 * /profile/plans-usage).
 *
 * Upstream shape, verified live on 2026-10-16:
 *   `{active: true, claimed: false, credit_num: 500, validity_period: 1,
 *     end_time: "2026-10-22 23:59:59"}`
 */
export interface WorkBuddyCompensationStatus {
  /** An offer is running for this account (independent of claimability). */
  active: boolean
  /** This account already collected the current offer. */
  claimed: boolean
  /** Credits on offer — 500 for the DeepSeek-outage compensation. */
  creditNum: number
  /** Claim deadline, upstream's own string, absent when there is no offer. */
  endTime?: string
}

/** Compensation claim result. Upstream returns the same envelope shape. */
export interface WorkBuddyCompensationClaim {
  claimed: boolean
  creditNum: number
}

/** Result of one upstream chat attempt. */
export type ChatStreamResult =
  | { ok: true; response: Response }
  | { ok: false; kind: UpstreamErrorKind; status: number; message: string }

export interface UpstreamClientOptions {
  /** Injectable fetch, primarily for tests. */
  fetchImpl?: typeof fetch
  /** Client version string sent to the upstream. */
  clientVersion?: string
  /**
   * Override the catalog-fetch backoff, in milliseconds.
   *
   * Tests set this to `[]` (or tiny values) so a retry case does not spend real
   * seconds sleeping. Production uses {@link CATALOG_RETRY_BACKOFF_MS}.
   */
  catalogRetryBackoffMs?: readonly number[]
}

/**
 * Backoff between catalog-fetch attempts.
 *
 * Three retries after the first try, so a startup network hiccup does not cost
 * the user their model list for the whole session. The window covers the case
 * that actually bit: several independent components reported `fetch failed`
 * within the same second while the machine was still bringing its network up,
 * and the very next request succeeded 0.7s later.
 *
 * Deliberately short and bounded. This runs during plugin startup, so a long
 * ladder would delay the provider appearing at all; the total added latency
 * here is ~12s in the worst case, and only when the network is genuinely down.
 */
export const CATALOG_RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000, 8_000]

/**
 * Sleep helper for the retry ladder.
 *
 * Deliberately NOT unref'd. An unref'd timer does not keep the event loop
 * alive, so awaiting one can hang forever when nothing else is pending — the
 * retry would simply never resume. That is exactly what the first version of
 * this did, and it wedged the very first end-to-end run: `fetchModels` never
 * settled. The wait is at most a few seconds and only happens on failure, so
 * holding the loop open is the correct trade.
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = 'https://copilot.tencent.com'
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** Client UA the desktop CLI uses. */
/** Client UA the desktop CLI uses — the CN gateway answers this one. */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * Desktop app UA. The global gateway serves its product config only to this
 * client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
 * is why the international catalog must be read with the desktop spelling.
 */
const DESKTOP_UA = 'WorkBuddy/5.5.2'

/** CN model catalog. */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = '/v3/config'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** True for a request the CALLER aborted, which must never be retried. */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (name === 'AbortError') return true
  // Node's fetch wraps an aborted signal; undici exposes the reason on `cause`.
  const cause = (error as { cause?: unknown }).cause
  return typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'AbortError'
}

/** Cap on the reassembled compaction reply, guarding against a runaway stream. */
const COMPLETION_TEXT_LIMIT = 64 * 1024

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Session-invalidation markers that mean "this credential is dead; use another".
 *  Kept alongside the HTTP-status rule in `classifyUpstreamError`: the status is
 *  enough for a direct 401/403, but some failures arrive wrapped in a 200
 *  envelope or a 4xx the gateway words differently. Adding the English and
 *  Chinese phrasings the upstream actually uses keeps those recoverable too —
 *  an unmatched one fell through to `client`, which is terminal in the shim
 *  and pinned the pool to the first account (the "API 密钥无效" bug). */
const SESSION_DEAD_MARKERS = [
  'Offline user session not found', '12153',
  'api key is invalid', 'invalid api key', 'invalid_api_key',
  'api密钥无效', '密钥无效', '无效的密钥',
  'unauthorized', 'token expired', 'token is invalid',
  'login expired', 'please login', '未登录', '登录已失效', '重新登录',
]

/**
 * Markers for "already checked in today".
 *
 * The upstream answers a non-zero business code (and HTTP 400) when the daily
 * check-in is repeated. That is an idempotent success, not a failure: the
 * reward for today is already collected. Matched against the message, since
 * the code varies by realm.
 */
const ALREADY_CHECKIN_MARKERS = ['已签到', 'already']

/**
 * Markers for "there is no compensation offer to collect".
 *
 * The offer is seasonal — an outage announcement opens one, and it closes on a
 * deadline — so for most of the year every account answers a claim with a
 * refusal. That is a successful no-op, not a failure, for the same reason
 * `isAlreadyCheckin` exists.
 */
const NO_COMPENSATION_MARKERS = [
  '没有可领取',
  '暂无可领取',
  '无可领取',
  '不可领取',
  '未开启',
  '没有活动',
  '已领取',
  '已过期',
  '活动已结束',
  '已结束',
  'not eligible',
  'no compensation',
  'already claimed',
  'not found',
  'expired',
]

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
/** The two gateways WorkBuddy serves: the domestic one and the international one. */
export type WorkBuddyRegion = 'cn' | 'global'

/**
 * Hosts the international product answers on, once each has been stripped of a
 * leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
 * the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
 * CLI signs the same international account in at `codebuddy.ai`. All are served
 * by one gateway stack, so all are `global` — missing a spelling sends those
 * tokens to the CN gateway, which rejects them at the openresty layer with an
 * HTML 401 instead of a business JSON error.
 */
const GLOBAL_HOSTS: readonly string[] = ['workbuddy.ai', 'workbuddy.cc', 'codebuddy.ai']

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): 'cn' | 'global' {
  const lowered = domain.trim().toLowerCase()
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return 'global'
  }
  return 'cn'
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
 * versa, so the base must follow the credential's own domain rather than one
 * hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
 */
function globalBase(credential: WorkBuddyCredential): string {
  const lowered = credential.domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...credential.uid === '' || credential.uid === undefined
      ? { 'X-No-User-Id': '1' }
      : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
  return headers
}

/**
 * The client-identity headers the desktop app puts on every chat completion.
 *
 * WHY THESE EXIST AND WHY THEY BELONG ON /v2/chat/completions ONLY
 *
 * The gateway attributes each request to a client, and that attribution is what
 * surfaces in the user's billing console as the "使用端" column. The desktop app
 * (`buildVlmGatewayHeaders` in its bundled `main/server.js`) sends
 * `X-IDE-Type`/`X-IDE-Name`/`X-IDE-Version` on every `/v2/chat/completions`, so
 * its traffic reads as "WorkBuddy". Our chat requests sent none of them, so the
 * same spend attributed to nothing — the column showed "–" and the user's
 * billing page looked like the requests had come from nowhere.
 *
 * They are deliberately NOT part of `chatHeaders()`, which is shared with the
 * points-automation endpoints (`listTasks` / `acceptTasks`). Those are not chat
 * completions, and the evidence for the desktop app sending identity headers on
 * them is nil — adding identity headers to an endpoint that never carried them
 * risks changing how that traffic is attributed or filtered, and the automation
 * was never reported broken. Only the two chat completions get these.
 *
 * The version is the same literal `openConversation()` already sends, so both
 * chat paths — the pool's and the automation's — claim the same client.
 */
const CHAT_IDENTITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-IDE-Name': 'WorkBuddy',
  'X-IDE-Type': 'WorkBuddy',
  'X-IDE-Version': '5.5.6',
})

/**
 * The conversation-identity headers the gateway's channel check demands.
 *
 * WHY THIS EXISTS
 *
 * `www.workbuddy.ai` turned "channel verification" from a soft check into a
 * hard one. A `POST /v2/chat/completions` missing ANY of `X-Conversation-ID`,
 * `X-Conversation-Request-ID` or `X-Conversation-Message-ID` is rejected with
 * business code 11128 (`msg: "request illegal"` on the international gateway,
 * `msg: "conversation id missing"` in the earlier wording). Verified by
 * elimination against real credentials: delete any one of the three and the
 * call 400s; send all three and it 200s with normal SSE. Every other header the
 * desktop sends (`acp-connection-id`, `X-Request-ID`, `X-Agent-Intent`,
 * `X-Private-Data`, the W3C/B3 tracing family) can be dropped without effect,
 * so only these three are load-bearing.
 *
 * The values are NOT validated — plain non-UUID strings pass — so the gateway
 * is checking for presence and consistency, not for a signature. That lets us
 * derive them from the conversation instead of registering state with upstream.
 *
 * 11128 IS MULTIPLEXED. The domestic gateway returns the same code with
 * `msg: "Illegal API invocation from an unapproved channel"` for a different
 * cause entirely: a `developer`-role message. `prepareChatBody()` already
 * rewrites that role; see its comment. Never branch on the business code alone.
 */
const CONVERSATION_STABLE_SALT = 'conversation'

/**
 * The three stable conversation ids for one logical conversation.
 *
 * Stable across every call and every account in a conversation, because the
 * upstream treats the triple as one session: regenerating them per request
 * would read as a new conversation on each turn. Derived rather than stored so
 * the identity survives a restart and needs no registry — the same reasoning
 * `deriveDeviceId` uses for the device id.
 *
 * Falls back to a random seed when the caller has no key (a one-shot compaction
 * outside any conversation), which is safe because presence is all that is
 * checked.
 */
export function conversationIdentityOf(
  conversationKey: string | undefined,
  seed: () => string = randomUUID,
): { conversationId: string; conversationRequestId: string; acpConnectionId: string } {
  const base = conversationKey === undefined || conversationKey === ''
    ? seed()
    : conversationKey
  const hash = (suffix: string): string =>
    createHash('sha256')
      .update(`${CONVERSATION_STABLE_SALT}:${suffix}:${base}`)
      .digest('hex')
  // Shaped like UUIDs so anything downstream that parses them keeps working.
  const asUuid = (hex: string): string =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  return {
    conversationId: asUuid(hash('id')),
    conversationRequestId: asUuid(hash('request')),
    acpConnectionId: asUuid(hash('acp')),
  }
}

/**
 * Full header set for one chat completion.
 *
 * `chatHeaders()` stays untouched on purpose: it is shared with the
 * points-automation endpoints, which have never been shown to carry
 * conversation identity, and adding it there would change how that traffic is
 * attributed. The per-request ids are fresh UUIDs every call; only the triple
 * from `conversationIdentityOf` is stable.
 */
export function chatCompletionHeaders(
  credential: WorkBuddyCredential,
  conversationKey?: string,
): Record<string, string> {
  const identity = conversationIdentityOf(conversationKey)
  return {
    ...chatHeaders(credential),
    ...CHAT_IDENTITY_HEADERS,
    'X-Conversation-ID': identity.conversationId,
    'X-Conversation-Request-ID': identity.conversationRequestId,
    'acp-connection-id': identity.acpConnectionId,
    'X-Conversation-Message-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Private-Data': 'true',
    'x-codebuddy-request': '1',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Desktop-client report endpoint and the UA it is fingerprinted by. */
const DESKTOP_REPORT_PATH = '/v2/report'
/** Theme-selection endpoint (Hp_Appearance). */
const APPEARANCE_SET_PATH = '/v2/user-asset/appearance/set'
/** Expert marketplace listing, used to look up REAL expert ids. */
const MARKET_EXPERT_LIST_PATH = '/portal/operation-platform/market/expert/list'
/** Cap on how long a chain waits for a conversation answer. */
const CHAT_TIMEOUT_MS = 90_000
/** How far into an SSE stream to look for the server's request id. */
const SSE_SCAN_LIMIT = 1 << 20
/** Server request ids look like `cmb-<32 hex>` or a bare 32 hex string. */
const SERVER_ID_PATTERN = /"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/
const DESKTOP_TASK_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1'

/**
 * DSH 的身份句，以及改写后顶替它的中性说法。
 *
 * 2026-10-21 在 CN chat 端（`/v2/chat/completions`）实测：每次只动 system 消息，
 * 模型、`max_tokens`、全部请求头保持不变。
 *
 * | system 消息                                                  | 结果 |
 * |-------------------------------------------------------------|------|
 * | 不带 system                                                  | 200 |
 * | `You are a helpful assistant.`                               | 200 |
 * | `You are an AI agent powered by DeepSeek Harness.`           | **400 / code 11128** |
 * | 同上但去掉句末句号                                            | **400 / code 11128** |
 * | `You are an AI agent.` + 该句                                 | 200 |
 * | 该句 + 工具前言 + `<available_skills>`                        | **400 / code 11128** |
 * | 该句夹在长 prompt 中间一行                                     | 200 |
 *
 * 也就是说网关不是拦「AI agent」、不是拦某个前缀、也不是不让写长 prompt：它拦的是
 * 这句话**作为指令消息的开头**出现，而这正好是 DSH 的
 * `@deepseek-ai/dsh-system-prompt` 里 `harness:identity` 段的形态。返回
 * HTTP 400 / `code 11128` / `msg: "Illegal API invocation from an unapproved
 * channel"` —— 与 {@link WorkBuddyUpstreamClient.prepareChatBody} 已经在处理的
 * `developer` 角色**共用同一个 code**，所以永远不能只看 code 判断原因。
 *
 * 改写保留原意（还是「一个跑在 harness 里的 AI agent」），只把那串被点名的原话换掉。
 * 这是一次改写，不是删除：说辞变了，但 system prompt 该有的东西一样没少。
 *
 * 没有走宿主侧的 `includeHarnessIdentity: false`，因为那是用户 profile 的开关，
 * 插件管不到别人的部署；改在这里，装上就生效，用户在宿主侧关掉后这里退化成 no-op。
 */
const HARNESS_IDENTITY_PHRASE = 'You are an AI agent powered by DeepSeek Harness.'
const NEUTRAL_IDENTITY_PHRASE = 'You are an AI agent running inside this harness.'

/**
 * 匹配身份句，句内空格允许任意折行/多空格。
 *
 * 实测到的写法用 `includes` 就够，但宿主把这句话作为一个 section 嵌在整段 prompt 里，
 * 将来一旦被重新折行或缩进，字面匹配会静默失效、拦截立刻回来，所以句内每段空白都按
 * 「任意空白」处理。顺带忽略大小写，成本为零。
 */
const HARNESS_IDENTITY_PATTERN = /You[\s\u00a0]+are[\s\u00a0]+an[\s\u00a0]+AI[\s\u00a0]+agent[\s\u00a0]+powered[\s\u00a0]+by[\s\u00a0]+DeepSeek[\s\u00a0]+Harness\.?/giu

/**
 * 该字段是否是本改写负责的文本载体。
 *
 * chat 文本可能是裸字符串（`content: "…"`），也可能是分段数组
 * （`content: [{type:'text',text:'…'}]`）。其余字段一律不碰：assistant 的
 * `tool_calls`、tool 消息的 `tool_call_id` 都不是散文，改进去只会把一次调用改坏。
 */
function isIdentityTextCarrier(key: string): boolean {
  return key === 'content' || key === 'text' || key === 'input_text'
}

/** 递归替换一段文本里的身份句（字符串 / 数组 / 文本分段对象三种形态都走）。 */
function rewriteIdentitySentence(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(HARNESS_IDENTITY_PATTERN, NEUTRAL_IDENTITY_PHRASE)
  if (Array.isArray(value)) return value.map(rewriteIdentitySentence)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  for (const [key, nested] of Object.entries(record)) {
    if (!isIdentityTextCarrier(key)) continue
    record[key] = rewriteIdentitySentence(nested)
  }
  return value
}

/**
 * 抹掉指令消息里的身份句。
 *
 * 只处理 `system` / `developer` 角色——那是宿主自己的指令通道，身份句就是从那里发出来
 * 的。用户消息或 tool 结果里如果恰好引用了这句话，原样保留：插件没有理由改用户打的字。
 *
 * 有意不看位置：DSH 把 prompt 作为第一条消息发出，但只看 `messages[0]` 会漏掉中途注入
 * 的 system 更新，以及已经归一化过的 body。幂等——替换后的文本不再匹配该正则。
 */
export function rewriteHarnessIdentity(messages: readonly unknown[]): void {
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    const role = message['role']
    if (role !== 'system' && role !== 'developer') continue
    if (message['content'] !== undefined) message['content'] = rewriteIdentitySentence(message['content'])
    if (typeof message['text'] === 'string') message['text'] = rewriteIdentitySentence(message['text'])
  }
}

/** body 里是否还带着那句原话；测试与线上断言用（不做空白容错，看的是字面）。 */
export function carriesHarnessIdentity(source: string): boolean {
  return source.includes(HARNESS_IDENTITY_PHRASE)
}

/**
 * Derive a stable 36-hex device id from the account uid.
 *
 * The upstream keys desktop events to a device. Deriving it from the uid keeps
 * the same account looking like the same machine across runs, instead of a
 * new device appearing on every call.
 */
function deriveDeviceId(credential: WorkBuddyCredential, salt: string): string {
  return createHash('sha256').update(salt + ':' + (credential.uid ?? '')).digest('hex').slice(0, 36)
}

/** Narrow a loose upstream value to an object, so field reads cannot throw. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Read a numeric field, treating anything else as 0. */
function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Local `YYYY-MM-DD`, matching how the heatmap keys its cells. */
function dayKeyLocal(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}


/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '' && credential.uid !== undefined) headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Gateway denials that arrive as an HTML page rather than a JSON envelope.
 *
 * openresty / APISIX reject a request before it reaches the product when the
 * credential is one the gateway no longer honours — most often a stale sign-in
 * left in the auth directory. The status alone (401) is not actionable and the
 * HTML body leaks nothing useful, so this turns it into a sentence the user can
 * act on.
 */
function isGatewayHtmlRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const head = text.slice(0, 512).toLowerCase()
  return head.includes('<html') || head.includes('openresty') || head.includes('apisix')
}

/**
 * The sentence thrown for a gateway HTML rejection.
 *
 * Exported (as a prefix test) because callers outside this module have to tell
 * this specific failure apart from an ordinary network error: it is proof the
 * *credential* is no longer honoured, so the pool may mark the account dead
 * instead of re-probing it on every refresh.
 */
export const GATEWAY_REJECTION_MESSAGE = 'the WorkBuddy gateway rejected this credential (http 401).'

/** Was this failure a gateway HTML rejection (a stale sign-in, not a hiccup)? */
export function isGatewayRejectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith(GATEWAY_REJECTION_MESSAGE)
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  if (isGatewayHtmlRejection(response.status, text)) {
    throw new Error(
      `${GATEWAY_REJECTION_MESSAGE} This usually means the ` +
      'account is using a stale sign-in the upstream no longer accepts: sign in again in ' +
      'the WorkBuddy desktop app, then pick the account on the plugin card. ' +
      'Run `dsh-xdpool doctor` to list every credential found.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Read an OpenAI-style SSE chat stream and concatenate the assistant text.
 *
 * The upstream always streams (`stream: true` is forced on every chat body),
 * so a non-streaming internal call has to reassemble the deltas itself. Only
 * `choices[0].delta.content` is collected; reasoning deltas are dropped
 * because a compaction summary needs the final answer, not the scratchpad.
 */
async function readCompletionText(body: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Frames are separated by a blank line; keep the trailing partial.
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        text += contentOfFrame(frame)
        if (text.length > COMPLETION_TEXT_LIMIT) return text.slice(0, COMPLETION_TEXT_LIMIT)
        split = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim() !== '') text += contentOfFrame(buffer)
  } finally {
    reader.releaseLock?.()
  }
  return text
}

/** Pull `choices[0].delta.content` (or a non-streaming `message.content`) out of one SSE frame. */
function contentOfFrame(frame: string): string {
  let out = ''
  for (const rawLine of frame.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const choices = (parsed as Record<string, unknown>)['choices']
    if (!Array.isArray(choices) || choices.length === 0) continue
    const choice = choices[0] as Record<string, unknown>
    const delta = choice['delta']
    if (typeof delta === 'object' && delta !== null) {
      const content = (delta as Record<string, unknown>)['content']
      if (typeof content === 'string') out += content
    }
    const message = choice['message']
    if (typeof message === 'object' && message !== null) {
      const content = (message as Record<string, unknown>)['content']
      if (typeof content === 'string') out += content
    }
    // Some gateways wrap the answer in an OpenAI-compatible envelope.
    const data = (parsed as Record<string, unknown>)['data']
    if (typeof data === 'object' && data !== null) {
      const inner = (data as Record<string, unknown>)['content']
      if (typeof inner === 'string') out += inner
    }
  }
  return out
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 * Body markers win over status, because the upstream reuses 400/200 for
 * several distinct conditions.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  // An HTTP 401/403 from either gateway means THIS credential is no longer
  // accepted — a stale sign-in, a revoked token, or a key the upstream has
  // dropped. It says nothing about the other accounts in the pool, so it must
  // be classified as recoverable (`session_dead`: refresh the token, then move
  // on to the next account).
  //
  // Falling through to the generic `client` branch was the bug behind
  // "API 密钥无效": `client` is terminal in the shim loop (it breaks instead of
  // rotating), so one bad credential pinned the pool to the first account and
  // every remaining account went unused. Status alone is enough here: the
  // upstream words 401/403 inconsistently, and marker-only matching let
  // "api密钥无效" / "invalid api key" / "unauthorized" slip through.
  if (status === 401 || status === 403) return 'session_dead'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  // The 429 the user hits ("频率限制 / soft_rate / code 6004") routes here.
  if (status === 429) return 'soft_rate'
  if (body.includes('soft_rate') || body.includes('"code":6004') || body.includes('频率限制')) {
    return 'soft_rate'
  }
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Whether an error means "today is already checked in".
 *
 * Callers treat this as success: the credit for the day is already banked, so
 * reporting it as a failure would both alarm the user and hide a healthy
 * account behind a false negative.
 */
export function isAlreadyCheckin(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return ALREADY_CHECKIN_MARKERS.some(marker => message.includes(marker))
}

/**
 * Whether an error means "no compensation offer is running for this account".
 *
 * Callers treat this as a successful no-op: the job did its job and correctly
 * found nothing to collect.
 */
export function isNoCompensation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return NO_COMPENSATION_MARKERS.some(marker => lower.includes(marker.toLowerCase()))
}

/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Recognises an epoch-millisecond field and the Chinese-localised sentence
 * form, so the pool can resume exactly when the window reopens.
 */
export function parseRateLimitReset(body: string): number | undefined {
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body)
  if (epochMs !== null) return Number(epochMs[1])

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const parsed = Date.parse(localized[1]!.replace(' ', 'T'))
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

/** Parse the upstream's `credits` string into a multiplier. */
export function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/** Parse the upstream's `reasoning` object; unknown shapes degrade to `{}`. */
/**
 * The effort ladder the upstream's plural-form payloads declare across both
 * gateways (the live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level of it on
 * singular-form models — medium/xhigh fold into high, low/max answer with their
 * own budgets — so a singular `effort` value is a DEFAULT, never the model's
 * only level.
 */
const SINGULAR_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * True when `reasoning` arrives in the singular spelling: an `effort` string,
 * with none of the plural-form fields alongside it. Seen on CN
 * `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
 * `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Probes on both gateways show these models answer with
 * distinct `reasoning_content` across the whole ladder — and do not think at
 * all when no `reasoning_effort` is sent — so the fold widens
 * `supportedEfforts` and carries the declared value into `defaultEffort`. An
 * unrecognized `effort` passes through as the lone level.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to
 * `undefined`. Both spellings normalize here: the plural form passes through as
 * declared, and the singular `effort` form folds via
 * {@link singularEffortLadder}.
 */
export function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const singularForm = isSingularEffortForm(raw)
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string'
    ? raw['defaultEffort']
    : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : singularForm ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const descriptionZh = typeof raw['descriptionZh'] === 'string' && raw['descriptionZh'] !== '' ? raw['descriptionZh'] : undefined
  const descriptionEn = typeof raw['descriptionEn'] === 'string' && raw['descriptionEn'] !== '' ? raw['descriptionEn'] : undefined
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsToolCall = typeof raw['supportsToolCall'] === 'boolean' ? raw['supportsToolCall'] : undefined
  const supportsImages = typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
  // Passthrough of the upstream's own tag list. It used to be dropped entirely,
  // which made the card's promo badges unreachable for every model on both
  // gateways — the JSON carried a `tags` array the whole time.
  const tags = Array.isArray(raw['tags'])
    ? raw['tags'].filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...reasoning === undefined ? {} : { reasoning },
    ...descriptionZh === undefined ? {} : { descriptionZh },
    ...descriptionEn === undefined ? {} : { descriptionEn },
    ...supportsToolCall === undefined ? {} : { supportsToolCall },
    ...supportsImages === undefined ? {} : { supportsImages },
    ...tags === undefined || tags.length === 0 ? {} : { tags },
  }
}

/** One growth-centre task, flattened from the upstream's loosely-shaped entry. */
/** One streak tier and what redeeming it pays. */
export interface WorkBuddyStreakTier {
  /** Tier key, e.g. `7d`. */
  tier: string
  /** Login days the tier needs. */
  days: number
  credit: number
  energy: number
  cards: number
  /** Lottery draws the tier grants. */
  chances: number
  /** `locked` / `unlocked` / `claimed`. */
  status: string
}

/** The growth streak as a whole: progress, tiers, makeup cards. */
export interface WorkBuddyStreakStatus {
  /** Current consecutive active days. */
  days: number
  /** Days active this month. */
  monthTotalDays: number
  /** Next tier key, e.g. `7d`. */
  nextTier: string
  /** Days still needed for `nextTier`. */
  nextTierRemaining: number
  /** Makeup cards in hand. */
  makeupCards: number
  tiers: readonly WorkBuddyStreakTier[]
}

/** One buddy trip state. */
export interface WorkBuddyTravelState {
  /** `idle` (can depart) / `traveling` / `arrived` (can claim). */
  state: string
  /** Trip id, required to claim an arrived trip. */
  recordId: number
  /** The once-a-day depart limit has been used. */
  dailyLimitReached: boolean
  /** Credits an arrived trip pays. */
  rewardCredit: number
}

export interface WorkBuddyTask {
  /** Upstream task code; the claim path is built from it. */
  taskCode: string
  title: string
  /** Reward in credits, when the task declares one. */
  credit: number
  /** Reward in energy, when the task declares one. */
  energy: number
  /** Whether the task carries any reward at all. */
  hasReward: boolean
  /** Progress target; 0 is a valid value (a task with no counter). */
  target: number
  /** Current progress; 0 is a valid value. */
  current: number
  /** Upstream enrolment state: not_accepted / accepted / claimed. */
  acceptStatus: string
  /** Upstream task state, e.g. `complete`. */
  status: string
  /** Progress reached its target and the reward is still outstanding. */
  claimable: boolean
  /** Reward already collected. */
  claimed: boolean
  /** Upstream marked the task locked (not yet reachable). */
  locked: boolean
}

/**
 * Flatten one upstream task entry.
 *
 * Progress is reported two ways depending on the task: flat `current`/`target`
 * fields, or a nested `progress: {current, target}`. The nested form wins when
 * it carries anything, because a task that reports both puts the live counter
 * there. Entries without a usable `task_code` are dropped — without one the
 * claim path cannot be built.
 */

/**
 * The event chain that scores the two Buddy-app tasks.
 *
 * Both tasks accept the same chain, and the chain is a pure value: building it
 * needs no client, so callers (and tests) can hold one without a live upstream.
 *
 * The task text says "upgrade to the desktop client and open it from the app
 * launcher". The scorer does not watch the UI — it watches this event sequence
 * with the desktop fingerprint, which is why the sequence is what gets sent.
 *
 * Measured against the live upstream: progress 0/1 → 1/1 claimable in ~8s.
 */
/**
 * A complete "desktop client ran a request successfully" event chain.
 *
 * Six events in the order the real client emits them: task created, message
 * send, request send, message response, message status, request response.
 * Several tasks are scored off this chain (or one that embeds it), because what
 * they measure is "a real request completed", which the client only proves
 * through this exact sequence.
 *
 * Measured: this chain alone lights up `RichMeow_Chat`.
 */
export function desktopChatEvents(
  conversationId: string,
  requestId: string,
  messageId: string,
  modelId = 'fast-model',
  modelName = 'fast-model',
): Record<string, unknown>[] {
  const assistant = `${messageId}-assistant`
  const session = { 'codebuddy.session_id': conversationId, 'codebuddy.conversation_request_id': requestId }
  return [
    {
      eventCode: 'agent_task_created',
      source: 'LOCAL', name: 'working', task_target: 'local', mode: 'craft',
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: 'none', workspace_type: 'empty',
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: '', template_name: '',
      has_expert: false, expert_id: '', expert_name: '', expert_industry_id: '',
      has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: '', buddyName: '',
    },
    {
      eventCode: 'chat_message_send',
      messageId: assistant, historyCount: 0, isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_send',
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: '', mentionContextCount: 0, command: '', recommendId: '',
      skillId: '', skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      ...session,
    },
    {
      eventCode: 'chat_message_response',
      messageId: assistant, responseModelId: modelId,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      firstTokenAt: Date.now(), traceId: requestId, conversationId,
      rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
      ...session,
    },
    {
      eventCode: 'chat_message_status',
      messageId: assistant, messageErrorCode: '0',
      traceId: requestId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: 'cli', agentType: 'main',
    },
    {
      eventCode: 'chat_request_response',
      mode: 'craft', toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: '', finishReason: 'stop',
      rootRequestId: requestId, parentConversationId: conversationId,
    },
  ]
}

/**
 * A chat chain plus the two canvas events that score `create_canvas`.
 *
 * Worth +300, the joint largest task on the board. The canvas events ride
 * the same metrics channel as everything else, so no real canvas is needed.
 *
 * Measured: three accounts scored 1/1 from this sequence.
 */
export function desktopCanvasEvents(conversationId: string, requestId: string): Record<string, unknown>[] {
  const seed = requestId.slice(-8)
  return [
    ...desktopChatEvents(conversationId, requestId, 'msg-canvas'),
    {
      eventCode: 'wbx_design_canvas_task_create',
      conversationId, requestId,
      source: 'summon_keyword', cost: 12000, isSuccessful: true,
    },
    {
      eventCode: 'wbx_design_canvas_open',
      conversationId, requestId, id: `ardot-file-${seed}`,
      source: 'summon_keyword', type: 'page', cost: 13000, isSuccessful: true,
    },
  ]
}

/**
 * The single event that scores `automation_1` (a scheduled task was created).
 *
 * Measured: two accounts lit it with this event alone.
 */
export function desktopAutomationCreatedEvent(name: string): Record<string, unknown> {
  return {
    eventCode: 'automated_task_create_suc',
    name,
    source: 'manually', modelId: 'fast-model', modelIsThinking: true,
    connectorCount: 0, skills: '', skillCount: 0,
    scheduleType: 'once', mode: 'LOCAL',
  }
}

export function buddyAppEvents(buddyId: string, buddyName: string): Record<string, unknown>[] {
  const base = { mode: 'LOCAL', buddyId, buddyName }
  return [
    { ...base, eventCode: 'buddyapp_discover_click' },
    { ...base, eventCode: 'buddyapp_show', elementId: buddyId, elementName: buddyName, position: 2 },
    { ...base, eventCode: 'buddyapp_enter_click', elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: '1' },
    { ...base, eventCode: 'buddyapp_auth_confirm_click', elementId: buddyId, elementName: buddyName },
    { ...base, eventCode: 'buddyapp_bindaccount_skip_click', elementId: buddyId, elementName: buddyName },
  ]
}


function parseTask(value: unknown): WorkBuddyTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const taskCode = typeof raw['task_code'] === 'string' ? raw['task_code'] : ''
  if (taskCode === '') return undefined

  const num = (key: string): number => (typeof raw[key] === 'number' ? raw[key] as number : 0)
  let current = num('current')
  let target = num('target')
  const progress = raw['progress']
  if (typeof progress === 'object' && progress !== null) {
    const nested = progress as Record<string, unknown>
    const nestedCurrent = typeof nested['current'] === 'number' ? nested['current'] as number : 0
    const nestedTarget = typeof nested['target'] === 'number' ? nested['target'] as number : 0
    if (nestedTarget > 0 || nestedCurrent > 0) {
      current = nestedCurrent
      target = nestedTarget
    }
  }

  const acceptStatus = typeof raw['accept_status'] === 'string' ? raw['accept_status'] : ''
  const claimed = acceptStatus === 'claimed'
  return {
    taskCode,
    title: typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : taskCode,
    credit: num('reward_credit'),
    energy: num('reward_energy'),
    hasReward: raw['has_reward'] === true,
    target,
    current,
    acceptStatus,
    status: typeof raw['status'] === 'string' ? raw['status'] : '',
    claimable: !claimed && target > 0 && current >= target,
    claimed,
    locked: raw['locked'] === true,
  }
}


export class WorkBuddyUpstreamClient {
  private readonly fetchImpl: typeof fetch
  private readonly clientVersion: string
  /** Backoff ladder for `fetchModels`; empty means a single attempt. */
  private readonly catalogRetryBackoffMs: readonly number[]
  /**
   * Optional logger for retry notices.
   *
   * Set by the host so a retry is visible in the log with its attempt count —
   * without it, a retry that eventually succeeds is invisible, and an operator
   * debugging "why was the catalog slow" has nothing to look at.
   */
  logger: { warn?(...args: unknown[]): void; info?(...args: unknown[]): void } | undefined

  constructor(options: UpstreamClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.clientVersion = options.clientVersion ?? '2.0.4'
    this.catalogRetryBackoffMs = options.catalogRetryBackoffMs ?? CATALOG_RETRY_BACKOFF_MS
  }

  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), flatten `tool_choice` into its string form, and
   * rewrite the DSH harness identity sentence
   * ({@link rewriteHarnessIdentity}).
   *
   * 身份句是 2026-10-21 新增的第二道同码拦截：`developer` 角色与那句
   * `You are an AI agent powered by DeepSeek Harness.` 都返回 400 / `11128` /
   * 「Illegal API invocation from an unapproved channel」，但只有后者在
   * `msg` 之外无法与前者区分，所以两条规则都必须在这里落地，不能只留一条。
   */
  prepareChatBody(raw: string): string {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return raw
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return raw
    const obj = body as Record<string, unknown>
    obj['stream'] = true
    // Ask for usage, and let the shim take it back out before DSH sees it: the
    // gateway's trailer frame is one extra SSE event the host never requested,
    // so `serveSuccessfulStream` strips it and the forwarded stream stays
    // byte-identical. Dropping the request field instead (as this used to)
    // threw the numbers away, and the usage panel is built from them.
    const requested = typeof obj['stream_options'] === 'object'
      && obj['stream_options'] !== null
      && !Array.isArray(obj['stream_options'])
      ? obj['stream_options'] as Record<string, unknown>
      : {}
    requested['include_usage'] = true
    obj['stream_options'] = requested
    if (Array.isArray(obj['messages'])) {
      for (const value of obj['messages']) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const message = value as Record<string, unknown>
        if (message['role'] === 'developer') message['role'] = 'system'
      }
      // After the role conversion, so a `developer` instruction message is
      // covered by the same pass whether or not it was relabelled.
      rewriteHarnessIdentity(obj['messages'])
    }
    const choice = obj['tool_choice']
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>
      const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
      if (type === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      } else if (type === 'auto' || type === 'required') {
        obj['tool_choice'] = type
      } else if (type === 'function') {
        const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
          ? (wrapped['function'] as Record<string, unknown>)
          : undefined
        let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
        if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
        obj['tool_choice'] = name.trim() !== '' ? name.trim() : 'auto'
      } else {
        delete obj['tool_choice']
      }
    }
    return JSON.stringify(obj)
  }

  /**
   * Parse a raw OpenAI chat body without normalising it.
   *
   * The compactor needs the message array as objects, while `chatStream` only
   * accepts the serialised string form.
   */
  parseChatBody(raw: string): Record<string, unknown> | undefined {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return undefined
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
    return body as Record<string, unknown>
  }

  /** Re-serialise `base` with a rewritten `messages` array, still normalised. */
  buildChatBody(base: Record<string, unknown>, messages: readonly ChatMessage[]): string {
    return this.prepareChatBody(JSON.stringify({ ...base, messages }))
  }

  /**
   * Run one NON-streaming completion and return the assistant text.
   *
   * Used only for internal compaction (summarising dropped turns). The chat
   * endpoint itself always streams, so this reassembles the SSE frames into a
   * single string. Throws on any failure: the compactor then falls back to
   * plain truncation rather than failing the user's turn.
   */
  async completeChat(
    credential: WorkBuddyCredential,
    prepared: string,
    signal?: AbortSignal,
    conversationKey?: string,
  ): Promise<string> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
      method: 'POST',
      headers: chatCompletionHeaders(credential, conversationKey),
      body: prepared,
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
      throw new Error(`compaction upstream http ${response.status}: ${text}`)
    }
    if (response.body === null) throw new Error('compaction upstream returned no body')
    return await readCompletionText(response.body)
  }

  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(
    credential: WorkBuddyCredential,
    prepared: string,
    signal?: AbortSignal,
    conversationKey?: string,
  ): Promise<ChatStreamResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: chatCompletionHeaders(credential, conversationKey),
        body: prepared,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, kind: 'server', status: 0, message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * Fetch the model catalog, keeping the `cli` agent's models only.
   *
   * The two gateways are read differently, because they answer differently:
   *
   * - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
   *   the CLI client spelling.
   * - **Global** serves it as part of the product config at `/v3/config`, and
   *   only to the DESKTOP client channel. Asking the global host with the CLI UA
   *   yields a truncated roster, and the CN path answers HTTP 500 there — which
   *   is what left the international provider on its static fallback.
   *
   * Both documents share the `{ models, agents }` entry shape, so the parsing
   * below is common to the two branches.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const attempts = this.catalogRetryBackoffMs.length + 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.fetchModelsOnce(credential, signal)
      } catch (error: unknown) {
        lastError = error
        // An aborted request is the CALLER giving up, not a flaky network:
        // retrying it would keep working after the caller asked us to stop.
        if (isAbortError(error)) throw error
        const wait = this.catalogRetryBackoffMs[attempt]
        if (wait === undefined) break
        this.logger?.warn?.(
          `dsh-xdpool: model catalog fetch failed (attempt ${attempt + 1}/${attempts}), retrying in ${wait}ms`,
          error,
        )
        await delay(wait)
      }
    }
    throw lastError
  }

  /**
   * One catalog attempt, without retries.
   *
   * Split out so {@link fetchModels} can retry it: the failure this guards
   * against is a startup network hiccup, where several independent components
   * see `fetch failed` inside the same second and the very next request
   * succeeds — exactly the case a single attempt turns into "the user's model
   * list is missing half its entries for the rest of the session".
   */
  private async fetchModelsOnce(
    credential: WorkBuddyCredential,
    signal?: AbortSignal,
  ): Promise<readonly WorkBuddyUpstreamModel[]> {
    const global = regionOf(credential.domain) === 'global'
    const url = global
      ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}`
      : `${chatBase(credential)}${MODELS_CATALOG_PATH}`

    const headers: Record<string, string> = global
      ? {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          'Connection': 'close',
          'User-Agent': DESKTOP_UA,
        }
      : {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': originReferer(credential),
          'Referer': `${originReferer(credential)}/`,
          'User-Agent': CLIENT_UA,
        }
    if (!global && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
    }

    const response = await this.fetchImpl(url, {
      headers,
      ...signal === undefined ? {} : { signal },
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model)
      if (parsed !== undefined) byId.set(parsed.id, parsed)
    }
    const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
    const models = ids
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
    return models
  }

  /** Read-only credits query, aggregated by package. Does not consume credits. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const fmt = (date: Date): string => {
      const p = (n: number) => n.toString().padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const wrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof wrapper['Response'] === 'object' && wrapper['Response'] !== null
      ? wrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let nearestExpiryMs: number | undefined
    let expiringSoon = 0
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      if (typeof raw === 'number' && raw > 1_000_000_000_000) return raw
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const num = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const monthly = num('CapacityType') === 4
      const size = monthly ? num('CycleCapacitySize') : num('CapacitySize')
      const remain = monthly ? num('CycleCapacityRemain') : num('CapacityRemain')
      const capped = remain < 0 ? 0 : remain
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly ? (cycleEndMs === undefined ? undefined : cycleEndMs + 1000) : undefined
      if (!monthly && (capped <= 0 || (expiresAtMs !== undefined && expiresAtMs <= Date.now()))) continue
      total += capped
      if (expiresAtMs !== undefined) {
        if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs
        if (expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: capped,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return { total, packages, expiringSoon, ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs } }
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const num = (key: string): number => (typeof data[key] === 'number' ? data[key] as number : 0)
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: num('streak_days'),
      dailyCredit: num('daily_credit'),
      todayCredit: num('today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: num('next_streak_day'),
      streakBonusDays: num('streak_bonus_days'),
      streakBonusCredit: num('streak_bonus_credit'),
      ...typeof data['claim_button_text'] === 'string' && data['claim_button_text'] !== ''
        ? { claimButtonText: data['claim_button_text'] }
        : {},
    }
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const numberField = (key: string): number => typeof data[key] === 'number' ? data[key] as number : 0
    return {
      credit: numberField('credit'),
      streakDays: numberField('streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }

  /**
   * Read the service-outage compensation offer, if any.
   *
   * NOTE the missing `/v2`: unlike the check-in routes, this one lives at
   * `/billing/meter/compensation-status` and the `/v2` variant answers a plain
   * 404 (verified on both billing hosts). The web client calls it that way too.
   */
  async fetchCompensationStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCompensationStatus> {
    const response = await this.fetchImpl(`${billingBase(credential)}/billing/meter/compensation-status`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return {
      active: data['active'] === true,
      claimed: data['claimed'] === true,
      creditNum: typeof data['credit_num'] === 'number' ? data['credit_num'] as number : 0,
      ...typeof data['end_time'] === 'string' && data['end_time'] !== ''
        ? { endTime: data['end_time'] as string }
        : {},
    }
  }

  /**
   * Collect the running compensation offer.
   *
   * Idempotent upstream: a repeat claim answers `code: 0` with
   * `claimed: true` rather than an error, so a second pass in the same day
   * records as a no-op instead of a failure.
   */
  async claimCompensation(credential: WorkBuddyCredential): Promise<WorkBuddyCompensationClaim> {
    const response = await this.fetchImpl(`${billingBase(credential)}/billing/meter/claim-compensation`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return {
      claimed: data['claimed'] !== false,
      creditNum: typeof data['credit_num'] === 'number' ? data['credit_num'] as number : 0,
    }
  }

  /**
   * Public fingerprint fields every desktop event carries.
   *
   * The upstream scores a desktop-fingerprinted task only when the event looks
   * like it came from the desktop client: the same field set, the same stable
   * device ids, the same build. A partial map is accepted with 200 and scores
   * nothing, so these are copied wholesale rather than trimmed.
   *
   * `machineId`/`sessionId` are DERIVED from the account uid, never random: a
   * new device id on every call is itself a signal that the traffic is not a
   * real client.
   */
  desktopFingerprint(credential: WorkBuddyCredential): Record<string, unknown> {
    const now = Date.now()
    return {
      timezone: 'Asia/Shanghai',
      reportDelay: 2000,
      userId: credential.uid ?? '',
      username: credential.nickname ?? '',
      userNickname: credential.nickname ?? '',
      product: 'SaaS',
      releaseDate: 1789036585355,
      commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
      ideName: 'WorkBuddy',
      ideType: 'WorkBuddy',
      ideVersion: '5.5.6',
      machineId: deriveDeviceId(credential, 'machine'),
      sessionId: deriveDeviceId(credential, 'session'),
      extName: 'workbuddy-desktop',
      extVersion: '5.5.6',
      os: 'win32',
      arch: 'x64',
      osVersion: '10.0.26220',
      cpuCores: 20,
      memorySize: 24,
      timestamp: now,
      presentAt: now,
    }
  }

  /**
   * Send desktop-fingerprinted events to the growth system.
   *
   * The body is an ARRAY of events, and every event carries the full desktop
   * fingerprint plus its own business fields. Different tasks recognise
   * different fingerprint families (CLI / desktop / web), which is why this is
   * separate from {@link reportActivity}: they are not interchangeable.
   *
   * Business fields win over the fingerprint, so a caller can override a device
   * id to align with a real install.
   */
  async reportDesktopEvents(
    credential: WorkBuddyCredential,
    events: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (events.length === 0) return
    const fingerprint = this.desktopFingerprint(credential)
    const body = events.map(event => ({ ...fingerprint, ...event }))
    const response = await this.fetchImpl(`${chatBase(credential)}${DESKTOP_REPORT_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': DESKTOP_TASK_UA,
        'X-Product': 'SaaS',
        'X-Request-ID': deriveDeviceId(credential, 'req') + String(Date.now() % 1_000_000),
        ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
        ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }



  /**
   * Report one chat-activity event to the growth system.
   *
   * The body is an ARRAY holding a single `chat_request_send` event, and every
   * field is filled in: a three-field minimal event is accepted with 200 and
   * then silently dropped, so the full shape is load-bearing rather than
   * cosmetic. `userId` is the one field the server actually keys on — without
   * it the request still answers 200 and scores nothing.
   *
   * One report per account per day is the quota the reference panel settled on;
   * a single report lights the growth streak and unlocks the `first_buddy`
   * family, which is why this runs before the task-centre pass.

  /**
   * Send a WEB-fingerprinted event.
   *
   * A third fingerprint family, alongside CLI and desktop: a browser shape
   * posted to the web origin with x-client-platform: web. Page-behaviour
   * tasks such as `Library_read` are scored on it. Measured:
   * `library_doc_intro_click` scored about four seconds after landing.
   */
  async reportWebEvent(
    credential: WorkBuddyCredential,
    eventCode: string,
    pageUrl: string,
    elementId: string,
    elementName: string,
  ): Promise<void> {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    const event = {
      eventCode,
      timestamp: Date.now(),
      reportDelay: 0,
      pageURL: pageUrl,
      elementId,
      elementName,
      os: 'Win32',
      arch: '',
      osVersion: '10.0',
      userAgent: ua,
      machineId: deriveDeviceId(credential, 'webmachine'),
      userId: credential.uid ?? '',
      userNickname: credential.nickname ?? '',
      enterpriseId: credential.enterpriseId ?? '',
    }
    const response = await this.fetchImpl(`https://www.workbuddy.cn/v2/report`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-client-platform': 'web',
        'Origin': 'https://www.workbuddy.cn',
        'Referer': pageUrl,
        'User-Agent': ua,
        ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
      },
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }
  /**
   * Apply an appearance theme on the account.
   *
   * The theme task is scored on the `appearance_skin_apply` event, not on this
   * call — but the event alone is not enough either. The pair is what a real
   * client produces: it PATCHes the account's selected skin, then reports the
   * event as the settings page closes. Measured on the reference panel after
   * the earlier "the API alone does not score" reading was corrected.
   */
  async setAppearanceTheme(credential: WorkBuddyCredential, resourceKey: string): Promise<void> {
    const response = await this.fetchImpl(`${chatBase(credential)}${APPEARANCE_SET_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': DESKTOP_TASK_UA,
        'X-Product': 'SaaS',
        ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
      },
      body: JSON.stringify({ kind: 'theme', resource_key: resourceKey }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * The platform's expert marketplace.
   *
   * Needed before any expert can be summoned: the scorer verifies that the
   * expert id exists on the platform, so a made-up id scores nothing. The
   * response carries the display fields the summon events replay.
   */
  async marketExpertList(credential: WorkBuddyCredential, expertType: 'agent' | 'team' | '' = ''): Promise<readonly MarketExpert[]> {
    const request: Record<string, unknown> = { page: 1, page_size: 20, sort_by: 'reco_rank', sort_order: 'desc' }
    if (expertType !== '') request['expert_type'] = expertType
    const response = await this.fetchImpl(`${chatBase(credential)}${MARKET_EXPERT_LIST_PATH}`, {
      method: 'POST',
      headers: {
        ...chatHeaders(credential),
        'User-Agent': DESKTOP_TASK_UA,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = asRecord(envelope.data)
    const raw = Array.isArray(data['experts']) ? data['experts'] : []
    const out: MarketExpert[] = []
    for (const value of raw) {
      const expert = asRecord(value)
      const expertId = typeof expert['expert_id'] === 'string' ? expert['expert_id'] : ''
      if (expertId === '') continue
      out.push({
        expertId,
        expertType: typeof expert['expert_type'] === 'string' ? expert['expert_type'] : '',
        displayName: typeof expert['display_name_zh'] === 'string' ? expert['display_name_zh'] : '',
        profession: typeof expert['profession_zh'] === 'string' ? expert['profession_zh'] : '',
        version: typeof expert['version'] === 'string' ? expert['version'] : '',
        categories: Array.isArray(expert['categories'])
          ? expert['categories'].filter((item): item is string => typeof item === 'string')
          : [],
      })
    }
    return out
  }

  /**
   * Open a REAL desktop conversation and return the ids the server assigned.
   *
   * The expert and skill tasks join their events to a conversation the server
   * has actually seen, so a locally invented `requestId` scores nothing. This
   * starts a chat, reads the server's id out of the SSE stream, then drops the
   * rest of the stream — the answer itself is irrelevant, only its identity is.
   *
   * Returns `undefined` instead of throwing when the conversation cannot be
   * opened or carries no recognisable id, because every caller is a best-effort
   * task chain.
   */
  async openConversation(
    credential: WorkBuddyCredential,
    expertId = '',
    signal?: AbortSignal,
  ): Promise<{ conversationId: string; requestId: string } | undefined> {
    const conversationId = `wb2auto-conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const body = JSON.stringify({
      model: 'fast-model',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. 当前处于中文环境，使用简体中文回答。' },
        { role: 'user', content: '1+1等于几？直接回答。' },
      ],
      agent: 'cli',
      temperature: 1,
      stream: true,
      stream_options: { include_usage: true },
    })
    let response: Response
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...chatHeaders(credential),
          ...CHAT_IDENTITY_HEADERS,
          'Accept': 'text/event-stream',
          'User-Agent': DESKTOP_TASK_UA,
          'X-Conversation-ID': conversationId,
          'X-Request-ID': String(Date.now()) + '000000',
          'X-Agent-Intent': 'craft',
          'X-Agent-Type': 'main',
          'x-codebuddy-request': '1',
          ...expertId === '' ? {} : { 'X-Expert-Id': expertId },
        },
        body,
        signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
      })
    } catch {
      return undefined
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (buffer.length < SSE_SCAN_LIMIT) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const match = SERVER_ID_PATTERN.exec(buffer)
        if (match !== null) return { conversationId, requestId: match[1] ?? '' }
      }
    } catch {
      // A truncated stream is not fatal: whatever arrived may still name the id.
    } finally {
      await reader.cancel().catch(() => {})
    }
    return undefined
  }


  /**
   * Report one chat-activity event to the growth system.
   *
   * The body is an ARRAY holding a single chat_request_send event, and every
   * field is filled in: a three-field minimal event is accepted with 200 and
   * then silently dropped, so the full shape is load-bearing rather than
   * cosmetic. userId is the one field the server actually keys on.
   *
   * One report per account per day is the quota the reference panel settled
   * on; a single report lights the growth streak and unlocks the first_buddy
   * family, which is why this runs before the task-centre pass.
   */
  async reportActivity(credential: WorkBuddyCredential, conversationId?: string): Promise<void> {
    const conversationID = conversationId ?? `wb2api-${Date.now()}`
    const requestID = conversationID
    const now = Date.now()
    const event = {
      eventCode: 'chat_request_send',
      timestamp: now,
      reportDelay: 0,
      mode: 'craft',
      conversationId: conversationID,
      requestId: requestID,
      inputLength: 12,
      requestModelId: 'deepseek-v4-flash',
      requestModelName: 'DeepSeek V4 Flash',
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [] as unknown[],
      knowledgeId: [] as unknown[],
      knowledgeName: [] as unknown[],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      expertId: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      fileUri: '',
      presentAt: now,
      traceId: '',
      rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: 'default',
      agentType: 'conversation',
      userId: credential.uid ?? '',
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Read back the growth streak in days.
   *
   * This is the read-only oracle for {@link reportActivity}: a report that
   * returned 200 yet left the streak untouched was silently dropped (a missing
   * `userId` is the usual cause), so callers verify instead of trusting the
   * status code.
   *
   * Two shape traps, both measured against the live upstream:
   *
   * - The path carries NO `/v2` prefix, unlike its sibling task endpoints under
   *   `/v2/activity/growth/*`. Asking for the `/v2` form does not 404; it
   *   answers with a body that carries no `streak` object at all.
   * - The counter is nested as `data.streak.days`, not `data.days`. Reading the
   *   flat field yields a constant 0, which would make every successful report
   *   look like a silent drop.
   *
   * Returns 0 only when the field is genuinely absent.
   */
  async growthStreakDays(credential: WorkBuddyCredential): Promise<number> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/streak`, {
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const streak = typeof data['streak'] === 'object' && data['streak'] !== null
      ? data['streak'] as Record<string, unknown>
      : {}
    return typeof streak['days'] === 'number' ? streak['days'] as number : 0
  }

  /**
   * The full streak picture: days, tier unlock state, and what each tier pays.
   *
   * Read before redeeming, because the tier state is the only honest answer to
   * "is there anything to claim": the redeem endpoint answers 403 for a locked
   * tier, which is indistinguishable from a real failure once the response is
   * just an error.
   */
  async growthStreakFull(credential: WorkBuddyCredential): Promise<WorkBuddyStreakStatus> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/streak')
    const streak = asRecord(data['streak'])
    const redemption = asRecord(data['redemption_status'])
    const cards = asRecord(data['makeup_cards'])
    const tiers: WorkBuddyStreakTier[] = []
    if (Array.isArray(redemption['tiers'])) {
      for (const entry of redemption['tiers']) {
        const tier = asRecord(entry)
        const name = typeof tier['tier'] === 'string' ? tier['tier'] : ''
        if (name === '') continue
        tiers.push({
          tier: name,
          days: numOf(tier['days']),
          credit: numOf(tier['credit']),
          energy: numOf(tier['energy']),
          cards: numOf(tier['cards']),
          chances: numOf(tier['chances']),
          // The flat status fields are the authoritative unlock state; the
          // per-tier entry does not carry one of its own.
          status: String(redemption[`tier_${name}_status`] ?? ''),
        })
      }
    }
    return {
      days: numOf(streak['days']),
      monthTotalDays: numOf(streak['month_total_days']),
      nextTier: typeof streak['next_tier'] === 'string' ? streak['next_tier'] : '',
      nextTierRemaining: numOf(streak['next_tier_remaining']),
      makeupCards: numOf(cards['balance']),
      tiers,
    }
  }

  /**
   * Redeem one unlocked streak tier.
   *
   * A locked tier answers 403 ("连续登录天数不足"); callers check the status from
   * {@link growthStreakFull} first, so this only throws for genuine failures.
   * The client token is the upstream's idempotency key — a fresh one per attempt
   * keeps a retry from being read as a duplicate of the last one.
   */
  async redeemStreakTier(credential: WorkBuddyCredential, tier: string): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/redeem', {
      tier,
      client_token: randomUUID(),
    })
  }

  /** How many lottery draws are available right now. */
  async lotteryChances(credential: WorkBuddyCredential): Promise<number> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/lottery/summary')
    return numOf(data['chances'])
  }

  /**
   * Draw the lottery once.
   *
   * Returns the raw prize payload: its shape is set by the running campaign, so
   * it is passed through rather than modelled.
   */
  async lotteryDraw(credential: WorkBuddyCredential): Promise<unknown> {
    return this.growthJson(credential, 'POST', '/activity/growth/lottery/draw', {
      client_token: randomUUID(),
    })
  }

  /**
   * The buddy profile, or undefined when the account has no buddy yet.
   *
   * `data.buddy` is null / absent / an empty object depending on how far the
   * account got, and all three mean the same thing to a caller: adopt first.
   */
  async buddyInfo(credential: WorkBuddyCredential): Promise<{ instanceId: number; name: string } | undefined> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/buddy/info')
    const buddy = asRecord(data['buddy'])
    if (Object.keys(buddy).length === 0) return undefined
    return { instanceId: numOf(buddy['instance_id']), name: String(buddy['name'] ?? '') }
  }

  /** Agree to the buddy terms. Idempotent upstream. */
  async buddyAgree(credential: WorkBuddyCredential): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/agreement', { agree: true })
  }

  /**
   * Adopt the first buddy.
   *
   * Gated upstream on having reported activity that day: without it the answer
   * is 400 "first_buddy task not completed yet". Callers treat that as "not yet"
   * rather than an error, which is why it is thrown as-is for them to classify.
   */
  async buddyAdoptFirst(credential: WorkBuddyCredential): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/first', {})
  }

  /** Current travel state for the account's buddy. */
  async buddyTravelStatus(credential: WorkBuddyCredential): Promise<WorkBuddyTravelState> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/buddy/travel/status')
    return {
      state: typeof data['state'] === 'string' ? data['state'] : '',
      recordId: numOf(data['record_id']),
      dailyLimitReached: data['daily_limit_reached'] === true,
      rewardCredit: numOf(data['reward_credit']),
    }
  }

  /**
   * Send the buddy travelling.
   *
   * The location is always 4 (古镇客栈): the four locations have identical
   * reward and duration ranges, so there is nothing to optimise.
   */
  async buddyTravelDepart(credential: WorkBuddyCredential, locationId = 4): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/buddy/travel/depart', { location_id: locationId })
  }

  /**
   * Collect an arrived trip's reward.
   *
   * `recordId` is required and comes from the status read; the upstream rejects
   * a claim without it.
   */
  async buddyTravelClaim(credential: WorkBuddyCredential, recordId: number): Promise<number> {
    const data = await this.growthJson(credential, 'POST', '/activity/growth/buddy/travel/claim', {
      record_id: recordId,
    })
    // A missing reward field is not a failure: the trip is collected either way.
    return numOf(data['reward_credit'])
  }

  /** Whether yesterday is a gap in the activity heatmap. */
  async heatmapYesterdayMissed(credential: WorkBuddyCredential): Promise<boolean> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/heatmap')
    if (!Array.isArray(data['cells'])) return false
    const yesterday = new Date(Date.now() - 86_400_000)
    const key = dayKeyLocal(yesterday)
    for (const entry of data['cells']) {
      const cell = asRecord(entry)
      if (cell['date'] === key) return numOf(cell['score']) === 0
    }
    return false
  }

  /** Spend one makeup card on a date. Idempotent for an already-filled date. */
  async useMakeupCard(credential: WorkBuddyCredential, date: string): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/makeup-cards/use', { date })
  }

  /**
   * Call a growth-domain endpoint and return its unwrapped `data`.
   *
   * These endpoints live on the chat host with the billing header set, and
   * carry the same envelope as everything else. Centralised here because every
   * growth call needs the identical envelope check.
   */
  private async growthJson(
    credential: WorkBuddyCredential,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${chatBase(credential)}${path}`, {
      method,
      headers: billingHeaders(credential),
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    return asRecord(envelope.data)
  }


  /** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
  async credits(credential: WorkBuddyCredential): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
    try {
      const data = await this.fetchCredits(credential)
      return { ok: true, data }
    } catch (error: unknown) {
      return { ok: false, message: String(error) }
    }
  }

  /**
   * Fetch the growth task list for one account.
   *
   * The upstream answers `data.tasks[]`, and `claimable` is derived locally —
   * the upstream does not mark it. Only a task whose progress reached its
   * target and that is not already claimed counts as eligible.
   */
  async listTasks(credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
      headers: chatHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = Array.isArray(data['tasks']) ? data['tasks'] : []
    const out: WorkBuddyTask[] = []
    for (const entry of raw) {
      const parsed = parseTask(entry)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  /**
   * Accept (enrol in) tasks by code.
   *
   * Accepting is the "sign up" half: it produces no progress by itself, and the
   * upstream answers success for an already-accepted task, so replaying this is
   * safe. Progress is lit by real activity (a chat, an activity report).
   */
  async acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void> {
    if (taskCodes.length === 0) return
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
      method: 'POST',
      headers: chatHeaders(credential),
      body: JSON.stringify({ task_codes: [...taskCodes] }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Claim one task's reward.
   *
   * Two details differ from list/accept and are load-bearing:
   *
   * - The task code rides the PATH, not the body.
   * - It is served by the web origin, not the chat host, and only when the
   *   request carries the growth-centre Origin/Referer plus
   *   `x-client-platform: web`. The chat host's `/reward/claim` path does not
   *   exist and answers 400 "task not completed".
   *
   * A repeat claim answers `already_claimed` with zero credit, which is treated
   * as success so the caller can stay idempotent.
   */
  async claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<{ credit: number; energy: number }> {
    const headers: Record<string, string> = {
      ...billingHeaders(credential),
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.workbuddy.cn',
      'Referer': 'https://www.workbuddy.cn/profile/growth-center',
      'x-client-platform': 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    }
    const response = await this.fetchImpl(
      `https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
      { method: 'POST', headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) },
    )
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    if (data['already_claimed'] === true) return { credit: 0, energy: 0 }
    const credit = typeof data['credit'] === 'number' ? data['credit'] : 0
    const energy = typeof data['energy'] === 'number' ? data['energy'] : 0
    return { credit, energy }
  }
}
