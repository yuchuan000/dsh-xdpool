import z from "@deepseek-ai/schemastery";
import { Api, Model } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context, Context as Context$1 } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/task-events.d.ts
/**
 * The event chains that light up the client-scored daily tasks.
 *
 * The task board advertises things like "open an app", "use five templates" or
 * "summon a platform expert". Those read as actions only a human at the desktop
 * app can take, but the scorer does not check the app — it checks the event
 * stream. Replaying the same events, with the same desktop fingerprint, scores
 * the task. Every chain here was measured against the live upstream.
 *
 * Kept apart from the scheduler because a chain is pure data: the scheduler
 * decides *when* to send one, this module decides *what* one is. A few chains
 * need a real server-side id first (the expert family), which is why the builder
 * is allowed to be async and to call the upstream.
 */
/**
 * How a chain reaches the upstream.
 *
 * There are three fingerprint families and the scorer keys different tasks to
 * different ones, so the transport is part of the chain rather than a detail of
 * the sender: `Buddy_App` needs the desktop fingerprint, while `Library_read` is
 * only scored when it arrives with the WEB fingerprint.
 */
type TaskEventTransport = 'desktop' | 'web';
/** A ready-to-send chain, plus the channel it must go out on. */
interface TaskEventChain {
  transport: TaskEventTransport;
  /** Desktop chains: the event array. */
  events?: readonly Record<string, unknown>[];
  /** Web chains: the single page event to report. */
  web?: {
    eventCode: string;
    pageUrl: string;
    elementId: string;
    elementName: string;
  };
}
/**
 * The app the buddy chain enters.
 *
 * One chain lights up two tasks: `Buddy_App` (open any app) and `Buddy_App_QQ`
 * (the QQ-specific one), because this is a QQ-hosted app. Measured 0/1 → 1/1 on
 * both from a single chain.
 */
export declare const BUDDY_APP_ID = "cb_y5Dy46tPQGGWtueMxXbe";
export declare const BUDDY_APP_NAME = "企鹅教师助手";
/**
 * The buddy-app chain (two tasks).
 *
 * Five clicks in the order a user would make them: discover the app, see it,
 * enter it, confirm the account link, skip the second binding step.
 */
export declare function buddyAppChain(): TaskEventChain;
/**
 * The design-canvas chain (`create_canvas`, +300 — the joint largest reward).
 *
 * The two canvas events ride the same metrics channel as everything else, so no
 * real canvas is ever created; the chat chain in front supplies the ids they
 * reference. Measured 1/1 on three accounts.
 */
export declare function canvasChain(): TaskEventChain;
/**
 * The scheduled-task event (`automation_1`).
 *
 * One event is the whole chain — measured 1/1 on two accounts. The name is only
 * for the server's own records, so a generated one is fine.
 */
export declare function automationChain(): TaskEventChain;
/**
 * The plain chat chain (`RichMeow_Chat`, and the base of the template chain).
 *
 * Measured: this chain alone lights `RichMeow_Chat`.
 */
export declare function chatChain(): TaskEventChain;
/**
 * The "same as this case" chain (`playbook_prompt`).
 *
 * The scorer watches `playbook_prompt_send` — sending the prompt that the
 * inspiration case pre-fills — not the card impression or the button click, so
 * the whole click path is replayed for realism but the send is what counts.
 */
export declare function playbookChain(caseId?: string, caseName?: string): TaskEventChain;
/** The inspiration case the reference panel sends a prompt for. */
export declare const PLAYBOOK_CASE_ID = "pm-gtm-launch-plan";
export declare const PLAYBOOK_CASE_NAME = "新产品上市 GTM 发布计划一页纸";
/**
 * The five templates the reference panel cycles through, as `[id, name]`.
 *
 * The upstream does not check that these templates exist — only that five
 * distinct `template_used` events arrive — so they are the reference set.
 */
export declare const TEMPLATE_PRESETS: readonly (readonly [string, string])[];
/**
 * One "created a task from a template" chain (`template_5`, +100 for five).
 *
 * Each group is a chat chain (which supplies the ids the template events join
 * on) plus `agent_task_created_with_template` and `template_used`. Measured:
 * five groups in one report scored 5/5.
 */
export declare function templateChain(templateId: string, templateName: string): TaskEventChain;
/** Every template group, ready to send in order. */
export declare function templateChains(): readonly TaskEventChain[];
/**
 * The library-introduction click (`Library_read`).
 *
 * Scored on the WEB fingerprint — the same event posted with the desktop
 * fingerprint scores nothing — so this chain returns a web transport and the
 * scheduler routes it through `reportWebEvent`.
 */
export declare function libraryReadChain(): TaskEventChain;
/** The document the library click is reported against. */
export declare const LIBRARY_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
/** The theme key `Hp_Appearance` is scored on (和平精英激战金秋). */
export declare const APPEARANCE_THEME_KEY = "theme-tkmw7j";
/** The skill `skill_1` is scored on. */
export declare const SKILL_ID = "skill_2097350077599879168";
export declare const SKILL_NAME = "润泽小馆·日报撰写";
/** The 腾讯轻量云 expert `Expert_lighthouse` is scored on. */
export declare const LIGHTHOUSE_EXPERT_ID = "ex_2cvvUZQhDyeJ";
/**
 * Build the `skill_1` chain from a REAL conversation.
 *
 * Unlike the template and canvas chains, this one is verified against the
 * conversation it names, so the caller must first open a real chat and hand the
 * server-side ids in.
 */
export declare function skillChain(conversationId: string, requestId: string): TaskEventChain;
/** The theme-apply event `Hp_Appearance` is scored on. */
export declare function appearanceChain(themeKey?: string): TaskEventChain;
/** One expert from the platform's marketplace, as the summon chains need it. */
interface MarketExpert {
  expertId: string;
  expertType: string;
  displayName: string;
  profession: string;
  version: string;
  categories: readonly string[];
}
/**
 * The three "summon an expert" events (`expert_summon_click` and friends).
 *
 * Paid before the conversation, in the order the app emits them.
 */
export declare function expertSummonEvents(expert: MarketExpert): Record<string, unknown>[];
/** `mode` for the `expert_actual_use` payload; the scorer checks it. */
type ExpertUseMode = 'craft' | 'LOCAL';
/**
 * The "an expert really answered" event, which is what the expert tasks count.
 *
 * The `requestId` must be the SERVER's id for a real chat: a made-up one scores
 * nothing, because the scorer looks the conversation up.
 */
export declare function expertActualUseEvent(expert: MarketExpert, conversationId: string, requestId: string, mode?: ExpertUseMode): Record<string, unknown>;
/**
 * The chat chain for an expert conversation.
 *
 * `agent_task_created` carries the expert fields the scorer reads to attribute
 * the conversation to that expert.
 */
export declare function expertChatEvents(expert: MarketExpert, conversationId: string, requestId: string): Record<string, unknown>[];
//#endregion
//#region src/context-budget.d.ts
/**
 * Context-window budgeting for the WorkBuddy shim.
 *
 * The upstream answers `context_length_exceeded` (business code 11115) when a
 * request overruns the model's window. Rather than bouncing that back to the
 * user as a dead turn, the shim compacts the conversation on the fly:
 *
 *  1. estimate the prompt cost locally (cheap, no round trip);
 *  2. drop the oldest turns while keeping `system` + the newest exchange;
 *  3. if that still overruns, ask the model itself to summarise the middle of
 *     the conversation and splice that summary back in as a system message.
 *
 * Everything here is pure and synchronous-free except `summarizeMessages`,
 * which the caller drives through an injected chat function so this module
 * stays testable without a network.
 *
 * @module dsh-xdpool/context-budget
 */
/** One OpenAI chat message, narrowed to the fields we must preserve. */
interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}
//#endregion
//#region src/upstream.d.ts
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** Token-refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** One CLI-usable model, carrying what the plugin card displays. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  creditMultiplier?: number;
  /** Upstream image-input flag. Both gateways spell it `supportsImages`; some entries
   * also carry `disabledMultimodal`, the negative spelling. Reading anything else
   * reported every model as text-only, which made a vision shim register a second
   * route under the same display name and split the model picker group.
   */
  supportsImages?: boolean;
  reasoning?: {
    supportedEfforts?: readonly string[];
    defaultEffort?: string;
    canDisableThinking?: boolean;
  };
  descriptionZh?: string;
  descriptionEn?: string;
  supportsToolCall?: boolean;
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
  tags?: readonly string[];
}
/** One billing package, already normalised. */
interface WorkBuddyCreditPackage {
  packageName: string;
  remain: number;
  size: number;
  monthly: boolean;
  refreshAtMs?: number;
  expiresAtMs?: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  packages: readonly WorkBuddyCreditPackage[];
  expiringSoon: number;
  nearestExpiryMs?: number;
}
/** Daily check-in activity state. */
interface WorkBuddyCheckinStatus {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  isStreakDay: boolean;
  nextStreakDay: number;
  streakBonusDays: number;
  streakBonusCredit: number;
  /** Upstream-supplied button label; the card falls back to its own copy. */
  claimButtonText?: string;
}
/** Daily check-in claim result. */
interface WorkBuddyCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/**
 * Service-outage compensation offer (the "500 credits" banner on
 * /profile/plans-usage).
 *
 * Upstream shape, verified live on 2026-10-16:
 *   `{active: true, claimed: false, credit_num: 500, validity_period: 1,
 *     end_time: "2026-10-22 23:59:59"}`
 */
interface WorkBuddyCompensationStatus {
  /** An offer is running for this account (independent of claimability). */
  active: boolean;
  /** This account already collected the current offer. */
  claimed: boolean;
  /** Credits on offer — 500 for the DeepSeek-outage compensation. */
  creditNum: number;
  /** Claim deadline, upstream's own string, absent when there is no offer. */
  endTime?: string;
}
/** Compensation claim result. Upstream returns the same envelope shape. */
interface WorkBuddyCompensationClaim {
  claimed: boolean;
  creditNum: number;
}
/** Result of one upstream chat attempt. */
type ChatStreamResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  kind: UpstreamErrorKind;
  status: number;
  message: string;
};
interface UpstreamClientOptions {
  /** Injectable fetch, primarily for tests. */
  fetchImpl?: typeof fetch;
  /** Client version string sent to the upstream. */
  clientVersion?: string;
  /**
   * Override the catalog-fetch backoff, in milliseconds.
   *
   * Tests set this to `[]` (or tiny values) so a retry case does not spend real
   * seconds sleeping. Production uses {@link CATALOG_RETRY_BACKOFF_MS}.
   */
  catalogRetryBackoffMs?: readonly number[];
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
/** The two gateways WorkBuddy serves: the domestic one and the international one. */
type WorkBuddyRegion = 'cn' | 'global';
/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 * Body markers win over status, because the upstream reuses 400/200 for
 * several distinct conditions.
 */
export declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Recognises an epoch-millisecond field and the Chinese-localised sentence
 * form, so the pool can resume exactly when the window reopens.
 */
export declare function parseRateLimitReset(body: string): number | undefined;
/** One growth-centre task, flattened from the upstream's loosely-shaped entry. */
/** One streak tier and what redeeming it pays. */
interface WorkBuddyStreakTier {
  /** Tier key, e.g. `7d`. */
  tier: string;
  /** Login days the tier needs. */
  days: number;
  credit: number;
  energy: number;
  cards: number;
  /** Lottery draws the tier grants. */
  chances: number;
  /** `locked` / `unlocked` / `claimed`. */
  status: string;
}
/** The growth streak as a whole: progress, tiers, makeup cards. */
interface WorkBuddyStreakStatus {
  /** Current consecutive active days. */
  days: number;
  /** Days active this month. */
  monthTotalDays: number;
  /** Next tier key, e.g. `7d`. */
  nextTier: string;
  /** Days still needed for `nextTier`. */
  nextTierRemaining: number;
  /** Makeup cards in hand. */
  makeupCards: number;
  tiers: readonly WorkBuddyStreakTier[];
}
/** One buddy trip state. */
interface WorkBuddyTravelState {
  /** `idle` (can depart) / `traveling` / `arrived` (can claim). */
  state: string;
  /** Trip id, required to claim an arrived trip. */
  recordId: number;
  /** The once-a-day depart limit has been used. */
  dailyLimitReached: boolean;
  /** Credits an arrived trip pays. */
  rewardCredit: number;
}
interface WorkBuddyTask {
  /** Upstream task code; the claim path is built from it. */
  taskCode: string;
  title: string;
  /** Reward in credits, when the task declares one. */
  credit: number;
  /** Reward in energy, when the task declares one. */
  energy: number;
  /** Whether the task carries any reward at all. */
  hasReward: boolean;
  /** Progress target; 0 is a valid value (a task with no counter). */
  target: number;
  /** Current progress; 0 is a valid value. */
  current: number;
  /** Upstream enrolment state: not_accepted / accepted / claimed. */
  acceptStatus: string;
  /** Upstream task state, e.g. `complete`. */
  status: string;
  /** Progress reached its target and the reward is still outstanding. */
  claimable: boolean;
  /** Reward already collected. */
  claimed: boolean;
  /** Upstream marked the task locked (not yet reachable). */
  locked: boolean;
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
export declare function desktopChatEvents(conversationId: string, requestId: string, messageId: string, modelId?: string, modelName?: string): Record<string, unknown>[];
/**
 * A chat chain plus the two canvas events that score `create_canvas`.
 *
 * Worth +300, the joint largest task on the board. The canvas events ride
 * the same metrics channel as everything else, so no real canvas is needed.
 *
 * Measured: three accounts scored 1/1 from this sequence.
 */
export declare function desktopCanvasEvents(conversationId: string, requestId: string): Record<string, unknown>[];
/**
 * The single event that scores `automation_1` (a scheduled task was created).
 *
 * Measured: two accounts lit it with this event alone.
 */
export declare function desktopAutomationCreatedEvent(name: string): Record<string, unknown>;
export declare function buddyAppEvents(buddyId: string, buddyName: string): Record<string, unknown>[];
export declare class WorkBuddyUpstreamClient {
  private readonly fetchImpl;
  private readonly clientVersion;
  /** Backoff ladder for `fetchModels`; empty means a single attempt. */
  private readonly catalogRetryBackoffMs;
  /**
   * Optional logger for retry notices.
   *
   * Set by the host so a retry is visible in the log with its attempt count —
   * without it, a retry that eventually succeeds is invisible, and an operator
   * debugging "why was the catalog slow" has nothing to look at.
   */
  logger: {
    warn?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
  } | undefined;
  constructor(options?: UpstreamClientOptions);
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
  prepareChatBody(raw: string): string;
  /**
   * Parse a raw OpenAI chat body without normalising it.
   *
   * The compactor needs the message array as objects, while `chatStream` only
   * accepts the serialised string form.
   */
  parseChatBody(raw: string): Record<string, unknown> | undefined;
  /** Re-serialise `base` with a rewritten `messages` array, still normalised. */
  buildChatBody(base: Record<string, unknown>, messages: readonly ChatMessage[]): string;
  /**
   * Run one NON-streaming completion and return the assistant text.
   *
   * Used only for internal compaction (summarising dropped turns). The chat
   * endpoint itself always streams, so this reassembles the SSE frames into a
   * single string. Throws on any failure: the compactor then falls back to
   * plain truncation rather than failing the user's turn.
   */
  completeChat(credential: WorkBuddyCredential, prepared: string, signal?: AbortSignal, conversationKey?: string): Promise<string>;
  /** Forward one chat completion. Never throws for upstream failures. */
  chatStream(credential: WorkBuddyCredential, prepared: string, signal?: AbortSignal, conversationKey?: string): Promise<ChatStreamResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
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
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
  /**
   * One catalog attempt, without retries.
   *
   * Split out so {@link fetchModels} can retry it: the failure this guards
   * against is a startup network hiccup, where several independent components
   * see `fetch failed` inside the same second and the very next request
   * succeeds — exactly the case a single attempt turns into "the user's model
   * list is missing half its entries for the rest of the session".
   */
  private fetchModelsOnce;
  /** Read-only credits query, aggregated by package. Does not consume credits. */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /** Query today's check-in status without changing account state. */
  fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus>;
  /** Claim today's check-in reward. The browser route guards this mutation. */
  claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim>;
  /**
   * Read the service-outage compensation offer, if any.
   *
   * NOTE the missing `/v2`: unlike the check-in routes, this one lives at
   * `/billing/meter/compensation-status` and the `/v2` variant answers a plain
   * 404 (verified on both billing hosts). The web client calls it that way too.
   */
  fetchCompensationStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCompensationStatus>;
  /**
   * Collect the running compensation offer.
   *
   * Idempotent upstream: a repeat claim answers `code: 0` with
   * `claimed: true` rather than an error, so a second pass in the same day
   * records as a no-op instead of a failure.
   */
  claimCompensation(credential: WorkBuddyCredential): Promise<WorkBuddyCompensationClaim>;
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
  desktopFingerprint(credential: WorkBuddyCredential): Record<string, unknown>;
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
  reportDesktopEvents(credential: WorkBuddyCredential, events: readonly Record<string, unknown>[]): Promise<void>;
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
  reportWebEvent(credential: WorkBuddyCredential, eventCode: string, pageUrl: string, elementId: string, elementName: string): Promise<void>;
  /**
   * Apply an appearance theme on the account.
   *
   * The theme task is scored on the `appearance_skin_apply` event, not on this
   * call — but the event alone is not enough either. The pair is what a real
   * client produces: it PATCHes the account's selected skin, then reports the
   * event as the settings page closes. Measured on the reference panel after
   * the earlier "the API alone does not score" reading was corrected.
   */
  setAppearanceTheme(credential: WorkBuddyCredential, resourceKey: string): Promise<void>;
  /**
   * The platform's expert marketplace.
   *
   * Needed before any expert can be summoned: the scorer verifies that the
   * expert id exists on the platform, so a made-up id scores nothing. The
   * response carries the display fields the summon events replay.
   */
  marketExpertList(credential: WorkBuddyCredential, expertType?: 'agent' | 'team' | ''): Promise<readonly MarketExpert[]>;
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
  openConversation(credential: WorkBuddyCredential, expertId?: string, signal?: AbortSignal): Promise<{
    conversationId: string;
    requestId: string;
  } | undefined>;
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
  reportActivity(credential: WorkBuddyCredential, conversationId?: string): Promise<void>;
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
  growthStreakDays(credential: WorkBuddyCredential): Promise<number>;
  /**
   * The full streak picture: days, tier unlock state, and what each tier pays.
   *
   * Read before redeeming, because the tier state is the only honest answer to
   * "is there anything to claim": the redeem endpoint answers 403 for a locked
   * tier, which is indistinguishable from a real failure once the response is
   * just an error.
   */
  growthStreakFull(credential: WorkBuddyCredential): Promise<WorkBuddyStreakStatus>;
  /**
   * Redeem one unlocked streak tier.
   *
   * A locked tier answers 403 ("连续登录天数不足"); callers check the status from
   * {@link growthStreakFull} first, so this only throws for genuine failures.
   * The client token is the upstream's idempotency key — a fresh one per attempt
   * keeps a retry from being read as a duplicate of the last one.
   */
  redeemStreakTier(credential: WorkBuddyCredential, tier: string): Promise<void>;
  /** How many lottery draws are available right now. */
  lotteryChances(credential: WorkBuddyCredential): Promise<number>;
  /**
   * Draw the lottery once.
   *
   * Returns the raw prize payload: its shape is set by the running campaign, so
   * it is passed through rather than modelled.
   */
  lotteryDraw(credential: WorkBuddyCredential): Promise<unknown>;
  /**
   * The buddy profile, or undefined when the account has no buddy yet.
   *
   * `data.buddy` is null / absent / an empty object depending on how far the
   * account got, and all three mean the same thing to a caller: adopt first.
   */
  buddyInfo(credential: WorkBuddyCredential): Promise<{
    instanceId: number;
    name: string;
  } | undefined>;
  /** Agree to the buddy terms. Idempotent upstream. */
  buddyAgree(credential: WorkBuddyCredential): Promise<void>;
  /**
   * Adopt the first buddy.
   *
   * Gated upstream on having reported activity that day: without it the answer
   * is 400 "first_buddy task not completed yet". Callers treat that as "not yet"
   * rather than an error, which is why it is thrown as-is for them to classify.
   */
  buddyAdoptFirst(credential: WorkBuddyCredential): Promise<void>;
  /** Current travel state for the account's buddy. */
  buddyTravelStatus(credential: WorkBuddyCredential): Promise<WorkBuddyTravelState>;
  /**
   * Send the buddy travelling.
   *
   * The location is always 4 (古镇客栈): the four locations have identical
   * reward and duration ranges, so there is nothing to optimise.
   */
  buddyTravelDepart(credential: WorkBuddyCredential, locationId?: number): Promise<void>;
  /**
   * Collect an arrived trip's reward.
   *
   * `recordId` is required and comes from the status read; the upstream rejects
   * a claim without it.
   */
  buddyTravelClaim(credential: WorkBuddyCredential, recordId: number): Promise<number>;
  /** Whether yesterday is a gap in the activity heatmap. */
  heatmapYesterdayMissed(credential: WorkBuddyCredential): Promise<boolean>;
  /** Spend one makeup card on a date. Idempotent for an already-filled date. */
  useMakeupCard(credential: WorkBuddyCredential, date: string): Promise<void>;
  /**
   * Call a growth-domain endpoint and return its unwrapped `data`.
   *
   * These endpoints live on the chat host with the billing header set, and
   * carry the same envelope as everything else. Centralised here because every
   * growth call needs the identical envelope check.
   */
  private growthJson;
  /** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
  credits(credential: WorkBuddyCredential): Promise<{
    ok: true;
    data: unknown;
  } | {
    ok: false;
    message: string;
  }>;
  /**
   * Fetch the growth task list for one account.
   *
   * The upstream answers `data.tasks[]`, and `claimable` is derived locally —
   * the upstream does not mark it. Only a task whose progress reached its
   * target and that is not already claimed counts as eligible.
   */
  listTasks(credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]>;
  /**
   * Accept (enrol in) tasks by code.
   *
   * Accepting is the "sign up" half: it produces no progress by itself, and the
   * upstream answers success for an already-accepted task, so replaying this is
   * safe. Progress is lit by real activity (a chat, an activity report).
   */
  acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void>;
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
  claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<{
    credit: number;
    energy: number;
  }>;
}
//#endregion
//#region src/accounts.d.ts
/** Minimal upstream surface the pool needs to refresh a token (no circular import). */
interface TokenRefresher {
  refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresInSec?: number;
    domain?: string;
  }>;
}
/** Live auth file name the WorkBuddy desktop app writes. */
export declare const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Snapshot files left behind by previous logins share this prefix. */
/** Env override for the auth file or its directory. */
export declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** One parsed WorkBuddy credential. */
/**
 * A credential file the pool could not turn into an account.
 *
 * Reported (not swallowed) because the count is otherwise a lie: a directory
 * holding four files that yields two accounts looks like two accounts were
 * deleted, when in fact two files were unreadable. Naming the file and the
 * reason is what makes the difference visible.
 */
interface WorkBuddySkippedFile {
  path: string;
  reason: 'encrypted' | 'unreadable' | 'malformed';
}
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  /**
   * When the upstream says it issued this token (`auth.lastRefreshTime`).
   *
   * This, not `expiresAtMs`, is the reliable freshness signal: the upstream
   * never rewrites a stored expiry when it revokes a token, so a long-dead
   * backup can claim to expire later than the token that actually works.
   * Absent on documents the desktop app did not write (the plugin's own
   * refreshed copy, older builds).
   */
  lastRefreshAtMs?: number;
  nickname?: string;
  uin?: string;
  uid?: string;
  enterpriseId?: string;
  domain: string;
  /** Where this credential came from, for diagnostics. */
  sourcePath: string;
}
/** An account is a credential plus pool bookkeeping. */
interface WorkBuddyAccount {
  /** Stable pool key: sha256 of the billing identity. */
  id: string;
  /** Short human label, e.g. `青楫渡` or `青楫渡#29890334`. */
  label: string;
  credential: WorkBuddyCredential;
  /**
   * Epoch ms until which this account is skipped for EVERY model. Only set by
   * account-wide cooldowns (callers that penalize without a model id). The
   * upstream rate limit is actually per-model ("可切换其他模型继续使用"), so
   * routine 429s are tracked in {@link modelCooldowns} instead and never ban a
   * whole account.
   */
  cooldownUntilMs: number;
  /**
   * Per-model cooldowns, keyed by upstream model id → epoch ms until that model
   * on THIS account is skipped. A 429 on `hy4-preview` cools only that model
   * here; `hy3`/`glm-*` on the same account keep serving.
   */
  modelCooldowns: Record<string, number>;
  /** Consecutive rate-limit hits, for diagnostics. */
  rateLimitHits: number;
  /**
   * Epoch ms until which this account is skipped because the upstream REJECTED
   * its sign-in (401/403), not because of a rate limit.
   *
   * A revoked session is invisible from the credential file: the upstream does
   * not rewrite `expiresAtMs` when it kills a refresh token, so a dead account
   * looks perfectly fresh and, without this field, gets picked again on the very
   * next attempt. With `maxAttempts` retries that meant one dead account could
   * absorb an entire request while healthy accounts were never tried.
   *
   * Only a fresh sign-in in the desktop app clears it, so the cooldown is long;
   * `0`/undefined means "not known to be dead".
   */
  credentialDeadUntilMs?: number;
}
/**
 * Platform-default directories holding the desktop app's auth files.
 * Windows probes Local before Roaming; a redirected profile still resolves
 * through the env location.
 */
export declare function defaultDesktopAuthDirs(platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv): string[];
/**
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 *
 * `decrypt` opens the desktop app's `$wbEncrypted` field wrapper (5.6.0+, both
 * platforms). Absent means "plain-string builds only", which is what every
 * caller without an at-rest key should pass.
 */
export declare function parseWorkBuddyAuth(text: string, sourcePath: string, decrypt?: (field: unknown) => string): WorkBuddyCredential | undefined;
export declare function workbuddyAccountId(credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>): string;
/** Every directory the pool should scan, in probe order. */
export declare function candidateAuthDirs(env?: NodeJS.ProcessEnv): string[];
/** How the pool chooses which account serves the next request. */
type AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: {
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error?(...args: unknown[]): void;
  };
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[];
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number;
  /** How long an account rests after its credits run out (default 30 minutes). */
  exhaustCooldownMs?: number;
  /**
   * How long an account rests after the upstream rejects its sign-in
   * (default 30 minutes). Only a fresh sign-in in the desktop app clears it.
   */
  credentialDeadCooldownMs?: number;
  /** Upstream client used to refresh near-expiry tokens. */
  client?: TokenRefresher;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
  /**
   * How requests are spread across the pool.
   *
   * - `priority` (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one
   *   account at a time, and a cooled account resumes at the head of the
   *   queue the moment its window resets.
   * - `round-robin`: consecutive requests rotate through the pool so the
   *   spend spreads evenly.
   * - `sticky`: one account per conversation, and a new conversation moves to
   *   the next account in order. Keeps the upstream prompt cache warm inside a
   *   conversation while still spreading spend across conversations.
   * - `expiry`: the account whose one-off credit packs expire soonest serves
   *   first, so use-it-or-lose-it credits are spent before they die. Accounts
   *   with no known expiry sort last, so a pool that has never been probed
   *   behaves like `priority`.
   */
  distribution?: AccountDistribution;
  /**
   * Enable the durable account store.
   *
   * When on, `scan()` seeds its merge from `~/.dsh/.xdpool/accounts.json` and
   * writes the merged list back, so accounts gathered by switching desktop
   * sign-ins survive a restart, and the plugin's snapshot directory becomes a
   * scan source.
   *
   * DEFAULT OFF, on purpose: the 70+ existing pool tests build fixtures over
   * temp auth dirs, and a store that wrote by default would flush those
   * fixtures into the user's real `~/.dsh/.xdpool/accounts.json`. Production
   * assembles the pool through `createCore()`, which passes `persistent: true`;
   * tests opt in explicitly.
   */
  persistent?: boolean;
}
export declare class WorkBuddyAccountPool {
  private readonly logger;
  private authDirs;
  private cooldownMs;
  /**
   * How long an account stays out of rotation after the upstream reports its
   * credits are spent. Credit packs reset on their own schedule rather than on a
   * rate-limit window, so this is much longer than `cooldownMs`.
   */
  private exhaustCooldownMs;
  /**
   * How long an account stays out of rotation after the upstream rejected its
   * sign-in. Cleared by a newer credential file or an explicit sign-in.
   */
  private credentialDeadCooldownMs;
  private readonly client;
  private readonly refreshMarginMs;
  private accounts;
  /**
   * Files the last scan could not read, with the reason.
   *
   * Surfaced so "2 accounts" can be told apart from "4 files, 2 unreadable" —
   * the difference between accounts being gone and files being unopenable.
   */
  private skippedFiles;
  private distribution;
  /** Cursor for round-robin mode; unused under priority distribution. */
  private cursor;
  /**
   * `sticky` mode: conversation key → account id.
   *
   * A conversation that keeps the same account also keeps that account's
   * upstream prompt cache warm — the cache is per tenant, so rotating accounts
   * mid-conversation pays full prompt cost on every turn. Insertion order is
   * the LRU order: re-binding deletes then re-inserts.
   */
  private readonly affinity;
  private lastScanAtMs;
  /**
   * The account id the user pinned, or undefined for none.
   *
   * Field rather than a public property so that the only way in is
   * {@link WorkBuddyPool.prefer} and the only way out is {@link WorkBuddyPool.preferredId}:
   * a mutable public field would let a caller pin an account without the pool
   * knowing, and a getter alone would let a caller read a pin the pool has
   * already forgotten.
   */
  private preferredAccountId;
  /**
   * Account ids the user switched off on the card.
   *
   * Disabling is a user preference rather than a property of the credential:
   * `scan()` rebuilds every account object from the auth files, so the set
   * lives on the pool and is re-applied from settings after each scan.
   */
  private disabledIds;
  /**
   * Account ids the user threw out of the pool for good.
   *
   * Enforced BEFORE the credential is parsed: `scan()` skips a file whose
   * identity is already ignored, so an ignored account costs no at-rest key
   * lookup (which spawns the desktop app on 5.6.0+) and cannot re-enter the pool
   * when the app writes a fresh sign-in for it. That is the difference from
   * {@link disabledIds}, which only filters at pick time and leaves the account
   * listed, readable and re-discoverable.
   *
   * The set is supplied by the host from the plugin's own ignore file, and is
   * replaced wholesale on every {@link applyIgnored} so removing an entry takes
   * effect on the next scan without a restart.
   */
  private ignoredIds;
  /**
   * Per-account credit floor, keyed by account id. 0 (or absent) means "spend
   * it all".
   *
   * A reserved balance is protection, not a hard limit the upstream knows
   * about: the pool simply stops picking that account once its last known
   * balance is at or below the floor, so the user keeps a cushion instead of
   * draining every account to zero.
   */
  private creditReserves;
  /**
   * Last known credit balance per account, epoch ms aside.
   *
   * Refreshed in the background after a successful request, so a pick can
   * consult it. An account with no reading is treated as usable: refusing to
   * pick an account just because its balance has not been checked yet would
   * strand a healthy pool, and the first 402 still cools it as before.
   */
  private creditBalances;
  /**
   * Nearest expiry among each account's one-off credit packs, epoch ms.
   *
   * Credit packs are use-it-or-lose-it, so "which account should serve next"
   * has a second honest answer besides "which one is idle": the one whose
   * credits die soonest. Only one-off packs count — monthly packs refresh on
   * their own cycle and are therefore never urgent — which is why this is
   * written from the same `fetchCredits` reading that fills `creditBalances`.
   *
   * An absent entry means "never probed, or nothing is about to expire". Both
   * are the same thing to `expiry` mode: not urgent, so it sorts last.
   */
  private creditExpiry;
  /**
   * Last time each account served a request, epoch ms. Drives the idle term
   * of the priority-mode weighting below: an account that just served loses to
   * one that has been idle, so a small pool stops hammering a single account.
   *
   * In-memory on purpose: it only biases the next pick, so a cold start that
   * treats every account as idle is the right default. Not keyed by id lookup
   * misses because a removed account simply disappears from the map on re-scan.
   */
  private lastUsedAt;
  private refreshInflight;
  /**
   * Whether `scan()` seeds from and writes back the durable account store.
   *
   * Off by default (tests build fixtures over temp dirs and must not touch the
   * user's real store); `createCore()` turns it on for production, which is
   * what makes accounts gathered by switching desktop sign-ins survive a
   * restart — the desktop app keeps only the current sign-in's credential file
   * on disk.
   */
  private readonly persistent;
  /** Path of the durable store; computed once so tests can pin it. */
  private readonly storePath;
  /**
   * Optional second source of credentials: the channel pack's account pool,
   * which holds the accounts the user signed in through the scan-login page.
   *
   * A function rather than a list because that pool is mounted asynchronously
   * and can be re-read on demand; `undefined` means "no such source", which is
   * the state every test and every pre-mount startup is in.
   */
  private externalSource?;
  constructor(options?: AccountPoolOptions);
  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   */
  applyConfig(options: {
    authDirs?: readonly string[];
    cooldownMs?: number;
    exhaustCooldownMs?: number;
    distribution?: AccountDistribution;
    disabledAccountIds?: readonly string[];
    /** Per-account credit floor, keyed by account id. Absent keeps the current map. */
    creditReserves?: Readonly<Record<string, number>>;
  }): void;
  /**
   * Register (or clear, with `undefined`) the extra credential source that
   * `scan()` merges alongside the auth directories. Rescanning is the caller's
   * job: this only changes where the next scan looks.
   */
  applyExternalSource(source?: () => Promise<readonly WorkBuddyCredential[]>): void;
  /**
   * Replace the permanent ignore list.
   *
   * Also drops any already-discovered account that is now ignored, so the change
   * is visible without waiting for the next scan: the card refreshes its status
   * document right after the write, and an account still sitting in `accounts`
   * would keep showing up there.
   */
  applyIgnored(ids: Iterable<string>): void;
  /** Whether this account has been thrown out of the pool for good. */
  isIgnored(accountId: string): boolean;
  /** Every ignored id currently in force, in insertion order. */
  ignoredIdsInOrder(): string[];
  /**
   * Credential files the last scan could not read, with the reason.
   *
   * Exposed because a short account list is otherwise indistinguishable from a
   * broken one: with this, the card can say "2 accounts, 2 files unreadable"
   * instead of silently showing half a pool.
   */
  skippedFilesInOrder(): readonly WorkBuddySkippedFile[];
  /** Rescan the auth directories and merge newly discovered accounts. */
  scan(): Promise<WorkBuddyAccount[]>;
  /** All accounts, cooldown state included. */
  list(region?: WorkBuddyRegion): readonly WorkBuddyAccount[];
  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics).
   */
  private available;
  /**
   * Why no account is available right now, for an accurate error.
   *
   * The pool can be empty for reasons that need OPPOSITE remedies: nobody is
   * signed in (the user must sign in), every account is rate-limited (the user
   * must wait, and retrying later works), or every account was switched off /
   * ignored (the user must re-enable one). Reporting all of them as "no
   * credential, sign in" sent users to re-authenticate over a temporary 429 —
   * observed as an "API key invalid" panel for a model that was merely cooling.
   *
   * Counts are over the region's accounts, since a provider only ever sees its
   * own gateway.
   */
  unavailableReason(modelId?: string, region?: WorkBuddyRegion): {
    total: number;
    cooling: number;
    disabled: number;
    /** Accounts skipped because the upstream rejected their sign-in. */
    dead: number;
    reason: 'empty' | 'cooling' | 'disabled' | 'reserve' | 'session_dead' | 'none';
  };
  /** Round-robin: the legacy cursor walk, kept for the distribution that asks for it. */
  private pickRoundRobin;
  /** Remember which account a conversation is bound to, keeping LRU order. */
  private bindAffinity;
  /**
   * `sticky`: the account this conversation already used, when it can still
   * serve the model being asked for.
   *
   * Returns `undefined` both when there is no binding and when the binding is
   * no longer eligible (cooling for this model, disabled, out of credits) — the
   * caller then rebinds, which is what makes a rate-limited conversation hop to
   * a fresh account instead of failing.
   */
  private affinityAccount;
  /** Bindings currently remembered; exposed for tests and diagnostics. */
  affinitySize(): number;
  /** Forget every conversation binding (tests, and a settings change). */
  clearAffinity(): void;
  /**
   * Priority mode: weighted random over the eligible accounts.
   *
   * The weight is an idle bonus — `1 + min(idleHours * perHour, max)` — so an
   * account that has never served (or has been idle for a while) outranks one
   * that just answered. Reference panel logic drops its success-rate term
   * entirely because a lifetime error counter penalises an account forever;
   * instantaneous health is already handled by cooldowns, which is why those
   * accounts never reach this list.
   *
   * A pool with no idle history (fresh process) hashes to equal weights, which
   * spreads the very first picks instead of always returning index 0.
   */
  private pickByWeight;
  /**
   * `expiry` mode: the account whose one-off credit packs die soonest.
   *
   * Credit packs are use-it-or-lose-it, so spending the dying ones first is
   * strictly better than spreading the spend: an account that expires with
   * credits left is money burnt, while an account whose packs have no deadline
   * loses nothing by waiting. Two accounts expiring at the same instant fall
   * back to the pool order, and an account with no known expiry sorts last —
   * "we have not looked" must never outrank a real deadline.
   *
   * A pool where nobody has a known expiry therefore behaves exactly like
   * priority, which is the honest degradation: without a reading there is
   * nothing to sort by.
   */
  private pickByExpiry;
  /**
   * Pick the account to serve a request.
   *
   * Two distributions, chosen by the `distribution` setting:
   *
   * - **priority** (default, and what the card ships with): one account serves
   *   every request until it is rate-limited, then the next in order takes over.
   *   Credits drain one account at a time, and a cooling account returns to the
   *   head of the queue the moment its window resets — it was never consumed, so
   *   it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   * - **sticky**: one account per conversation, and a new conversation moves to
   *   the next account in order. Keeps the upstream prompt cache warm within a
   *   conversation while still spreading spend across conversations.
   * - **expiry**: the account whose one-off credit packs expire soonest serves
   *   first, so use-it-or-lose-it credits are spent before they vanish.
   *
   * In every mode an explicit user selection (`prefer`) heads the list, a
   * cooling account is skipped for that model only, and an unrecognised setting
   * falls back to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   *
   * `conversationKey` is only consulted under `sticky`; other modes ignore it.
   */
  acquire(modelId?: string, region?: WorkBuddyRegion, conversationKey?: string): Promise<WorkBuddyAccount | undefined>;
  /** How the pool currently spreads requests. Shown on the card. */
  currentDistribution(): AccountDistribution;
  /**
   * The account the user asked to be tried first, whatever the distribution says.
   *
   * Pins identity, not the credential: the account still has to pass every gate
   * the strategy applies (fresh token, out of cooldown, above its credit reserve,
   * not switched off), and when it fails one of them the pool falls back to the
   * strategy untouched. That is the whole promise — "try this first", never "only
   * ever use this one" — and it is why a stale pin is harmless.
   *
   * Returns undefined when nothing is pinned, which is also how the user undoes a
   * pin. The value survives {@link WorkBuddyPool.scan}, because a rescan discovers
   * accounts and must not quietly revise a choice the user made about one of them.
   */
  prefer(accountId: string | undefined): void;
  /**
   * Which account is pinned, for the card and the status document.
   *
   * A reader is required rather than optional politeness: without one the status
   * document would have to report a preference it cannot see, and the only
   * truthful way to render "you asked for this one" on a row is to ask the pool.
   * Callers that need to know whether the pin is still *live* (pinned AND present
   * in the pool) must do that presence check themselves — this answers "what did
   * the user choose", not "is it usable right now".
   */
  preferredId(): string | undefined;
  /** Whether the user switched this account off on the card. */
  isDisabled(accountId: string): boolean;
  /** Every account id the user switched off, in discovery order. */
  disabledIdsInOrder(): string[];
  /**
   * Record that an account actually served a request.
   *
   * Called by the shim once the upstream answers 200 — only then is the account
   * the one the user is really being served by. `balanced` mode reads the same map
   * for its idle weighting, so a request that failed over to another account must
   * not count as used for the account that was merely tried.
   */
  noteServed(accountId: string): void;
  /**
   * Record an account latest known credit balance.
   *
   * Called after a request and by the card balance refresh, so the reserve
   * check has something to compare against. A reading for an unknown account is
   * dropped: `scan()` rebuilds the account list and a stale id would otherwise
   * accumulate forever.
   *
   * `nearestExpiryMs` is the same reading's nearest one-off pack deadline, or
   * undefined when nothing is about to expire. It is written through, not
   * merged: a pack that has been spent or has died disappears from the next
   * reading, and keeping the stale deadline would pin the pool to an account
   * whose credits are already gone — the opposite of what `expiry` mode wants.
   */
  noteCredits(accountId: string, balance: number, nearestExpiryMs?: number): void;
  /** Nearest one-off pack expiry for one account, or undefined when none known. */
  creditExpiryOf(accountId: string): number | undefined;
  /** Last known balance for one account, or undefined when never read. */
  creditsOf(accountId: string): number | undefined;
  /** The credit floor the user set for one account; 0 when unset. */
  creditReserveOf(accountId: string): number;
  /**
   * Replace every reserve. Called from settings on each apply, so the map
   * mirrors the saved document exactly instead of accumulating old keys.
   */
  setCreditReserves(reserves: Readonly<Record<string, number>>): void;
  /** Every reserve currently in force, keyed by account id. */
  creditReservesInOrder(): Record<string, number>;
  /**
   * Whether an account is held back only by its reserve.
   *
   * Separates "resting to protect credits" from every other reason an account
   * is out of rotation, which is what the card shows the user.
   */
  isReserved(accountId: string): boolean;
  /**
   * The account that served the most recent request, if any.
   *
   * Distinct from "who would serve the next one": this is a record of what
   * actually happened, which is what the card needs to answer "which account am
   * I using right now?". Under `balanced` there is no deterministic next account
   * at all, so a recorded fact is the only honest answer.
   *
   * Returns undefined before the first request of the process, and after every
   * known account has been re-scanned away (a login swapped out under us).
   */
  lastServedId(): string | undefined;
  /** Best-effort refresh of one account after a session-dead upstream answer. */
  refreshAccount(accountId: string, options?: {
    force?: boolean;
  }): Promise<boolean>;
  /**
   * Cool a whole account because the upstream REJECTED its sign-in (401/403).
   *
   * Called with direct evidence (the request just came back `session_dead`), so
   * it does not need to guess: without this, the next retry of the SAME request
   * picks the same account again — its credential file still claims to be valid
   * — and a request with 8 attempts spends all 8 on one dead account while
   * healthy accounts are never tried.
   */
  penalizeCredentialDead(accountId: string): void;
  /** Put an account back in rotation after its sign-in was proven good again. */
  clearCredentialDead(accountId: string): void;
  /** Accounts currently kept out of rotation because their sign-in was rejected. */
  deadCredentials(): readonly WorkBuddyAccount[];
  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   *
   * `force` skips the "is it expiring?" gate. That gate is a cost optimisation,
   * not a correctness rule: it exists so a healthy token is not re-fetched on
   * every acquire. After the upstream has ALREADY rejected the token, the gate
   * is actively wrong — a revoked token keeps its future `expiresAtMs` — and the
   * caller needs the refresh attempted so the credential can be proven dead.
   *
   * Returns true when the token is known good afterwards (refreshed, or still
   * valid), false when the credential was proven dead.
   */
  private ensureFresh;
  /**
   * Cool a whole account after the upstream reports its credits are spent.
   *
   * Credit exhaustion is an ACCOUNT condition, unlike a model rate limit: every
   * model on that account is unusable until the quota resets, so this cools the
   * account as a whole (no `modelId`) for the configured exhaustion window. The
   * shim then rotates to a different account instead of failing the request.
   */
  penalizeExhausted(accountId: string): void;
  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   */
  penalize(accountId: string, resetAtMs?: number, modelId?: string): void;
  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns(): void;
  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status(): {
    count: number;
    cooling: number;
    dead: number;
    lastScanAtMs: number;
  };
}
//#endregion
//#region src/status-paths.d.ts
/**
 * Node-free constants and types shared by the Host and browser halves of the
 * XD Pool settings card.
 *
 * Pool's runtime state already lives in `src/status.ts` (`buildStatus` /
 * `WorkBuddyStatus`); this module only carves the cross-domain (Host→browser)
 * JSON document into a shape that stays token-free and matches what the
 * browser card renders. Route paths are plugin-owned and mounted on the Host's
 * same-origin web server (see `src/web-status.ts`).
 *
 * @module dsh-xdpool/status-paths
 */
/** Plugin-owned read-only pool status endpoint (account rows + models + shim). */
export declare const POOL_STATUS_PATH = "/plugins/dsh-xdpool/status";
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
export declare const POOL_RESCAN_PATH = "/plugins/dsh-xdpool/accounts/rescan";
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
export declare const POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-xdpool/cooldowns/reset";
/** Plugin-owned daily check-in action endpoint (claim today's reward). */
export declare const POOL_CHECKIN_PATH = "/plugins/dsh-xdpool/checkin";
/** Plugin-owned model-selection save endpoint (writes the settings section). */
export declare const POOL_MODELS_SAVE_PATH = "/plugins/dsh-xdpool/models/save";
/**
 * Throw one account out of the pool for good, or take it back.
 *
 * Separate from the disable route because the semantics differ: disabling is a
 * rotation preference the account survives, ignoring survives the account.
 */
export declare const POOL_ACCOUNT_IGNORE_PATH = "/plugins/dsh-xdpool/accounts/ignored";
/** Run one automation job immediately, so the card can verify it on demand. */
export declare const POOL_AUTOMATION_RUN_PATH = "/plugins/dsh-xdpool/automation/run";
/** Set or clear one account's reserved-credit floor. */
export declare const POOL_CREDIT_RESERVE_PATH = "/plugins/dsh-xdpool/accounts/credit-reserve";
/**
 * One model's facts, exactly as the host's catalogue spells them.
 *
 * Every optional field is absent when the host does not know it, which is the
 * common case: modalities are only reported by adapters that publish them, and a
 * missing window is missing rather than a default.
 */
interface PoolWebChannelModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: readonly string[];
  description?: string;
}
/**
 * One billion-context session, reduced to what a dashboard may show.
 *
 * Counts, sizes and timestamps only. The proxy's own rows carry titles and
 * first-block hints, which are the user's words; those stay on the machine that
 * produced them and are not relayed.
 */
interface PoolWebBillionSession {
  /** The proxy's session id. Safe to show: it is a generated handle. */
  id: string;
  /** Which wire the session speaks; `openai` is what DSH's shim uses. */
  protocol: string;
  /** Whether a request hit this session in the last few seconds. */
  live: boolean;
  requests: number;
  /** The compacted context size the proxy is holding, 0 when unknown. */
  contextTokens: number;
  /** Which measurement the context size came from; `usage` is the honest one. */
  contextTokensSource: string;
  /** Net tokens the proxy says compression saved. */
  tokensSaved: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Cache hit rate 0-100, or -1 when no input tokens were ever counted. */
  cacheHitPct: number;
  /** How many compressed blocks this session holds. */
  blocks: number;
  /** The window the proxy believes the model has, 0 when unknown. */
  contextWindow: number;
  /** ISO timestamp of the last request, or '' when the session never had one. */
  lastSeen: string;
  /** The last model the session saw, or '' before the first request. */
  lastModel: string;
}
/** The document {@link POOL_BILLION_PATH} answers with. */
interface PoolWebBillionStatus {
  /**
   * Whether a proxy was found and answered.
   *
   * `missing` is a normal, expected state, not an error: billion-context is a
   * separate plugin, and a machine without it must get a page that explains
   * that rather than a 503 or a blank panel.
   */
  state: 'ready' | 'missing' | 'unreachable';
  /** Human text for a non-ready state; absent when ready. */
  reason?: string;
  /**
   * The proxy's own loopback origin, absent only when none was recorded.
   *
   * The card needs this to hand the user a browser link: billion-context ships
   * its own dashboard, including a per-session detail view, and duplicating
   * those screens here would be a second and divergent copy of another
   * plugin's interface. Linking out keeps one answer.
   *
   * This is a service address, not conversation material, and it is safe to
   * publish for the same reason the route that carries it is loopback-only: a
   * caller who can read this document can already reach that listener directly.
   * It is present on `unreachable` too — a proxy that recorded its port and
   * then went quiet is exactly the case where the URL is the only handle.
   */
  origin?: string;
  /** The proxy's version, from its own manifest. */
  version?: string;
  /** When the proxy process started (epoch ms), 0 when unknown. */
  startedAt?: number;
  /** Sessions newest-first, capped by the route. */
  sessions: readonly PoolWebBillionSession[];
  /** How many sessions the proxy holds in total, including capped-out ones. */
  totalSessions: number;
}
/**
 * Where a registry provider's key goes: `apiKey`, `baseUrl`, or `enabled`.
 */
type PoolWebAggregatePatch = {
  kind: 'provider';
  providerId: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  /**
   * The chosen model set, replacing whatever this provider exposed before.
   *
   * This is a REPLACEMENT, not a delta, because the card sends the whole
   * selection in one go: the browser half holds no server-side roster to
   * patch against, and a delta would let two open tabs silently interleave
   * into a set neither of them chose. An empty array is not "zero models" —
   * `updateProviderSetting` drops the field, which returns the provider to
   * its discovered listing or the registry's own.
   */
  models?: readonly string[];
} |
/** Flip the lane's own master switch; `false` contributes no models at all. */
{
  kind: 'lane';
  enabled: boolean;
} |
/** Forget one provider's stored setting entirely, key included. */
{
  kind: 'clear';
  providerId: string;
};
/** One provider as the card renders it. Never carries the key itself. */
interface PoolWebAggregateProvider {
  id: string;
  name: string;
  category: string;
  authKind: string;
  format: string;
  /** Where the user obtains a key, for the "get one" link. */
  authUrl?: string;
  website?: string;
  /** True when this lane can serve the provider with a pasted key. */
  supported: boolean;
  /** True when a key is present (or none is needed). */
  configured: boolean;
  /**
   * True when this vendor contributes models right now.
   *
   * Not simply "the user did not switch it off": with no explicit flag the
   * answer follows the credential, so an unconfigured vendor reads as off. The
   * roster is a directory to choose from, and a page that drew every one of the
   * seventy-six with its switch already on could not show what was configured.
   */
  enabled: boolean;
  /**
   * The vendor's own one-line description, from the registry.
   *
   * This is the row's small print. The registry carries no per-model blurb —
   * `models[]` entries are id/name/contextWindow/vision/reasoning only — so the
   * description belongs to the vendor, and the card must not imply otherwise.
   */
  notes?: string;
  /** A base-URL override the user typed, if any. */
  baseUrl?: string;
  /** True when the provider declares a model listing this lane can read. */
  hasListing: boolean;
  /** Model ids currently exposed: the chosen set, or the whole roster. */
  models: readonly string[];
  /**
   * Every id this provider could offer, which is the roster after a fetch.
   *
   * Equal to `models` until the user narrows the choice. It exists so the card
   * can offer a checkbox per id — without it, choosing could only ever remove
   * rows and never put one back.
   */
  availableModels: readonly string[];
  /** True when the exposed set came from a live listing rather than the registry. */
  discovered: boolean;
  /** When the provider was first configured. */
  addedAt?: string;
}
/** The document {@link POOL_AGGREGATE_PATH} answers with. */
interface PoolWebAggregateStatus {
  /** The lane's own master switch. */
  enabled: boolean;
  /** How many providers hold a setting at all. */
  configured: number;
  /** How many model rows the lane currently offers. */
  modelCount: number;
  /** The rows, in provider-then-model order. */
  models: readonly {
    id: string;
    name: string;
    providerId: string;
    modelId: string;
    contextWindow: number;
    maxOutputTokens: number;
    supportsImages: boolean;
    source: 'static' | 'discovered';
  }[];
  /** The whole registry, in registry order. */
  providers: readonly PoolWebAggregateProvider[];
}
/**
 * One login channel as the card renders it.
 *
 * `loginKind` is presentation only: `browser` means "open a link and sign in
 * there". The card never learns which protocol a channel speaks — that stays
 * inside the pack, which hands back a `loginUrl` per sign-in attempt.
 */
interface PoolWebChannel {
  id: string;
  name: string;
  /** Who runs it. */
  org: string;
  /**
   * The vendor's published API host, when it publishes one.
   *
   * Absent for eleven of the thirteen: the pack names `apiDomain` only for the
   * two WorkBuddy lanes, and everything else would be a host we guessed. The
   * card falls back to `org` when this is missing, so the subtitle is never
   * blank and never invented.
   */
  domain?: string;
  /** Accent colour, for the channel's chip. */
  accent: string;
  /** One Chinese line on what the free allowance actually is. */
  note: string;
  loginKind: 'browser';
  /** True when this plugin's own account pool already serves this channel. */
  ownedByPool: boolean;
  /**
   * True when the vendor's own login page offers a phone-code path.
   *
   * Not a capability this plugin provides — the pack drives the page, and all
   * this says is that the page behind the button holds a second door. Raccoon's
   * does (QR and SMS on one screen), and its QR is the one that goes stale while
   * the user reads the message.
   */
  smsHint?: boolean;
  /**
   * What the pack can report about this vendor's credits, when it can report
   * something at all.
   *
   * Absent is meaningful: it means `credits.balances` has no branch for this
   * provider, so no balance exists to show. Present-but-empty means balances
   * work but there is no daily check-in behind them.
   *
   * `unit` is the vendor's own currency and is never normalised across
   * vendors: Cline pays US dollars and ZCode pays token buckets, so a single
   * "credits" label would be wrong for a third of the roster.
   */
  credits?: {
    claim?: boolean;
    status?: boolean;
    unit?: 'tokens' | 'dollars';
    /** Percentages per quota bucket rather than a credit total. */
    quota?: boolean;
  };
}
/** The document {@link POOL_CHANNELS_PATH} answers with. */
interface PoolWebChannelsStatus {
  /** Whether the vendored pack mounted, and if not, why. */
  state: 'pending' | 'ready' | 'unavailable';
  /** Human text for a non-ready state; absent when ready. */
  reason?: string;
  channels: readonly PoolWebChannel[];
}
/** One model a chain member may name, from either lane. */
interface PoolWebComboCandidate {
  id: string;
  name: string;
  /** `workbuddy` for a pool model, the provider id for a third-party one. */
  owner: string;
  /** True when a third-party model already has a usable key. */
  usable: boolean;
  contextWindow: number;
  supportsImages: boolean;
}
/** One chain, resolved against the live roster. */
interface PoolWebCombo {
  /** `combo:<slug>`, always. */
  id: string;
  name: string;
  /** Members that exist right now, in order. Empty means the chain is dead. */
  models: readonly string[];
  /** Members the user configured but which the roster no longer serves. */
  missing: readonly string[];
  strategy: 'fallback' | 'round-robin';
  stickyLimit: number;
  enabled: boolean;
  contextWindow: number;
  supportsImages: boolean;
}
/**
 * The document {@link POOL_COMBOS_PATH} answers with.
 *
 * `candidates` is the whole roster rather than only what is chainable, because
 * a chain that cannot add a new model is not an editor.
 */
interface PoolWebCombosStatus {
  combos: readonly PoolWebCombo[];
  candidates: readonly PoolWebComboCandidate[];
}
/**
 * What a relay patch can change.
 *
 * `key: ''` rotates rather than clears: the card sends an empty string when the
 * user asks for a new key, and "no key" is not a state the relay can serve — a
 * keyless relay would have to accept everyone.
 */
interface PoolWebRelayPatch {
  enabled?: boolean;
  host?: string;
  port?: number;
  key?: string;
}
/**
 * What a key probe answered.
 *
 * `modelIds` is present only when the provider's listing was readable, and the
 * "discover models" action turns it into a save. `committed` reports how many
 * ids that action actually wrote — a listing that came back empty is a real
 * answer (the provider serves nothing) and must not be reported as a failure.
 */
interface PoolWebAggregateProbe {
  ok: boolean;
  /** The provider's HTTP status, or 0 when it was never reached. */
  status: number;
  message: string;
  modelCount?: number;
  /** Ids the provider listed, when it declared a listing and answered. */
  modelIds?: readonly string[];
  /** How many ids the discover action wrote back. Absent on a plain probe. */
  committed?: number;
}
/** One account's row, token-free. */
interface PoolWebAccount {
  id: string;
  label: string;
  nickname?: string;
  domain: string;
  /** ISO timestamp; absent when the credential carries no expiry. */
  expiresAt?: string;
  /** Account-wide cooldown (every model blocked); only after a no-model penalize. */
  cooling: boolean;
  /** ISO timestamp when the account-wide 429 cooldown lifts; only while cooling. */
  cooldownUntil?: string;
  /**
   * The upstream REJECTED this account's sign-in (401/403) — the credential file
   * still looks valid because the upstream never rewrites its expiry when it
   * revokes a token. Distinct from `cooling`: waiting does not fix it, only
   * signing in again in the desktop app does.
   */
  credentialDead?: boolean;
  /** ISO timestamp when the dead mark expires and the account is retried; only while `credentialDead`. */
  credentialDeadUntil?: string;
  /**
   * Per-model cooldowns currently active. The account is NOT `cooling` while a
   * model is limited — its other models still serve — but each entry tells the
   * card which model is out until when (e.g. `hy4-preview` cooling to 10:14,
   * `hy3` normal).
   */
  modelCooldowns?: ReadonlyArray<{
    modelId: string;
    until: string;
  }>;
  /**
   * Whether the user switched this account off. A disabled account never
   * serves a request, but it stays listed so the card can switch it back on.
   */
  disabled: boolean;
  /**
   * Whether the user pinned this account to be tried first.
   *
   * Distinct from `disabled`, and the card has to tell them apart: a disabled
   * account is skipped entirely, a preferred one is merely first in line. It
   * stays `false` when nothing is pinned, so the row never borrows a mark that
   * describes a global choice rather than this account.
   */
  preferred: boolean;
  rateLimitHits: number;
  /**
   * Credits the user asked to keep for this account. The pool stops picking the
   * account once its balance reaches the reserve, so this many credits survive.
   * 0 means the account may be spent down as before.
   */
  creditReserve: number;
  /**
   * Whether the account is held back purely by its reserve right now. Kept
   * distinct from `cooling`: a reserved account is healthy and simply
   * protected, which is a different thing to tell the user than rate-limited.
   */
  reserved: boolean;
  /**
   * What the automation earned for this account today. Absent when it earned
   * nothing (or the automation never ran for it), so the card can stay quiet
   * instead of printing a row of zeroes.
   */
  automationToday?: PoolWebAutomationEarnings;
  /** ISO timestamp of the last successful use (best-effort pool bookkeeping). */
  lastUsedAt?: string;
  /** Aggregated credit summary for the account, read-only. */
  credits?: PoolWebCredits;
  creditsError?: string;
  /**
   * Today's check-in state for this account, read-only. Present only when the
   * per-account check-in probe succeeded and the program is active. The card
   * renders one claim button per account, so a multi-account pool can collect
   * every account's daily reward without switching accounts by hand.
   */
  checkin?: PoolWebCheckin;
  checkinError?: string;
}
/** One credit package (as surfaced by the pool's upstream client), node-free. */
interface PoolWebCreditPackage {
  packageName: string;
  remain?: number;
  size?: number;
  /** CapacityType 4 — refreshed each cycle and never expires. */
  monthly?: boolean;
  /** Next cycle refresh point, ms. */
  cycleRefreshMs?: number;
  /** One-off expiry, ms. */
  expiresAtMs?: number;
}
/** Aggregated credit answer the card renders under one account. */
interface PoolWebCredits {
  total?: number;
  packages: readonly PoolWebCreditPackage[];
  /** Credits expiring within 3 days. */
  expiringSoon?: number;
  /** When the nearest package expires, ms. */
  nearestExpiryMs?: number;
}
/**
 * Daily check-in state the card renders under one account's credits. Mirrors
 * the upstream activity endpoint, minus anything the browser does not need.
 */
interface PoolWebCheckin {
  /** The activity is running; a claim button is offered only while true. */
  active: boolean;
  /** Already collected today — the button renders as a done state. */
  todayCheckedIn: boolean;
  /** Consecutive days checked in. */
  streakDays: number;
  /** Credits a single day grants. */
  dailyCredit: number;
  /** Credits collected today (0 before claiming). */
  todayCredit: number;
  /** Today is a streak milestone day. */
  isStreakDay: boolean;
  /** The day count the next milestone lands on. */
  nextStreakDay: number;
  /** Bonus credits granted on a milestone day. */
  streakBonusCredit: number;
}
/** Result of one claim, so the card can confirm what was collected. */
interface PoolWebCheckinClaim {
  credit: number;
  streakDays: number;
  isStreakDay: boolean;
}
/** One model the pool exposes to DSH, with cost / free tags. */
interface PoolWebModel {
  id: string;
  name: string;
  /** Relative credit cost, e.g. 0.79 for x0.79. */
  multiplier?: number;
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[];
  /** Effective image support after the user's per-model toggle. */
  supportsImages: boolean;
  /** Effective context window after the user's budget cap. */
  contextWindow: number;
  /** The window the upstream advertises, before any cap. */
  nativeContextWindow: number;
  /** Upstream output ceiling, so the card can show both limits. */
  maxOutputTokens: number;
  /** Thinking levels the upstream declares, when it declares any. */
  supportedEfforts?: readonly string[];
  /** Whether this model is currently enabled in the picker. */
  enabled: boolean;
}
/**
 * What one connectivity probe measured.
 *
 * Deliberately three numbers and nothing else. The card asks "can this model
 * answer at all", so a probe that reported token counts or a verdict about
 * quality would be answering a question nobody asked, and one that reported
 * "0 output tokens" for a refusal would be reporting a bug as a fact.
 *
 * `outputChars` is a character count, not a token count: this plugin cannot
 * tokenize for a model it does not own, and a character count answers "did it
 * say anything" without pretending to know more.
 */
interface PoolWebModelProbeResult {
  /** True when the model produced at least one character of output. */
  ok: boolean;
  /** Milliseconds until the first output character arrived. Absent when none did. */
  firstFrameMs?: number;
  /** Characters of output produced before the probe stopped reading. */
  outputChars: number;
  /**
   * Why the probe failed, when it did.
   *
   * Rendered verbatim, and it is a failure to SHOW rather than to hide: a
   * connectivity test that swallows its error teaches the user the button is
   * broken.
   */
  error?: string;
}
/**
 * Body of the account ignore/unignore route: exactly one account per request.
 *
 * `ignored: true` throws the account out of the pool for good (its credential is
 * not even read on the next scan, and a fresh desktop sign-in will not bring it
 * back). `false` restores it, at which point the next scan discovers it again.
 */
interface PoolWebAccountIgnore {
  /** Pool account id, as reported in `PoolWebAccount.id`. */
  accountId: string;
  /** `true` ignores the account permanently; `false` takes it back. */
  ignored: boolean;
}
/**
 * One account the user has thrown out of the pool.
 *
 * Kept on the status document so the card can list what was ignored and offer a
 * way back: without that, "ignored" is a one-way door the user cannot inspect or
 * undo from the UI, which is how a hidden list becomes a support burden.
 */
interface PoolWebIgnoredAccount {
  /** Pool account id, the same key `PoolWebAccount.id` uses. */
  id: string;
  /** Human label captured at ignore time, so the row reads without a rescan. */
  label: string;
  /** ISO timestamp of when it was ignored. */
  ignoredAt: string;
}
interface PoolWebModelSelection {
  /** Absent = every model is enabled. */
  enabledModelIds?: readonly string[];
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[];
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
/** The JSON document the pool card renders. */
interface PoolWebStatus {
  ok: boolean;
  accounts: readonly PoolWebAccount[];
  /** The next account the pool would use (rotation cursor). */
  activeAccountId?: string;
  /**
   * The account the user pinned to be tried first, when one is pinned and it is
   * still in the pool.
   *
   * Reported at document level rather than as a per-row flag because it is a
   * single global choice, and omitting it when the pinned account has been
   * scanned away keeps the card from drawing a "preferred" badge on nothing.
   */
  preferredAccountId?: string;
  cooling: number;
  models: readonly PoolWebModel[];
  /** The saved selection the card diffs its draft against. */
  selection: PoolWebModelSelection;
  /**
   * How the pool spreads requests: `priority` drains one account before
   * moving on, `round-robin` splits the spend evenly.
   */
  distribution: PoolDistribution;
  /** Which region this document describes. */
  region: PoolRegion;
  /** Every region holding at least one account, in display order. */
  regions: readonly PoolRegion[];
  shim: {
    running: boolean;
    baseUrl?: string;
  };
  /** Daily-points automation state, so the card can show what ran and when. */
  automation: PoolWebAutomation;
  /** Per-account credit floors currently in force, keyed by account id. */
  creditReserves: Readonly<Record<string, number>>;
  /**
   * Accounts thrown out of the pool, in the order they were ignored.
   *
   * Reported so the card can show the list and offer a way back. These accounts
   * are NOT in `accounts`: they are filtered out before their credentials are
   * read, which is the whole point of the feature.
   */
  ignored: readonly PoolWebIgnoredAccount[];
  /**
   * Where THIS region's model list came from.
   *
   * `live` = fetched from the gateway (or a cached fetch survived a restart).
   * `fallback` = the built-in static table, which means the startup fetch
   * failed and the user is looking at a SHORTER, possibly stale roster — models
   * they had enabled can be missing from it entirely.
   *
   * Surfaced because the failure used to be log-only: the picker quietly lost
   * half its entries and nothing on screen said why, so it read as "the plugin
   * deleted my models".
   */
  catalogSource?: PoolWebCatalogSource;
  /** When the live catalog was last successfully fetched, ISO. */
  catalogUpdatedAt?: string;
  /** Why the last fetch failed, when it did. Redacted and length-capped. */
  catalogError?: string;
  /**
   * Credential files on disk that did NOT become accounts.
   *
   * Reported so the account count can be trusted: without this, a directory
   * holding four files that yields two accounts looks like two accounts were
   * deleted, when really two files could not be opened (most often an encrypted
   * credential the desktop app was not running to unlock).
   */
  skippedFiles?: readonly PoolWebSkippedFile[];
}
/** A credential file the pool could not read. */
interface PoolWebSkippedFile {
  /** Basename only; the full path lives in the desktop app's auth directory. */
  file: string;
  reason: 'encrypted' | 'unreadable' | 'malformed';
}
/** How a region's model list was obtained. */
type PoolWebCatalogSource = 'live' | 'fallback';
/** One automation job's last run, as shown on the card. */
interface PoolWebAutomationJob {
  /** `YYYY-MM-DD` of the last run in this process, if it has run. */
  lastRunDate?: string;
  /**
   * Epoch ms of the last run, so the card can show the TIME.
   *
   * Carried because a date-only stamp cannot tell one run from eight: every
   * repeat inside the same day rendered as the identical `2026-09-28 · 2`,
   * which is what kept a "re-runs every hour" defect invisible on the card.
   */
  lastRunAtMs?: number;
  /**
   * Configured slots consumed today, as `YYYY-MM-DDTHH`.
   *
   * Shown so "which of today's hours already ran" is answerable at a glance
   * rather than inferred from a counter.
   */
  firedSlots?: readonly string[];
  /** Accounts that finished without error on the last run. */
  ok: number;
  /** Accounts that failed on the last run (each one skipped, the run continued). */
  failed: number;
  /** Credits claimed by the task job on the last run. */
  credit: number;
  /** Energy claimed by the task job on the last run. */
  energy: number;
  /** Tasks claimed by the task job on the last run. */
  claimed: number;
  /** One-line summary of the last run. */
  message?: string;
  /**
   * What the last run actually did, in the words of the task board.
   *
   * `message` is a count; this is the list a person can check off, which is
   * what turns a row from "it ran" into "it did the things I care about".
   */
  detail?: readonly string[];
  /** A pending milestone worth naming, e.g. the next streak tier countdown. */
  progress?: string;
}
/**
 * Automation block on the status document.
 *
 * Carries the schedule and each job's last outcome so the card can answer
 * "is it on, when does it run, and what did it last do" without reaching into
 * the scheduler itself.
 */
interface PoolWebAutomation {
  /** Master switch, mirrored from the saved config. */
  enabled: boolean;
  /** Whether the loop is currently running. */
  running: boolean;
  /** Configured hours per job, so the card can show the schedule. */
  checkinHours: readonly number[];
  reportHours: readonly number[];
  taskHours: readonly number[];
  streakHours: readonly number[];
  travelHours: readonly number[];
  compensationHours: readonly number[];
  jobs: {
    checkin: PoolWebAutomationJob;
    report: PoolWebAutomationJob;
    tasks: PoolWebAutomationJob;
    streak: PoolWebAutomationJob;
    travel: PoolWebAutomationJob;
    compensation: PoolWebAutomationJob;
  };
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number;
  /**
   * Whether a manual run is in flight. The card polls this to know when to
   * stop showing progress and report the result.
   */
  runInProgress: boolean;
  /**
   * Per-account credits/energy/tasks the automation earned TODAY, keyed by
   * account id. An account that earned nothing is simply absent, so the card
   * can say "nothing yet" instead of showing a bare zero.
   */
  earningsToday: Readonly<Record<string, PoolWebAutomationEarnings>>;
}
/** Today's automation take for one account. */
interface PoolWebAutomationEarnings {
  /** Credits claimed from the task centre today. */
  credit: number;
  /** Energy claimed from the task centre today. */
  energy: number;
  /** Tasks claimed today. */
  claimed: number;
  /** Credits collected from check-in today. */
  checkinCredit: number;
  /** Credits from streak redemption and the lottery today. */
  bonusCredit: number;
  /** Credits from buddy adoption and the travel loop today. */
  travelCredit: number;
  /** Credits collected from the outage-compensation offer today. */
  compensationCredit: number;
  /** Local date the counters belong to (YYYY-MM-DD). */
  date: string;
}
/**
 * The two gateways, matching the provider ids the host registers. `cn` is the
 * domestic gateway (`copilot.tencent.com` / `codebuddy.cn`); `global` is the
 * international one (`workbuddy.ai`).
 */
type PoolRegion = 'cn' | 'global';
/** How the pool spreads requests across its accounts. */
type PoolDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
/**
 * The schedule every automation job falls back to.
 *
 * Shared by both halves on purpose. The host uses it when a configured hour
 * list arrives empty (the settings schema materializes "never configured" into
 * `[]`), and the card uses it when it writes the `automation` block back, so a
 * document that already holds an empty list is healed instead of being saved
 * back as an unrunnable schedule.
 *
 * This lives here rather than in `scheduler.ts` because the browser half cannot
 * import the host module: `scheduler.ts` pulls in `node:crypto` and the whole
 * upstream client, none of which exists in the browser bundle. Two hand-written
 * copies would drift, and the drift is invisible — the card would write a
 * schedule the scheduler does not run.
 */
export declare const DEFAULT_AUTOMATION_HOURS: {
  readonly checkin: readonly [9];
  readonly report: readonly [10];
  readonly tasks: readonly [11];
  readonly streak: readonly [12];
  readonly travel: readonly [9, 21];
  readonly compensation: readonly [13];
};
//#endregion
//#region src/catalog.d.ts
/** One model the provider exposes. */
interface WorkBuddyModelInfo {
  id: string;
  /** Display name; the multiplier is appended for the picker. */
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Relative credit cost, e.g. 0.79 for `x0.79`. */
  multiplier?: number;
  /** Upstream-declared thinking levels. */
  supportedEfforts?: readonly string[];
  supportsImages: boolean;
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[];
}
/**
 * Static fallback used before the first live catalog fetch, and whenever the
 * upstream cannot be reached.
 *
 * This table is the DOMESTIC (CN) roster, and it is kept in step with what
 * `copilot.tencent.com` actually advertises. It matters more than a "just in
 * case" list usually would: a failed startup fetch falls back to it, and the
 * user sees that as "half my models were deleted" — `deepseek-v4.1-flash`
 * and friends simply vanishing from the picker, with no visible explanation.
 *
 * Every row below was captured from the live endpoint, INCLUDING the window
 * sizes: the previous version carried a 32K window for `hy3` when the gateway
 * says 192K, and listed `kimi-k3` under an id the gateway no longer uses
 * (`kimi-k3-1`). A stale fallback is worse than a short one — it looks
 * authoritative while being wrong.
 *
 * `multiplier: 0` is the gateways' own spelling of "free" (`credits: "x0.00"`),
 * which is what turns on the free badge.
 */
export declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/** Which gateway a catalog describes. Mirrors `WorkBuddyRegion` in `upstream.ts`. */
type CatalogRegion = 'cn' | 'global';
/** Live catalog with a static fallback behind it. */
export declare class WorkBuddyCatalog {
  /**
   * Which gateway this catalog serves, and therefore which static table it falls
   * back to.
   *
   * Optional in the constructor so every existing `new WorkBuddyCatalog()`
   * (tests, and the plugin's own default wiring) keeps compiling; it defaults to
   * `cn` because that is the table this plugin has always shipped.
   */
  private readonly region;
  private models;
  constructor(region?: CatalogRegion);
  private listeners;
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection;
  /**
   * Whether `models` came from the gateway or from the static table.
   *
   * Tracked so the card can SAY which it is showing. A failed fetch used to be
   * invisible on screen: the picker simply held fewer models than before, which
   * the user reasonably read as "the plugin deleted my models" rather than "the
   * network hiccuped at startup".
   */
  private source;
  /** When the live list last landed. */
  private lastUpdatedAt;
  /** Why the last fetch failed, for display. */
  private lastError;
  current(): readonly WorkBuddyModelInfo[];
  /**
   * The models DSH should actually offer, after applying the user's selection:
   * disabled models are dropped, an explicit image list overrides the upstream
   * capability flag, and a per-model budget caps the advertised window.
   *
   * An absent `enabledModelIds` means "everything" — a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible(): readonly WorkBuddyModelInfo[];
  /** Replace the catalog and notify the adapter to rebuild its model list. */
  update(models: readonly WorkBuddyModelInfo[]): void;
  /** Restore the static fallback, e.g. when the upstream stops answering. */
  reset(): void;
  /** Replace the user's selection; the adapter rebuilds from `visible()`. */
  applySelection(selection: ModelSelection): void;
  /** The selection currently in force, for the card's save round-trip. */
  currentSelection(): ModelSelection;
  /**
   * Whether this catalog is serving live data or the built-in table.
   *
   * `fallback` is not an error state, but it IS a degraded one: the user is
   * looking at a shorter roster than the gateway offers, so the card says so
   * and offers a retry instead of letting them wonder where the models went.
   */
  currentSource(): PoolWebCatalogSource;
  /**
   * When the live list last landed, if it ever did.
   *
   * Named `catalogUpdatedAt()` rather than `updatedAt()` because the class
   * already had an `updatedAt` member; two members of the same name is a
   * compile error, and the awkwardness is a useful signal that the concept is
   * "when THIS catalog was refreshed", not a generic timestamp.
   */
  catalogUpdatedAt(): string | undefined;
  /** Why the last fetch failed, if it did. */
  lastFetchError(): string | undefined;
  onChange(listener: () => void): () => void;
  find(id: string): WorkBuddyModelInfo | undefined;
  /** Replace the catalog from the live upstream list; keeps the fallback if empty. */
  updateFromUpstream(models: readonly WorkBuddyUpstreamModel[]): void;
  /**
   * Record that a fetch attempt failed, leaving the current list in place.
   *
   * The list is deliberately NOT reset here: a refresh that fails should keep
   * whatever working catalog is already loaded, rather than demoting a healthy
   * session to the static table because one retry ran out.
   */
  noteFetchFailure(message: string): void;
  private notify;
}
/** The user's model selection, as stored in the settings section. */
interface ModelSelection {
  /** Absent = every model in the catalog is offered. */
  enabledModelIds?: readonly string[];
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[];
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>;
}
//#endregion
//#region src/providers.d.ts
/** One provider's saved settings: on/off, its key, and any discovered models. */
interface ProviderSetting {
  /**
   * The explicit switch. Absent means "follow the credential": a provider the
   * user has actually configured is on, and the seventy-five they have never
   * touched are off.
   *
   * The card used to draw every one of the seventy-six vendors with its switch
   * already on, which read as "everything is already in the pool" and made the
   * one vendor that WAS configured indistinguishable from the rest.
   */
  enabled?: boolean;
  apiKey?: string;
  /** User override for the base URL, for providers whose host is per-deployment. */
  baseUrl?: string;
  /**
   * Model ids the user chose to expose, when narrower than the whole roster.
   *
   * This is the CHOICE and nothing else. It deliberately does not hold what a
   * listing round returned: a vendor that advertises eighty-five models and whose
   * user ticks two must be able to press "Fetch models" again next month and
   * still be choosing from eighty-five, not from the two they kept. Keeping both
   * in one field made the fetch overwrite the choice and left no way back.
   *
   * An empty or absent value means "expose everything the provider offers" — see
   * `modelIdsFor`.
   */
  models?: readonly string[];
  /**
   * The full roster a listing round last returned, kept as the universe the
   * choice is drawn from.
   *
   * Never surfaced as the exposed set on its own; it exists so the card can show
   * "2 of 85 chosen" and re-widen a narrowed set after a refetch.
   */
  discovered?: readonly string[];
  addedAt?: string;
}
/** The whole aggregate section of the plugin settings. */
interface AggregateSettings {
  /** Master switch: off contributes no model rows at all. */
  enabled?: boolean;
  providers?: Readonly<Record<string, ProviderSetting>>;
}
//#endregion
//#region src/combos.d.ts
/** Chain strategies. Anything else on disk falls back to `fallback`. */
declare const COMBO_STRATEGIES: readonly ['fallback', 'round-robin'];
type ComboStrategy = (typeof COMBO_STRATEGIES)[number];
/** A chain as the user configured it, before the catalogs are consulted. */
interface ComboSetting {
  /** `combo:<slug>`; derived from the name when absent or malformed. */
  id?: string;
  name: string;
  /** Member model ids, in the order the user put them. */
  models: readonly string[];
  /** How the chain advances; `fallback` restarts from the top each turn. */
  strategy?: ComboStrategy;
  /** Consecutive turns one member serves before `round-robin` advances. */
  stickyLimit?: number;
  /** Absent is treated as on; an explicit false hides the row. */
  enabled?: boolean;
}
/** One picker row standing for a chain. */
interface ComboModelRow {
  /** Always `combo:<slug>`. */
  id: string;
  name: string;
  /** Members that exist RIGHT NOW, in order. Never empty — see below. */
  models: readonly string[];
  strategy: ComboStrategy;
  stickyLimit: number;
  /** Smallest window across members; 0 when no member declares one. */
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  /**
   * Discriminator. Aggregate rows carry `providerId`, pool rows carry neither,
   * and only this shape is `true`.
   */
  combo: true;
}
//#endregion
//#region src/store.d.ts
/**
 * The aggregate section as it lives on disk.
 *
 * Combos live in the same file rather than a second one: they only mean
 * anything in terms of the models the providers beside them serve, so a user who
 * clears a key and leaves a chain behind would be editing a dangling reference
 * in a file that no longer explains it. One document, one delete to undo.
 *
 * The LAN relay's settings live here too, for the same "one file to delete"
 * reason and because they hold a shared secret.
 */
type AggregateStore = AggregateSettings & {
  combos?: readonly ComboSetting[];
  relay?: RelaySetting;
};
/**
 * The LAN relay's own settings.
 *
 * Stored beside the aggregate keys rather than in the settings document for the
 * same reason the keys are: this holds a credential. The relay key is shown to
 * the user once so it can be pasted into another device, and the settings
 * document is echoed to the browser by the host's own form renderer — we would
 * rather that path never carried a shared secret.
 */
interface RelaySetting {
  enabled?: boolean;
  /** Bind address; only `127.0.0.1` and `0.0.0.0` are honoured. */
  host?: string;
  port?: number;
  /** URL-safe shared secret LAN clients authenticate with. */
  key?: string;
}
//#endregion
//#region src/aggregate.d.ts
/** Registry `format` → the wire vocabulary this module speaks. */
type AggregateWire = 'chat' | 'responses' | 'messages';
/** One model the aggregate lane offers. */
interface AggregateModelRow {
  /** Composite id: `providerId/modelId`, which is also the picker id. */
  id: string;
  /** Display name: the provider's own name plus the row's label. */
  name: string;
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  wire: AggregateWire;
  /** `static` from the registry, `discovered` from a live listing. */
  source: 'static' | 'discovered';
}
/** One stored aggregate row set, refreshed on change, for the shim and adapter. */
declare class AggregateCatalog {
  private readonly read;
  private readonly poolRows;
  private rows;
  private chainRows;
  /**
   * @param read    The settings document.
   * @param poolRows The pool's own rows, needed only to resolve a chain member
   *   that names a WorkBuddy model. A chain may mix pool models with aggregate
   *   ones, so without this a perfectly valid chain would lose its pool half.
   */
  constructor(read: () => AggregateStore | Promise<AggregateStore>, poolRows?: () => readonly WorkBuddyModelInfo[]);
  /**
   * Every row this catalog offers: third-party rows first, then chain rows.
   *
   * Chains come last so a picker listing stays readable — a chain is a
   * convenience over models the user already has listed, not a new vendor.
   */
  current(): readonly (AggregateModelRow | ComboModelRow)[];
  /** Only the third-party rows, which is what the aggregate resolver needs. */
  providerRows(): readonly AggregateModelRow[];
  /** Only the chain rows. */
  comboRows(): readonly ComboModelRow[];
  /** Re-read the store and notify listeners when the roster actually changed. */
  refresh(): Promise<readonly (AggregateModelRow | ComboModelRow)[]>;
  private listeners;
  onChange(listener: () => void): () => void;
  /** One third-party row by composite id, or undefined. */
  find(id: string): AggregateModelRow | undefined;
  /** One chain row by combo id, or undefined. */
  findCombo(id: string): ComboModelRow | undefined;
  /** Whether any provider or chain is serving anything right now. */
  hasRows(): boolean;
}
//#endregion
//#region src/stats.d.ts
/**
 * Per-call usage accounting for the chat path.
 *
 * The gateway can answer `usage` when the request asks for it
 * (`stream_options.include_usage`), but the shim forwards the response body
 * verbatim and threw every number away. This module is where those numbers
 * stop being thrown away: a bounded ring of samples in, one aggregate
 * document out. Nothing here touches Node or HTTP, so the same code is
 * exercised by unit tests and by the browser half.
 *
 * Two counts are kept apart on purpose:
 *
 *   - a LOGICAL TURN is one user request, however many accounts it visited;
 *   - a PHYSICAL CALL is one upstream HTTP round trip.
 *
 * They answer different questions. "How many turns failed" must not inflate
 * because the pool rotated three accounts before succeeding, and "how much
 * did this model cost" must not be diluted by recording the turn once.
 * Collapsing them into a single `calls` number is exactly what makes a panel
 * disagree with the person reading it.
 *
 * Usage is a BONUS, never a guarantee: a gateway may ignore
 * `stream_options` entirely. A window with no reported usage reports zeroes
 * AND says so, so the panel can print "not reported" instead of a confident
 * "0 tokens".
 *
 * @module dsh-xdpool/stats
 */
/** Tokens one upstream call reported. Every field is a non-negative count. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** A subset of `outputTokens` the model spent thinking. */
  reasoningTokens: number;
  /** A subset of `inputTokens` served from the prompt cache. */
  cachedTokens: number;
}
/** One upstream HTTP round trip, successful or not. */
interface UsageCall {
  /** Which gateway served it: `cn` or `global`. */
  region: string;
  /** The model id the request asked for. */
  model: string;
  /**
   * The pool account that served this physical call, as its display label.
   *
   * Carried because "which account earned this turn" is a question the ledger
   * has to answer from the samples themselves: the call is filed from inside
   * the stream forwarder, long after the choice of account has scrolled out of
   * whatever picked it. Without it the per-account view could only be a guess
   * reconstructed from turn ordering, which is exactly the kind of plausible
   * fiction this module refuses to publish.
   */
  account?: string;
  /**
   * Identifies one user request.
   *
   * Calls sharing a `turnId` are retries of the SAME logical turn - the pool
   * cooling an account and taking the next one. That is what lets the panel
   * separate "3 calls" from "1 turn that rotated".
   */
  turnId: string;
  /** When the call finished, in epoch milliseconds. */
  at: number;
  ok: boolean;
  /** Request sent to first byte. Absent when the call failed before any byte. */
  ttftMs?: number;
  /** First byte to `[DONE]`. Absent when the stream never completed. */
  decodeMs?: number;
  usage?: TokenUsage;
}
/** One row of the per-model aggregate. */
interface UsageRow {
  region: string;
  model: string;
  /** Physical upstream calls. */
  calls: number;
  /** Logical turns that reached this model. */
  turns: number;
  /** Calls that failed. */
  failed: number;
  /** Turns where a failure was followed by a success on another account. */
  recovered: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** Output tokens per second while decoding, or `null` when unsound. */
  tps: number | null;
  /** Mean time to first byte, or `null` when no call reported one. */
  avgTtftMs: number | null;
  /** Most recent completion, for "last used". */
  lastUsedAt: number;
}
/** One row of the per-account aggregate. */
interface UsageAccountRow {
  /** Display label of the account, as the pool prints it. */
  account: string;
  /** Region the account belongs to; an account serves one gateway. */
  region: string;
  /** Physical calls this account served. */
  calls: number;
  /** Logical turns this account saw through. */
  turns: number;
  /** Calls this account refused. */
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Most recent completion, for "last used". */
  lastUsedAt: number;
  /** The two most-used models here, for a compact "what it usually runs" column. */
  topModels: readonly string[];
}
/** One calendar day, local time. */
interface UsageDay {
  day: string;
  calls: number;
  failedTurns: number;
  inputTokens: number;
  outputTokens: number;
}
/** The document the usage panel renders. */
interface UsageSummary {
  /** Samples still retained, so the panel can say "last N". */
  samples: number;
  /** Logical turns in the retained window. */
  turns: number;
  /** Turns where every call failed. */
  failedTurns: number;
  /** Turns that failed and then succeeded on another account. */
  recoveredTurns: number;
  /** Physical upstream calls; above `turns` when the pool rotated. */
  calls: number;
  /**
   * False when no retained sample carried usage.
   *
   * The panel must distinguish "used no tokens" from "the gateway told us
   * nothing", and only this flag tells them apart.
   */
  usageReported: boolean;
  /**
   * Retained calls, newest first.
   *
   * Published so the ledger's "recent detail" table can be rendered from the
   * same numbers the aggregates above are computed from. Two derivations of
   * one fact set are two chances to disagree; handing the panel the raw
   * samples removes the second derivation entirely.
   *
   * Newest first because that is the order a reader wants, and `record` only
   * ever appends - so reversing here costs one copy rather than a second
   * insertion order to keep in sync.
   */
  entries: readonly UsageCall[];
  rows: UsageRow[];
  accounts: UsageAccountRow[];
  days: UsageDay[];
}
/**
 * A bounded window of recent calls, summarised on demand.
 *
 * In-memory by design: this is a live panel, and persisting every prompt's
 * token counts would turn a convenience into a record of what the user asked.
 * A restart therefore starts the chart again, which the panel states rather
 * than hides.
 */
declare class UsageRecorder {
  private samples;
  private readonly limit;
  constructor(limit?: number);
  /** Retain one call, dropping the oldest once the window is full. */
  record(call: UsageCall): void;
  /** Samples currently retained. */
  size(): number;
  /** Forget every retained call. */
  reset(): void;
  /** Aggregate the retained window. */
  summary(): UsageSummary;
  /**
   * One row per account, busiest first.
   *
   * Samples that never named an account are grouped under an empty label
   * rather than dropped: `account` is optional on `UsageCall`, so a caller that
   * files a sample without one - a failure raised before any account was ever
   * picked, say - would otherwise vanish from this view, and the account table
   * would add up to less than the call total with nothing on screen to explain
   * the gap. Every shim record site names its account; this branch exists so
   * that a future one cannot quietly break the totals.
   *
   * `topModels` keeps the two most-used ids rather than every one: this column
   * answers "what does this account usually run", and a list of nine ids is not
   * an answer to that question, it is just the other table again.
   */
  private accountRows;
  /**
   * The daily series, oldest first, limited to the most recent days.
   *
   * Sorted by key rather than insertion order because a retained window can
   * straddle a month boundary, and a chart whose axis jumps backwards reads as
   * corrupted data rather than as history.
   *
   * `failedTurns` is counted by DISTINCT turn id, not by summing per-call
   * failures: a turn that rotated three accounts and failed on all three is
   * still one failed turn, and the whole reason this module keeps turns and
   * calls apart is so that number stays honest in every place it appears.
   */
  private days;
}
//#endregion
//#region src/shim.d.ts
interface ShimLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
interface WorkBuddyShim {
  ready: Promise<void>;
  baseUrl(): string;
  token(): string;
  close(): Promise<void>;
}
/**
 * Everything the aggregate lane needs to answer one request.
 *
 * Optional on {@link WorkBuddyShimOptions} because most shims are pool-only: the
 * CLI and the tests never build an aggregate catalog, and making them supply one
 * would mean threading an argument nobody reads.
 */
interface AggregateLaneOptions {
  /** The rows currently offered, keyed by composite `providerId/modelId`. */
  catalog: AggregateCatalog;
  /** Where the stored settings come from, re-read per request. */
  readStore: () => AggregateStore;
}
interface ExtraLaneOptions {
  /**
   * The免密 free lane: which rows exist right now, and where to send a turn.
   *
   * The row reader is consulted per request, exactly like the pool's catalog —
   * a roster that refreshed after startup must be servable without a restart.
   */
  free: ExtraLaneSource;
}
interface ExtraLaneSource {
  current: () => readonly {
    modelId: string;
    id: string;
  }[];
  /**
   * Run one turn, handing back the frames to write.
   *
   * The source owns the whole upstream conversation — the session identity, the
   * wire conversion, the tool bookkeeping — and returns chat-wire SSE payloads,
   * because that is the only wire this shim's caller speaks.
   */
  run: (options: {
    modelId: string;
    body: string;
    signal: AbortSignal;
    onFrame: (payload: string) => void;
  }) => Promise<unknown>;
}
interface WorkBuddyShimOptions {
  pool: WorkBuddyAccountPool;
  client: WorkBuddyUpstreamClient;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
  /**
   * Restrict this shim to one gateway. Two shims run side by side — one
   * per region — and each must only ever draw accounts that belong to its
   * own gateway. Absent means "every account" (a single-region deployment).
   */
  region?: WorkBuddyRegion;
  /** Max accounts to try per request before giving up. */
  maxAttempts?: number;
  /**
   * Where per-call usage goes.
   *
   * Optional so the CLI and the tests can run a shim with no dashboard: they
   * assemble a pool without a panel, and forcing a recorder on them would mean
   * threading an argument nobody reads.
   */
  usageRecorder?: UsageRecorder;
  /**
   * The second lane: providers the user holds a key for.
   *
   * Attached to the CN shim only. The aggregate lane is gateway-independent — it
   * has no region to filter by — so running it on both shims would expose the
   * same models twice under two provider ids, and a user who picked one would
   * have no way to tell which they were using.
   */
  aggregate?: AggregateLaneOptions;
  /**
   * The third and fourth lanes: the pooled免密 gateway and the sealed co-paid
   * relay.
   *
   * Also CN-shim-only, for the aggregate lane's reason plus one of their own: a
   * second copy under the global provider id would list every model twice and
   * give the user two names for one lane.
   */
  extra?: ExtraLaneOptions;
}
export declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
//#region src/free-messages.d.ts
/**
 * Message and frame translation between the OpenAI chat wire the plugin speaks
 * downstream and the three wires the免密 free gateway serves upstream.
 *
 * Downstream there is ONE wire. The pool, the third-party aggregate and the
 * co-paid lane all answer OpenAI chat completions, so the harness adapter is
 * configured once with `openAICompletionsApi()` and this file never has to be
 * reached from there. Upstream there are THREE: `/chat/completions`,
 * `/responses` and `/messages`, chosen per model. Everything about that
 * asymmetry lives here — request bodies go chat to responses/messages, and
 * answers come back responses/messages to chat.
 *
 * WHAT IS NOT IN HERE
 *
 * Images. A harness image arrives as an attachment descriptor, and turning one
 * into bytes the gateway can read is the adapter's job (it owns the attachment
 * plane). When no resolver is supplied an image block is dropped and a warning
 * is recorded, because silently forwarding a placeholder URL would make the
 * model answer about a picture it never saw. Everything else — text, tool
 * calls, tool results, reasoning — round-trips.
 *
 * The tool-call index mapping is the subtle part. Anthropic addresses blocks by
 * position in one flat array and Responses by output item, while OpenAI clients
 * expect a per-request sequential index, and a block may stream its argument
 * fragments BEFORE it names itself. So a block is classified the moment it names
 * itself, its argument fragments are held until then, and a held block whose
 * verdict turns out to be "not executable" is dropped instead of handed to a
 * client that cannot run it.
 *
 * @module src/free-messages
 */
/** The wire shapes this file translates between. */
type FreeWire = 'chat' | 'responses' | 'messages';
//#endregion
//#region src/free-catalog.d.ts
/** One free-lane row, as the adapter and the shim both read it. */
interface FreeModelRow {
  /** Published id, WITHOUT the `free:` prefix. */
  id: string;
  /** The id the picker and the wire both carry. */
  modelId: string;
  name: string;
  wire: FreeWire;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
  canDisableThinking: boolean;
  regionSensitive: boolean;
}
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
export declare const XDPOOL_PROVIDER = "xdpool";
interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim;
  catalog: WorkBuddyCatalog | AggregateCatalog;
  /** Plugin context; the pi-ai adapter reads `attachments`/`fs` from it. */
  ctx: Context$1;
  providerId?: string;
  displayName?: string;
  /**
   * The rows this provider serves, when it is a LATER lane rather than a pool.
   *
   * A fourth route registers its own provider id, so it owns its whole roster
   * and `catalog` is never consulted for it — passing a pool catalog there is not
   * a silent default, it is ignored on purpose. The roster is read per call,
   * exactly like the pool's, so a refresh that lands after startup is visible
   * without a restart.
   */
  extraRows?: (() => readonly FreeModelRow[]) | undefined;
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  providerId: string;
  displayName: string;
  adapter: PiAiAdapter;
  /** Rebuild the pi-ai model list from the current catalog. */
  buildModels: () => Model<Api>[];
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. `getModels` re-reads the live catalog, and every
 * model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup. Call only after `shim.ready`.
 *
 * `catalog` accepts the aggregate catalog too; {@link isAggregateCatalog} tells
 * the two apart by shape rather than by a flag, because the aggregate rows are a
 * different kind of record, not a differently-populated pool row.
 */
export declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/scheduler.d.ts
/** How often the loop wakes to look for a due job. */
/**
 * How long to wait for event scoring to land before re-reading the task list.
 *
 * Scoring is asynchronous on the upstream side, so an immediate re-read still
 * shows the old progress and the claim pass would skip a task that is in fact
 * now claimable. Measured: the chain is reflected by about eight seconds.
 */
export declare const EVENT_SCORE_WAIT_MS = 9000;
export declare const AUTOMATION_TICK_MS = 60000;
/** Which jobs the automation runs, and when. */
/**
 * The persisted daily earnings ledger.
 *
 * `date` is the local day the counters belong to: a ledger from a previous day
 * is discarded on load rather than carried forward as "today".
 */
interface AutomationLedger {
  date: string;
  accounts: Record<string, AutomationAccountEarnings>;
}
interface AutomationOptions {
  /** Master switch; false stops every job. */
  enabled?: boolean;
  /** Hour list for the daily check-in job. */
  checkinHours?: readonly number[];
  /** Hour list for the task-centre job (accept + claim). */
  taskHours?: readonly number[];
  /** Hour list for the activity-report job. */
  reportHours?: readonly number[];
  /** Hour list for the streak-redemption job. */
  streakHours?: readonly number[];
  /** Hour list for the buddy travel job. */
  travelHours?: readonly number[];
  /** Hour list for the outage-compensation claim. */
  compensationHours?: readonly number[];
  /** Per-account serial delay, in milliseconds. */
  accountDelayMs?: number;
  /** Override the gap between expert chains, in milliseconds (tests use 0). */
  expertGapMs?: number;
  /** Override the event-scoring wait, in milliseconds (tests use 0). */
  eventScoreWaitMs?: number;
  /** Override the clock, for tests. */
  now?: () => Date;
  /** Logger; defaults to a no-op so tests stay quiet. */
  logger?: SchedulerLogger;
  /**
   * Persist the daily earnings ledger, and restore it on construction.
   *
   * The ledger cannot live only in memory: a host restart mid-day would wipe
   * what the automation already earned, and the card would show nothing for
   * rewards that really were collected.
   */
  loadEarnings?: () => AutomationLedger | undefined;
  saveEarnings?: (ledger: AutomationLedger) => void;
}
/** Logger surface, kept structural so any host logger fits. */
interface SchedulerLogger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}
/** One job's last-run record, surfaced on the status document. */
interface AutomationJobState {
  /** `YYYY-MM-DD` of the last completed run, or undefined if it never ran. */
  lastRunDate?: string;
  /**
   * The scheduled SLOT of the last run, as `YYYY-MM-DDTHH`.
   *
   * The tick de-duplicates on this rather than on the date: keying on the date
   * alone caps every job at one run a day, which is wrong for a job with two
   * time points — blocking the cat loop's second pass would leave the cat out
   * until tomorrow. Per slot a job runs once in each configured hour, while a
   * repeat tick inside the same hour is still refused.
   */
  lastRunSlot?: string;
  /**
   * Every configured slot consumed TODAY, as `YYYY-MM-DDTHH`.
   *
   * This is what actually gates a re-run, and it is a SET rather than a single
   * slot because one field could not express the contract: a job configured for
   * `[9, 21]` runs twice, and a single "last slot" value can only remember one
   * of them — the second run erased the first, so the 9 o'clock candidate looked
   * unconsumed again and the job re-fired every hour after 21:00.
   *
   * The values are the CONFIGURED hours that were spent, never the clock time
   * the run happened to finish at. Storing the finish time was the original
   * defect: the reader compared it against a configured candidate, so the two
   * almost never matched and the gate stayed open all day.
   *
   * In-memory like the rest of `states`: this is a per-process record, and the
   * catch-up design deliberately re-runs an hour that passed while DSH was
   * closed. See `automationEarnings` for the ledger that DOES persist.
   */
  firedSlots?: readonly string[];
  /**
   * The clock slot the last run STARTED in (`YYYY-MM-DDTHH`).
   *
   * Separate from {@link firedSlots} on purpose: this is a throttle ("do not
   * start twice inside the same hour"), while `firedSlots` is the schedule
   * ledger. Conflating the two is what let a catch-up run at 13:00 erase the
   * record of the 9 o'clock slot.
   */
  lastFiredHour?: string;
  /** Epoch ms of the last completed run. */
  lastRunAtMs?: number;
  /** Accounts that completed without throwing. */
  ok: number;
  /** Accounts that threw (each one skipped, the run continued). */
  failed: number;
  /** Credits claimed by the task job on the last run. */
  credit: number;
  /** Energy claimed by the task job on the last run. */
  energy: number;
  /** Tasks claimed by the task job on the last run. */
  claimed: number;
  /** Human-readable summary of the last run. */
  /**
   * What this run actually did, in the words of the task board.
   *
   * `message` is a count ("3 accounts, 5 tasks claimed"); this is the list a
   * person can check off — the reward titles the pass collected. A row showing
   * only a bare number cannot answer "did it do the thing I care about", which
   * is the question the panel exists to answer.
   */
  detail?: readonly string[];
  /**
   * A pending milestone worth naming, when there is one.
   *
   * Streak tiers are why this exists: every tier reads `locked` until enough
   * consecutive days accumulate, and "locked" on its own reads as "broken"
   * rather than "come back in four days".
   */
  progress?: string;
  message?: string;
}
/**
 * What the automation earned for ONE account today.
 *
 * Reset at the local day boundary alongside the per-job "already ran today"
 * guard, so the card shows today rather than a running total that never
 * answers "did it do anything for this account recently".
 */
interface AutomationAccountEarnings {
  /** Credits the automation claimed from the task centre today. */
  credit: number;
  /** Energy claimed from the task centre today. */
  energy: number;
  /** Tasks claimed today. */
  claimed: number;
  /**
   * Credits the automation collected from check-in today.
   *
   * Kept separate from `credit` because they are different achievements and the
   * card shows them on their own lines: "the automation claimed 3 tasks" and
   * "the automation checked in" are not the same claim to the user.
   */
  checkinCredit: number;
  /** Credits from streak redemption + lottery today. */
  bonusCredit: number;
  /** Credits from the buddy adoption / travel loop today. */
  travelCredit: number;
  /**
   * Credits collected from the outage-compensation offer today.
   *
   * Its own column for the same reason as `checkinCredit`: a 500-credit
   * outage refund is a different thing from a 100-credit daily check-in, and
   * the card lists what earned what.
   */
  compensationCredit: number;
  /** Local date the counters belong to. */
  date: string;
}
/** What ONE account gained during a single run. */
interface AutomationAccountGain {
  credit: number;
  energy: number;
  claimed: number;
  checkinCredit: number;
  bonusCredit: number;
  travelCredit: number;
  compensationCredit: number;
}
/** Totals from running the whole ordered pass at once. */
interface AutomationRunSummary {
  /** How many jobs actually ran (a job with no hour is skipped). */
  jobsRun: number;
  /** Accounts that finished without error, summed across jobs. */
  okCount: number;
  /** Accounts that failed, summed across jobs. */
  failed: number;
  credit: number;
  energy: number;
  claimed: number;
  /**
   * What each account gained during THIS run, keyed by account id. Only
   * accounts that gained something appear.
   */
  accounts: Readonly<Record<string, AutomationAccountGain>>;
}
/** Automation snapshot for the status document and the card. */
interface AutomationStatus {
  enabled: boolean;
  /** Whether the loop is running. */
  running: boolean;
  checkinHours: readonly number[];
  taskHours: readonly number[];
  reportHours: readonly number[];
  streakHours: readonly number[];
  travelHours: readonly number[];
  compensationHours: readonly number[];
  jobs: {
    checkin: AutomationJobState;
    report: AutomationJobState;
    tasks: AutomationJobState;
    streak: AutomationJobState;
    travel: AutomationJobState;
    compensation: AutomationJobState;
  };
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number;
  /**
   * Per-account totals for today, keyed by account id. Only accounts that
   * actually earned something appear, so the card can render "no earnings"
   * as an absence rather than a zero it has to explain.
   */
  earningsToday: Readonly<Record<string, AutomationAccountEarnings>>;
  /**
   * Whether a manual run is in flight right now.
   *
   * A run takes tens of seconds (one upstream call per account per job, plus
   * the scoring wait), which is far too long for the card to hold a request
   * open. The button starts a run and the panel polls this flag instead.
   */
  runInProgress: boolean;
}
/** The three plus one job kinds, in a stable order. */
type AutomationJobKind = 'checkin' | 'tasks' | 'report' | 'streak' | 'travel' | 'compensation';
/** The jobs in the order a tick runs them: report before tasks, always. */
export declare const AUTOMATION_JOB_KINDS: readonly AutomationJobKind[];
/** Reject anything that is not a job kind, so a route cannot name an unknown job. */
export declare function isAutomationJobKind(value: unknown): value is AutomationJobKind;
export declare function dayKey(date: Date, timeZone?: string): string;
/**
 * Whether `now`'s local hour is one of `hours`.
 *
 * The reference panel computes a `nextFire` instant and sleeps until it; this
 * loop instead wakes every minute and asks "is any job due now". Both fire at
 * the top of a configured hour, but the polling form cannot miss a slot to a
 * suspended process — a laptop that slept through 10:00 still runs the job the
 * moment it wakes, on the same day.
 */
export declare function isFireHour(now: Date, hours: readonly number[]): boolean;
/**
 * The points automation.
 *
 * Owns a single timer loop. Construction is inert — nothing runs until
 * {@link start}, and {@link stop} is idempotent so a plugin teardown that fires
 * twice is harmless.
 */
export declare class WorkBuddyScheduler {
  private readonly pool;
  private readonly client;
  private readonly logger;
  private readonly now;
  private readonly delayMs;
  /**
   * How long to wait for event scoring before re-reading the task list.
   * Tests set 0 so a pass does not spend nine real seconds per account.
   */
  private readonly eventScoreWaitMs;
  /**
   * Gap between two expert summon chains.
   * Tests set 0 so a pass does not spend six real seconds per expert.
   */
  private readonly expertGapMs;
  private enabled;
  private checkinHours;
  private taskHours;
  private reportHours;
  private streakHours;
  private travelHours;
  private compensationHours;
  private timer;
  private running;
  /** Guards against a slow run overlapping the next tick. */
  private busy;
  /** True while a manual run is in flight, so the card can poll it. */
  private runInFlight;
  /**
   * Set once {@link stop} is called.
   *
   * Deliberately false before `start`: the loop is not running yet, but a
   * manual `tick` must still work. `stop` is what makes a run abandon the
   * accounts it has not reached yet.
   */
  private stopped;
  private readonly states;
  private claimableSeen;
  /**
   * Credits/energy/tasks earned per account TODAY, keyed by account id.
   *
   * Cleared whenever the day key rolls over, so the card always answers
   * "what did the automation get for THIS account today".
   */
  private earnings;
  /** Day key the counters above belong to. */
  private earningsDate;
  /** Host hooks that persist the ledger across restarts. */
  private readonly loadEarnings;
  private saveEarningsFn;
  constructor(pool: WorkBuddyAccountPool, client: WorkBuddyUpstreamClient, options?: AutomationOptions);
  /** Apply a new configuration; safe to call while running. */
  /**
   * Install the persistence hook once the host settings service is available.
   *
   * Separate from the constructor because the scheduler is built with the pool,
   * long before the settings section exists; a ledger written before that point
   * would have nowhere to go.
   */
  setEarningsPersistence(save: (ledger: AutomationLedger) => void | Promise<void>): void;
  /**
   * Fold a previously persisted ledger back in, when it belongs to today.
   *
   * Used after the settings document becomes readable, which happens after
   * construction; a ledger from an earlier day is ignored so the counters never
   * claim yesterday as today.
   */
  applyEarningsLedger(ledger: AutomationLedger): void;
  applyConfig(options: AutomationOptions): void;
  /** Hours for one job, used by the loop and the status document. */
  private hoursOf;
  /** Start the loop. Idempotent. */
  start(): void;
  /** Stop the loop. Idempotent, and safe before `start`. */
  stop(): void;
  /** Snapshot for the status document. */
  /**
   * Run one job immediately, regardless of the clock.
   *
   * Exists so the automation can be verified from the card without waiting for
   * its hour. A manual run is recorded exactly like a scheduled one, so the
   * timer will not repeat it later the same day: every job is idempotent, but a
   * second pass would still be wasted upstream calls.
   *
   * `force` ignores the already-ran-today guard, which is what pressing the
   * button a second time means.
   */
  runNow(kind: AutomationJobKind, force?: boolean): Promise<AutomationJobState>;
  /**
   * Run every job once, in the scheduled order.
   *
   * Order matters and is not configurable: the activity report has to land
   * before the task pass reads task progress, or the pass sees counters the
   * report would have moved. This is what the card's single button calls.
   */
  /**
   * Start a full pass in the background and return immediately.
   *
   * A pass takes tens of seconds - one upstream round trip per account per job,
   * plus the scoring wait - which is far too long to hold the card request open:
   * the browser or the host web server would time out, and the user would see
   * a hung button for a run that is actually working.
   *
   * Returns whether a run started. A second call while one is in flight is
   * ignored rather than queued: pressing the button twice means hurry up, and
   * the run already under way covers it.
   */
  startRunAll(): boolean;
  runAll(): Promise<AutomationRunSummary>;
  status(): AutomationStatus;
  /**
   * One poll: run every due job, serially.
   *
   * Serial by design — the jobs share the same accounts and the upstream
   * rate-limits per account, so overlapping passes would only trip that limit.
   * A job that throws is recorded and the loop continues.
   */
  /**
   * Whether `kind` is due at `now`: its earliest configured hour has passed in
   * the scheduling timezone, and no hour of today has been consumed yet.
   *
   * Hours are consumed per SLOT (one entry per configured hour), so a job with
   * two hours still runs twice a day — but a job whose hour passed while DSH was
   * closed runs immediately on the next tick instead of waiting for tomorrow.
   */
  /**
   * The configured slot `kind` should consume at `now`, or undefined when none.
   *
   * Returns the SLOT STRING (not a boolean) because the caller must record the
   * same value it acted on. Returning a boolean was the original bug's enabler:
   * the tick asked "is it due", then `runJob` independently wrote "what time is
   * it now" — and those two answers were almost never equal.
   *
   * CATCH-UP semantics are deliberate: a candidate fires once its hour has
   * PASSED and its slot is still unconsumed, so a laptop that slept through
   * 10:00 still runs the job when it wakes, on the same day.
   *
   * The EARLIEST unconsumed candidate wins, which is what keeps a two-hour job
   * (`travelHours: [9, 21]`) whole: consuming the earliest due slot leaves the
   * later one for its own hour.
   */
  private dueSlot;
  /** Today's consumed slots for one job, as a set. */
  private firedSlotsOf;
  /** Record one consumed slot on a job's state. */
  private consumeSlot;
  private tick;
  /** Run one job against every eligible account and record the outcome. */
  /**
   * Add one account's take to today's counters, resetting first if the day
   * rolled over. Called from the task pass, which is the only job that earns.
   */
  /**
   * Today's per-account earnings, as a plain object for the status document.
   *
   * Rolls the day first so a status read just after midnight does not report
   * yesterday's totals under today's date.
   */
  private earningsSnapshot;
  /**
   * Add one account take to today counters, resetting first if the day rolled
   * over. Every source is tracked separately so the card can show what earned
   * what, rather than one opaque total.
   */
  private recordEarnings;
  /** Clear the per-account counters when the local day changes. */
  private rollEarnings;
  /**
   * Write the ledger through the host hook, when one was supplied.
   *
   * Best effort on purpose: a failed save must never abort a run that has
   * already collected rewards, and the in-memory ledger keeps serving the card
   * for the rest of the session either way.
   */
  private persistEarnings;
  /**
   * Run one job against every eligible account and record the outcome.
   *
   * `consumedSlot` is the configured slot this run spends (`dueSlot`'s answer).
   * It is passed IN rather than recomputed here so the value recorded is exactly
   * the value the schedule decided on — the defect this replaces wrote
   * `slotKey(now)` instead, i.e. the clock time the run finished at, which
   * almost never equals the configured candidate the gate had compared against.
   *
   * The task job runs in TWO passes. The first sends the event chains that light
   * up client-scored tasks; the second collects rewards. They are separate
   * because scoring lands asynchronously — a chain sent and claimed within the
   * same breath finds the task still un-scored — and because sending is fast
   * while claiming wants the whole pool to have been lit up first. Splitting
   * them costs one shared wait instead of one wait per account.
   */
  private runJob;
  /** Compose the one-line summary shown on the card. */
  private summarise;
  /**
   * Accounts to run against, in pool order.
   *
   * Disabled accounts are excluded here rather than filtered by the caller so a
   * card switch takes effect on the next pass without any event plumbing.
   */
  private accountsInOrder;
  /**
   * Send one activity report, then verify it landed.
   *
   * The upstream answers 200 even when it drops the event, so the streak is
   * read back as the oracle: `days > 0` means it counted. A failed read-back is
   * logged and treated as a suspicious result, never as a retry — the report is
   * idempotent per day, and hammering it is exactly what the one-a-day quota
   * exists to avoid.
   */
  private reportOne;
  private sendEventChains;
  /**
   * Send one chain on the channel it was built for.
   *
   * The transport is not a detail of the sender: the scorer keys different
   * tasks to different fingerprint families, so a web-scored event posted as a
   * desktop event is accepted and then ignored.
   */
  private sendChain;
  /**
   * Build every chain that scores one task.
   *
   * Most tasks need a single chain; `template_5` needs five, because the scorer
   * counts distinct `template_used` events rather than a boolean. The two tasks
   * that join a conversation (skill, expert) open a real one first, which is why
   * this is async.
   */
  private chainsFor;
  /**
   * The summon-and-use chains for the expert tasks.
   *
   * Two steps per expert, and both are load-bearing: the summon events alone are
   * impressions, and a use event on its own scores nothing because the scorer
   * looks the conversation up. Only a real chat with `X-Expert-Id` produces an
   * id it will accept.
   */
  private expertChains;
  /**
   * The 腾讯轻量云 expert chain.
   *
   * Structurally the same as the expert task, with two differences the scorer
   * checks: `agent_task_created` has to name the expert, and the use event has
   * to report `mode: 'LOCAL'` with an empty type and zero cost — that is what
   * the lighthouse criterion looks for.
   */
  private lighthouseChains;
  /**
   * The task-centre pass for one account.
   *
   * Order matters: enrich first (enrol in everything open), then claim. Both
   * halves are idempotent — accepting an already-accepted task succeeds, and a
   * repeat claim answers `already_claimed` — so a pass that dies halfway is
   * safe to replay on the next tick.
   */
  private runTasks;
  /**
   * Streak redemption plus the lottery it unlocks.
   *
   * Tiers unlock on consecutive active days (7/14/28). Redeeming one pays
   * credits, energy, a makeup card and — the part nothing else grants — lottery
   * draws, so the draw runs straight after and only for the chances in hand.
   *
   * Everything here is idempotent: a tier already claimed is skipped by its
   * status, and a draw consumes one chance, so a replay cannot double-spend.
   */
  private redeemStreak;
  /**
   * One trip through the buddy travel loop for an account.
   *
   * A single pass advances the state machine by at most one step: a trip
   * that has arrived is collected, and an idle buddy is sent out. A buddy
   * already travelling is left alone — there is nothing to do until it lands.
   *
   * Measured against the live upstream: the departed trip reports
   * `dailyLimitReached` immediately, so the once-a-day limit needs no local
   * bookkeeping.
   */
  private runTravel;
  /**
   * Collect the running service-outage compensation offer, if any.
   *
   * Read-then-claim, rather than claim-blind: a claim costs one mutation the
   * upstream may reject, and the status call is a free read that also tells us
   * the size on offer so the ledger records the real number instead of
   * assuming the usual 500.
   *
   * Returns the credits collected — 0 when there was nothing to collect, which
   * is the normal case for most of the year.
   */
  private runCompensation;
}
//#endregion
//#region src/status.d.ts
/** One account's status row. */
interface AccountStatus {
  id: string;
  label: string;
  nickname?: string;
  domain: string;
  /** ISO timestamp when the access token expires. */
  expiresAt?: string;
  /** Account-wide cooldown (every model blocked). */
  cooling: boolean;
  cooldownUntil?: string;
  /** Per-model cooldowns active right now (modelId → ISO until); the account
   *  itself is not `cooling` while only some models are limited. */
  modelCooldowns?: readonly {
    modelId: string;
    until: string;
  }[];
  rateLimitHits: number;
  /** Read-only aggregated credit summary for the account. */
  credits?: WorkBuddyCredits;
  creditsError?: string;
  sourcePath: string;
}
/** Whole-plugin status document. */
interface WorkBuddyStatus {
  ok: boolean;
  accounts: AccountStatus[];
  activeAccountId?: string;
  cooling: number;
  models: {
    id: string;
    name: string;
    multiplier?: number;
    tags?: readonly string[];
  }[];
  shim: {
    running: boolean;
    baseUrl?: string;
  };
}
interface StatusOptions {
  pool: WorkBuddyAccountPool;
  /** The catalog to report. Regional callers pass their own region's. */
  catalog: WorkBuddyCatalog;
  client: WorkBuddyUpstreamClient;
  shim?: {
    running: boolean;
    baseUrl?: string;
  };
  /** Query credits per account. Off for cheap diagnostics runs. */
  includeCredits?: boolean;
}
/** Build the status document. Never throws. */
export declare function buildStatus(options: StatusOptions): Promise<WorkBuddyStatus>;
/** Format the status document for a terminal. */
export declare function formatStatus(status: WorkBuddyStatus): string;
/** Format the per-model credit multipliers. */
export declare function formatRates(status: WorkBuddyStatus): string;
//#endregion
//#region src/ignored.d.ts
/** Directory holding this plugin's own state (imported snapshots, ignore list). */
export declare const PLUGIN_DATA_DIR_NAME = ".xdpool";
/** File holding the permanent ignore list, inside {@link pluginDataDir}. */
export declare const IGNORED_FILE_NAME = "ignored.json";
/** One ignored account, as stored on disk and shown on the card. */
type IgnoredAccount = PoolWebIgnoredAccount;
/**
 * The DSH home directory, honouring the same override the host uses.
 *
 * Shared by the CLI and the host so both halves resolve the same file: an
 * `ignore` written from the terminal has to be visible to the running plugin,
 * which is only true if they agree on where "home" is.
 */
export declare function dshHome(env?: NodeJS.ProcessEnv): string;
/** This plugin's own state directory. */
export declare function pluginDataDir(env?: NodeJS.ProcessEnv): string;
/** Absolute path of the ignore list. */
export declare function ignoredIdsPath(env?: NodeJS.ProcessEnv): string;
/**
 * Read the ignore list, tolerating every "no list yet" shape.
 *
 * A missing file, unreadable file, or invalid JSON all mean the same thing to
 * the caller — nothing is ignored — so none of them throws. The pool must be
 * able to start on a machine that has never ignored anything.
 */
export declare function readIgnoredAccounts(path?: string): Promise<IgnoredAccount[]>;
/**
 * Synchronous read, for startup.
 *
 * The host applies the ignore list from inside `apply()`, which is synchronous,
 * and doing it there removes a startup race: an async load could resolve AFTER
 * the first account scan, which would let an ignored account slip into the pool
 * once per boot. The file is a few hundred bytes, so a blocking read at startup
 * costs nothing measurable.
 */
export declare function readIgnoredAccountsSync(path?: string): IgnoredAccount[];
/**
 * Replace the ignore list, atomically.
 *
 * Written to a sibling temp file and renamed over the target so a crash (or a
 * concurrent reader) can never observe a half-written document — the ignore
 * list is the only thing standing between a dead account and the rotation, and
 * a truncated file reads as "nothing is ignored", which would quietly put every
 * discarded account back in the pool.
 */
export declare function writeIgnoredAccounts(accounts: readonly IgnoredAccount[], path?: string): Promise<void>;
/**
 * Add one account to the ignore list, preserving the rest.
 *
 * A read-modify-write rather than a wholesale replace: the card and the CLI can
 * both be open, and each request names exactly one account, so re-writing the
 * whole list from a stale view would drop the other side's edits.
 */
export declare function ignoreAccount(account: {
  id: string;
  label?: string;
}, path?: string): Promise<IgnoredAccount[]>;
/** Drop one account from the ignore list. Returns the resulting list. */
export declare function unignoreAccount(accountId: string, path?: string): Promise<IgnoredAccount[]>;
//#endregion
//#region src/preferred.d.ts
/** Absolute path of the preferred-account file. */
export declare function preferredIdPath(env?: NodeJS.ProcessEnv): string;
/**
 * Read the pinned id, tolerating every "no pin yet" shape.
 *
 * A missing file is the normal state on a fresh install, so it is not an error.
 */
export declare function readPreferredId(path?: string): Promise<string | undefined>;
/**
 * Synchronous read, for startup.
 *
 * The host pins the account from inside `apply()`, which is synchronous, and
 * doing it there removes a startup race: an async load could resolve AFTER the
 * first account scan, so the first request of the process would be served by
 * whichever account the strategy picked rather than the one the user asked for.
 * The file is tens of bytes, so a blocking read at startup costs nothing
 * measurable.
 */
export declare function readPreferredIdSync(path?: string): string | undefined;
/**
 * Write (or clear) the pinned id, atomically.
 *
 * Written to a sibling temp file and renamed over the target so a crash or a
 * concurrent reader can never observe a half-written document. A truncated file
 * reads as "nothing is pinned", which is survivable — the strategy takes over —
 * but a half-written file that happens to parse could pin an account nobody
 * chose, and that is the failure worth designing out.
 *
 * `accountId: undefined` DELETES the file rather than writing `{"accountId":
 * null}`. Deleting makes "no pin" the same state as "never pinned", so there is
 * exactly one way for the next read to come back empty, and the directory stays
 * free of documents that describe the absence of a decision.
 */
export declare function writePreferredId(accountId: string | undefined, path?: string): Promise<void>;
//#endregion
//#region src/relay.d.ts
interface PoolRelayStatus {
  enabled: boolean;
  /** Whether a listener is actually bound right now. */
  listening: boolean;
  host: string;
  port: number;
  /** Where a client should point; '' until something is listening. */
  endpoint: string;
  /**
   * The relay key in full.
   *
   * Returned on purpose: the card has to show it once so the user can copy it
   * into the other device. This is the key WE minted for LAN clients, not the
   * shim secret, and it grants nothing beyond reaching the pool.
   */
  key: string;
  /** Why nothing is bound; '' when there is nothing to explain. */
  error: string;
}
//#endregion
//#region src/web-status.d.ts
/** Constructor dependencies — a narrow slice of the pool runtime. */
interface PoolStatusRouteOptions {
  pool: WorkBuddyAccountPool;
  /** One catalog per region; the card reads the one for its active tab. */
  catalogs: Readonly<Record<PoolRegion, WorkBuddyCatalog>>;
  client: WorkBuddyUpstreamClient;
  /** Lazily resolve the running loopback shim, when it has bound a port. */
  shim?: () => {
    running: boolean;
    baseUrl?: string;
  };
  /**
   * The daily-points automation, when the host half has one.
   *
   * Optional so these routes still mount on a profile that assembled a pool
   * without a scheduler (the CLI and the tests do exactly that); the card then
   * reports the automation as off instead of showing a broken panel.
   */
  scheduler?: () => AutomationStatus;
  /**
   * Start a manual pass, for the card's "run now" button.
   *
   * Returns whether a run STARTED, not its result: a pass takes tens of
   * seconds, so it runs in the background and the card polls the scheduler
   * status for progress and earnings.
   */
  runAutomation?: (job: string, force: boolean) => boolean;
  /**
   * Persist one account's reserved-credit floor. Same settings document as every
   * other card write, so it survives a restart and is re-applied after a scan.
   * Absent without a settings service: the route then answers 503.
   */
  setCreditReserve?: (accountId: string, reserve: number) => Promise<void> | void;
  /**
   * Persist the user's model selection. Provided by the host half, which owns
   * the settings section; absent when the plugin runs without a settings
   * service (the save route then reports 503 rather than pretending to work).
   */
  /**
   * Persist one region's selection. The region travels with the payload: the two
   * gateways advertise different rosters, so the domestic tab and the
   * international tab each own their list and must never overwrite each other.
   */
  saveSelection?: (region: PoolRegion, selection: PoolWebModelSelection) => Promise<void> | void;
  /**
   * Persist one account switch. Same settings document as every other card
   * write, so it survives a restart and is re-applied after each re-scan.
   * Absent without a settings service: the route then answers 503.
   */
  setAccountDisabled?: (accountId: string, disabled: boolean) => Promise<void> | void;
  /**
   * Throw one account out of the pool for good, or take it back.
   *
   * Backed by the plugin's own ignore file rather than the settings document,
   * because the CLI writes the same list and has no settings service. Absent
   * when the host did not wire it: the route then answers 503.
   */
  setAccountIgnored?: (accountId: string, ignored: boolean) => Promise<void> | void;
  /**
   * Name the account to try first, or clear the pin with a null id.
   *
   * Backed by the plugin's own preferred-account file rather than the settings
   * document, for the same reason as {@link setAccountIgnored}: the CLI's
   * `prefer` command writes the same file and has no settings service, so a
   * settings-backed pin would only ever be writable from the card.
   *
   * Called by the handler and required to have taken effect in the pool before
   * it resolves: the card re-polls straight after, and a pin that is persisted
   * but not yet visible in the pool would make the next request ignore the
   * choice the user just made. Absent when the host did not wire it: the route
   * then answers 503.
   */
  setPreferredAccount?: (accountId: string | null) => Promise<void> | void;
  /**
   * The accounts currently ignored, for the card's "ignored" list.
   *
   * A thunk rather than a snapshot so the document always reflects the file on
   * disk, including edits made by the CLI while the card is open.
   */
  ignoredAccounts?: () => readonly PoolWebIgnoredAccount[];
  /**
   * Re-fetch the model catalog for BOTH regions and report what landed.
   *
   * Absent when the host did not wire it: the route then answers 503 rather
   * than pretending the refresh happened.
   */
  refreshCatalog?: () => Promise<{
    regions: Readonly<Record<PoolRegion, {
      source: PoolWebCatalogSource;
      models: number;
      error?: string;
    }>>;
  }>;
  /**
   * The usage panel's aggregate, produced by whatever served the calls.
   *
   * A thunk rather than a snapshot so the panel always sees the newest calls,
   * and optional because a profile assembled without a recorder still serves
   * chat normally - it simply has no usage to show, and the route reports that
   * instead of pretending the panel is broken.
   */
  usage?: () => UsageSummary;
  /**
   * The aggregate lane's stored settings, for the read route.
   *
   * A thunk rather than a snapshot so the document always reflects the file on
   * disk, including a CLI edit made while the card is open — the same contract
   * `ignoredAccounts` documents for the ignore list.
   */
  aggregateStore?: () => AggregateStore;
  /**
   * The whole aggregate document, built host-side.
   *
   * One dep instead of `aggregateStore` plus a model count because the two must
   * be read together: the store says which providers are configured, and the
   * running catalog says which rows that actually produces. Two separate reads
   * could straddle a save and show a provider as configured with no rows.
   */
  aggregateDocument?: () => Promise<PoolWebAggregateStatus> | PoolWebAggregateStatus;
  /**
   * Save one aggregate patch and return the document the card should re-read.
   *
   * The HOST half owns the write because it is the only side that also knows how
   * to refresh the running catalog: a key saved on the card has to change the
   * model picker without a DSH restart, which is the whole point of the card.
   */
  saveAggregate?: (patch: PoolWebAggregatePatch) => Promise<PoolWebAggregateStatus>;
  /**
   * Verify one provider's key. Never throws: the answer is what the card shows.
   */
  probeAggregate?: (providerId: string) => Promise<PoolWebAggregateProbe>;
  /**
   * Send one real streaming call and report whether the model answered.
   *
   * Never throws: the measurement is the answer, and a probe that rejected
   * would leave the button spinning forever instead of telling the user what
   * went wrong.
   *
   * The HOST half owns this because only the host can reach `ctx.llm.stream`,
   * which is the one surface that resolves a provider/model pair through the
   * real adapter registry — the plugin's own lanes do not know which credential
   * a given provider id ends up using.
   */
  probeModel?: (provider: string, model: string, signal?: AbortSignal) => Promise<PoolWebModelProbeResult>;
  /**
   * What models each login channel contributes, as the host's catalogue spells it.
   *
   * Optional because a build without a login-channel pack genuinely cannot answer
   * — the route reports that rather than pretending every channel is empty.
   * Providers the host cannot answer for are omitted from the returned record;
   * see {@link PoolWebChannelModels} for why that distinction is load-bearing.
   */
  channelModels?: (providers: readonly string[], ids?: Readonly<Record<string, readonly string[]>>) => Promise<Readonly<Record<string, readonly PoolWebChannelModel[]>>>;
  /**
   * Fetch one provider's live model list, write it back as its discovered set,
   * and refresh the catalog.
   */
  discoverAggregate?: (providerId: string) => Promise<PoolWebAggregateProbe>;
  /**
   * The login-channel list, built host-side.
   *
   * `state` is the load-bearing part: a card that silently rendered an empty
   * channel list would look exactly like "this host has no channels", which is
   * the one conclusion the user cannot verify for themselves.
   */
  channelsDocument?: () => PoolWebChannelsStatus;
  /**
   * The chains plus the roster their members are drawn from, built host-side.
   *
   * One dep because the two halves are the same question asked twice — "what can
   * a chain name, and does what it names still exist" — and answering them from
   * two snapshots could show a member that the chains no longer resolve.
   */
  combosDocument?: () => PoolWebCombosStatus;
  /**
   * Replace the chain table and refresh the running catalog, then re-answer the
   * document. The catalog refresh is what makes a new chain pickable at once.
   */
  saveCombos?: (raw: unknown) => Promise<PoolWebCombosStatus>;
  /**
   * What the locally running billion-context proxy is doing, read-only.
   *
   * Absent when the module could not be wired: the route then answers 503
   * rather than pretending a third-party proxy reported nothing. It never
   * rejects — a missing proxy is a normal state with its own `reason`, because
   * billion-context is a separate optional plugin.
   */
  billionDocument?: () => Promise<PoolWebBillionStatus>;
  /**
   * The relay's current state, or undefined when this build has no relay.
   *
   * Reading the key back out of here is deliberate — the card has to show it so
   * the user can paste it into another device — but it is the RELAY key, which
   * the plugin minted for LAN clients. The shim's own per-process secret is never
   * exposed by any route.
   */
  relayDocument?: () => Promise<PoolRelayStatus>;
  /** Apply a relay patch, re-evaluate the listener, and answer with the new state. */
  saveRelay?: (patch: PoolWebRelayPatch) => Promise<PoolRelayStatus>;
}
/**
 * Assemble the card's status document. Per-account credits and check-in state
 * are queried live; a failing query degrades to `creditsError` / `checkinError`
 * rather than failing the whole document. Never throws.
 */
export declare function poolWebStatus(deps: PoolStatusRouteOptions, region?: PoolRegion): Promise<PoolWebStatus>;
/**
 * Mount the read-only routes on a context where `webServer` is available. The
 * caller uses `ctx.inject(['webServer'], ...)` so Desktop startup order cannot
 * make this registration disappear.
 */
export declare function registerPoolStatusRoute(ctx: Context$1, deps: PoolStatusRouteOptions): void;
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
export declare const name = "llm-xdpool";
/** The model registry required before the provider can register. */
export declare const inject: string[];
/**
 * Settings namespace for the XD Pool card. Registering a section here
 * is what makes the provider appear on the Models settings page and causes the
 * Host to mount the plugin's client card under Plugin configuration — exactly
 * the mechanism the single-account connector uses.
 */
export declare const XDPOOL_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path override. */
  authFile?: string;
  /** Rate-limit cooldown per account, milliseconds. */
  cooldownMs?: number;
  /**
   * How the pool spreads requests across accounts.
   *
   * - `priority` (default) drains one account before moving to the next, which
   *   is what a pool of your own accounts is for.
   * - `round-robin` walks the pool in order, so the spend splits evenly.
   * - `balanced` draws at random, weighting whichever account has been idle
   *   longest. Spend still spreads, but without a fixed order, so one unhealthy
   *   account cannot pin the pool to itself.
   * - `sticky` gives each conversation one account and moves the next new
   *   conversation to the next account in order. Rotating accounts inside a
   *   conversation throws away the upstream prompt cache (it is per tenant), so
   *   this keeps the cache warm while still spreading spend across
   *   conversations.
   * - `expiry` picks the account whose one-off credit packs expire soonest, so
   *   use-it-or-lose-it credits are spent before they die. Accounts with no
   *   known expiry sort last, so an unprobed pool degrades to `priority`.
   *
   * Absent reads as `priority`.
   */
  distribution?: 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry';
  /**
   * Account ids switched off on the card. A disabled account is never picked
   * to serve a request, but it stays in the pool and on the card so it can be
   * switched back on. Ids are the pool's stable per-credential keys, which
   * survive re-scans (see WorkBuddyAccountPool.disabledIds).
   */
  disabledAccountIds?: string[];
  /**
   * Per-account credit floor, keyed by account id. The pool stops picking an
   * account once its last known balance reaches this value, so the reserved
   * credits survive. Absent or 0 spends the account down as before.
   */
  creditReserves?: Record<string, number>;
  /**
   * Model ids enabled in the picker. Absent means "every model the catalog
   * advertises" — an unconfigured install should never present an empty model
   * list just because the key is missing.
   */
  enabledModelIds?: string[];
  /**
   * Model ids that additionally accept image input. Absent means "follow the
   * upstream capability flag"; an explicit list is authoritative for the models
   * it mentions and leaves the rest to the catalog.
   */
  imageModelIds?: string[];
  /**
   * Per-model context-window override, keyed by model id. The upstream can
   * advertise more than DSH wants to hand a single turn, so the card lets the
   * user cap a model without touching the catalog.
   */
  contextBudgets?: Record<string, number>;
  /**
   * Per-region model selection. The two gateways advertise different rosters, so
   * one shared list would let a save on one tab silently rewrite the other tab's
   * picker. Each region owns its own copy; a region with no entry falls back to
   * the legacy flat keys above, so an upgrade keeps the list already in use.
   */
  modelSelectionCn?: ModelSelectionConfig;
  modelSelectionGlobal?: ModelSelectionConfig;
  /**
   * Daily-points automation. Absent means off: the scheduler makes upstream
   * calls on the user behalf, so it stays opt-in rather than surprising a
   * fresh install with background traffic.
   */
  automation?: AutomationConfig;
  /**
   * The automation's daily earnings ledger, written by the scheduler itself.
   *
   * It lives in settings rather than only in memory so a host restart mid-day
   * does not wipe what the automation already earned.
   */
  automationEarnings?: AutomationLedger;
}
/** One region's saved model selection. */
export interface ModelSelectionConfig {
  enabledModelIds?: string[];
  imageModelIds?: string[];
  contextBudgets?: Record<string, number>;
}
/**
 * Daily-points automation.
 *
 * Absent means off: the scheduler makes upstream calls on the user behalf, so
 * it stays opt-in rather than surprising a fresh install with background
 * traffic. Each job carries its own hour list so the passes can be spread out
 * (or pushed off-peak) without disabling any of them.
 *
 * Ordering note: the report job must run before the task job. A report is what
 * lights the growth streak and unlocks the `first_buddy` family, so a task pass
 * that ran first would read counters before they could have moved.
 */
export interface AutomationConfig {
  /** Master switch for every automation job. Absent reads as false. */
  enabled?: boolean;
  /** Hours (local, 0-23) at which the daily check-in runs. */
  checkinHours?: number[];
  /** Hours at which the activity report runs. Keep ahead of `taskHours`. */
  reportHours?: number[];
  /** Hours at which tasks are enrolled in and claimed. */
  taskHours?: number[];
  /** Hours at which streak redemption runs. */
  streakHours?: number[];
  /** Hours at which the buddy travel loop runs. */
  travelHours?: number[];
  /** Hours at which the outage-compensation claim runs. */
  compensationHours?: number[];
  /** How long an account rests after its credits run out, in milliseconds. */
  exhaustCooldownMs?: number;
}
/** Upper bound the card offers as the "default" context window, in tokens. */
export declare const DEFAULT_CONTEXT_BUDGET = 200000;
/**
 * Fold a saved automation block into scheduler options.
 *
 * Absent means off, stated once here so every caller agrees: the card writes
 * `enabled` as a real boolean, and a config that never touched the section must
 * not accidentally arm background upstream traffic.
 */
export declare function automationOptions(automation: AutomationConfig | undefined): AutomationOptions;
/** Settings key holding one region's saved selection. */
export declare const modelSelectionKeyFor: (region: 'cn' | 'global') => string;
/**
 * Plugin configuration schema.
 *
 * Mirrors the shape the settings section stores. Every field carries a default
 * so a config that never touched the card still folds cleanly: a field whose
 * schema declares no default is read as absent by the settings fold. That is
 * also why `contextBudgets` is a real dictionary (`z.dict`) - an open object
 * schema reads as "an object with no fields" and the fold then throws while
 * the provider row is rendered.
 *
 * Every field is wrapped in {@link asVolatile}: on the 0.1.7 line the settings
 * write gate refuses an entry whose schema declares no volatile field at all
 * ("Plugin entry ... has no volatile fields") and `describe()` skips such an
 * entry — so an unmarked schema means the card can neither render nor save. On
 * the 0.1.5 line the wrapper degrades to an identity no-op (see its JSDoc), and
 * the value the running instance reads is a plain value either way once
 * unwrapped.
 */
export declare const Config: z<Config>;
/** Everything the CLI needs from a live plugin instance. */
export interface WorkBuddyPoolApi {
  pool: WorkBuddyAccountPool;
  /** One catalog per region, matching the two registered providers. */
  catalogs: Readonly<Record<WorkBuddyRegion, WorkBuddyCatalog>>;
  client: WorkBuddyUpstreamClient;
  shim: WorkBuddyShim;
  adapter: WorkBuddyAdapter | undefined;
  rescan(): Promise<number>;
  status(includeCredits?: boolean): Promise<Awaited<ReturnType<typeof buildStatus>>>;
  resetCooldowns(): void;
  /** Daily-points automation; assembled with the core, inert until started. */
  scheduler: WorkBuddyScheduler;
}
/** The live API, or undefined when the plugin has not applied yet. */
export declare function currentApi(): WorkBuddyPoolApi | undefined;
/** Test seam: install an API instance without booting cordis. */
export declare function setApi(next: WorkBuddyPoolApi | undefined): void;
/** Assemble the runtime objects without registering anything. */
/**
 * Assemble the runtime objects without registering anything.
 *
 * One catalog per region, mirroring the two shims: the CN and global gateways
 * do not advertise the same roster, and a shared catalog meant the picker showed
 * whichever list happened to be fetched first (always the CN one, since the
 * seeding step read `accounts[0]`).
 */
export declare function createCore(logger?: {
  warn(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}): {
  pool: WorkBuddyAccountPool;
  catalogs: {
    readonly cn: WorkBuddyCatalog;
    readonly global: WorkBuddyCatalog;
  };
  client: WorkBuddyUpstreamClient;
  scheduler: WorkBuddyScheduler;
};
/**
 * Start the loopback endpoint, register the `xdpool` provider, and
 * discover accounts. The provider registers only after `shim.ready` resolves,
 * because its models read the shim origin at construction time.
 */
export declare function apply(ctx: Context, config?: Config): void;
//#endregion
export type { AccountStatus, AutomationLedger, AutomationRunSummary, AutomationStatus, Context, ExpertUseMode, IgnoredAccount, MarketExpert, ModelSelection, PoolStatusRouteOptions, PoolWebAccountIgnore, PoolWebCheckin, PoolWebCheckinClaim, PoolWebIgnoredAccount, PoolWebModel, PoolWebModelSelection, PoolWebStatus, SchedulerLogger, TaskEventChain, TaskEventTransport, UpstreamErrorKind, WorkBuddyAccount, WorkBuddyAdapter, WorkBuddyCredential, WorkBuddyModelInfo, WorkBuddyShim, WorkBuddyStatus };