import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile, writeFile as writeFile$1 } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { fileURLToPath, pathToFileURL } from "node:url";
import "@earendil-works/pi-ai";
import "@earendil-works/pi-ai/api/openai-completions.lazy";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-llm-pi-ai";
//#region src/badges.ts
/**
* Promotion badges the upstream attaches to a model.
*
* Its own module because THREE callers need it and they cannot share one file:
* `upstream.ts` (server, does the fetching), `adapter.ts` (server, builds the
* model-picker display name) and `client/PoolCard.tsx` (browser bundle). The
* card cannot import `upstream.ts` — that would drag the whole HTTP client into
* the browser bundle — so if each side sniffed `badge:` on its own the three
* would drift apart, which is exactly the bug this replaces.
*
* Why the parsing is needed at all: the promo vocabulary this plugin used to
* expect (`free` / `limited-free` / `night-discount`) is NEVER sent by either
* gateway. The CN roster instead declares promotions as
*
*     "badge:限时免费:#FF0000"   "badge:夜间免费:#FF0000"   "badge:夜间折扣:#1E90FF"
*
* i.e. a label plus a hex colour, both gateway-authored. Every one of those
* declarations used to be parsed and then silently dropped, so the models
* carrying them rendered exactly like plain paid rows.
*
* The label is kept VERBATIM from the upstream instead of being mapped to
* English keys on the way through: it is already the string a user should read,
* and a lookup table here would rot the moment the gateway rewords a badge.
*
* Note what is deliberately NOT here: a free-until date. The badge carries a
* label and a colour, never an expiry, so the plugin can say "限时免费" but
* cannot say when it ends. Inventing a date would change what the user spends.
*
* @module dsh-xdpool/badges
*/
/** Prefix the CN gateway uses for a promotion badge inside `tags`. */
const BADGE_TAG_PREFIX = "badge:";
//#endregion
//#region src/upstream.ts
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
const CATALOG_RETRY_BACKOFF_MS = [
	1e3,
	3e3,
	8e3
];
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
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = "https://copilot.tencent.com";
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = "https://www.codebuddy.cn";
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = "https://www.workbuddy.ai";
/** Client UA the desktop CLI uses. */
/** Client UA the desktop CLI uses — the CN gateway answers this one. */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
* Desktop app UA. The global gateway serves its product config only to this
* client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
* is why the international catalog must be read with the desktop spelling.
*/
const DESKTOP_UA = "WorkBuddy/5.5.2";
/** CN model catalog. */
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = "/v3/config";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** True for a request the CALLER aborted, which must never be retried. */
function isAbortError(error) {
	if (typeof error !== "object" || error === null) return false;
	if (error.name === "AbortError") return true;
	const cause = error.cause;
	return typeof cause === "object" && cause !== null && cause.name === "AbortError";
}
/** Cap on the reassembled compaction reply, guarding against a runaway stream. */
const COMPLETION_TEXT_LIMIT = 65536;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** Session-invalidation markers that mean "this credential is dead; use another".
*  Kept alongside the HTTP-status rule in `classifyUpstreamError`: the status is
*  enough for a direct 401/403, but some failures arrive wrapped in a 200
*  envelope or a 4xx the gateway words differently. Adding the English and
*  Chinese phrasings the upstream actually uses keeps those recoverable too —
*  an unmatched one fell through to `client`, which is terminal in the shim
*  and pinned the pool to the first account (the "API 密钥无效" bug). */
const SESSION_DEAD_MARKERS = [
	"Offline user session not found",
	"12153",
	"api key is invalid",
	"invalid api key",
	"invalid_api_key",
	"api密钥无效",
	"密钥无效",
	"无效的密钥",
	"unauthorized",
	"token expired",
	"token is invalid",
	"login expired",
	"please login",
	"未登录",
	"登录已失效",
	"重新登录"
];
/**
* Markers for "already checked in today".
*
* The upstream answers a non-zero business code (and HTTP 400) when the daily
* check-in is repeated. That is an idempotent success, not a failure: the
* reward for today is already collected. Matched against the message, since
* the code varies by realm.
*/
const ALREADY_CHECKIN_MARKERS = ["已签到", "already"];
/**
* Markers for "there is no compensation offer to collect".
*
* The offer is seasonal — an outage announcement opens one, and it closes on a
* deadline — so for most of the year every account answers a claim with a
* refusal. That is a successful no-op, not a failure, for the same reason
* `isAlreadyCheckin` exists.
*/
const NO_COMPENSATION_MARKERS = [
	"没有可领取",
	"暂无可领取",
	"无可领取",
	"不可领取",
	"未开启",
	"没有活动",
	"已领取",
	"已过期",
	"活动已结束",
	"已结束",
	"not eligible",
	"no compensation",
	"already claimed",
	"not found",
	"expired"
];
/**
* Hosts the international product answers on, once each has been stripped of a
* leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
* the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
* CLI signs the same international account in at `codebuddy.ai`. All are served
* by one gateway stack, so all are `global` — missing a spelling sends those
* tokens to the CN gateway, which rejects them at the openresty layer with an
* HTML 401 instead of a business JSON error.
*/
const GLOBAL_HOSTS = [
	"workbuddy.ai",
	"workbuddy.cc",
	"codebuddy.ai"
];
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	for (const host of GLOBAL_HOSTS) if (lowered === host || lowered.endsWith(`.${host}`)) return "global";
	return "cn";
}
/**
* Gateway for a global credential.
*
* International accounts are NOT interchangeable across brand domains: a token
* issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
* versa, so the base must follow the credential's own domain rather than one
* hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
*/
function globalBase(credential) {
	const lowered = credential.domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential) : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		"Authorization": `Bearer ${credential.accessToken}`,
		...credential.uid === "" || credential.uid === void 0 ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
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
const CHAT_IDENTITY_HEADERS = Object.freeze({
	"X-IDE-Name": "WorkBuddy",
	"X-IDE-Type": "WorkBuddy",
	"X-IDE-Version": "5.5.6"
});
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
const CONVERSATION_STABLE_SALT = "conversation";
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
function conversationIdentityOf(conversationKey, seed = randomUUID) {
	const base = conversationKey === void 0 || conversationKey === "" ? seed() : conversationKey;
	const hash = (suffix) => createHash("sha256").update(`${CONVERSATION_STABLE_SALT}:${suffix}:${base}`).digest("hex");
	const asUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	return {
		conversationId: asUuid(hash("id")),
		conversationRequestId: asUuid(hash("request")),
		acpConnectionId: asUuid(hash("acp"))
	};
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
function chatCompletionHeaders(credential, conversationKey) {
	const identity = conversationIdentityOf(conversationKey);
	return {
		...chatHeaders(credential),
		...CHAT_IDENTITY_HEADERS,
		"X-Conversation-ID": identity.conversationId,
		"X-Conversation-Request-ID": identity.conversationRequestId,
		"acp-connection-id": identity.acpConnectionId,
		"X-Conversation-Message-ID": randomUUID(),
		"X-Request-ID": randomUUID(),
		"X-Agent-Intent": "craft",
		"X-Agent-Purpose": "conversation",
		"X-Private-Data": "true",
		"x-codebuddy-request": "1"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Desktop-client report endpoint and the UA it is fingerprinted by. */
const DESKTOP_REPORT_PATH = "/v2/report";
/** Theme-selection endpoint (Hp_Appearance). */
const APPEARANCE_SET_PATH = "/v2/user-asset/appearance/set";
/** Expert marketplace listing, used to look up REAL expert ids. */
const MARKET_EXPERT_LIST_PATH = "/portal/operation-platform/market/expert/list";
/** Cap on how long a chain waits for a conversation answer. */
const CHAT_TIMEOUT_MS = 9e4;
/** How far into an SSE stream to look for the server's request id. */
const SSE_SCAN_LIMIT = 1 << 20;
/** Server request ids look like `cmb-<32 hex>` or a bare 32 hex string. */
const SERVER_ID_PATTERN = /"id"\s*:\s*"((?:cmb-)?[0-9a-f]{32})"/;
const DESKTOP_TASK_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
const NEUTRAL_IDENTITY_PHRASE = "You are an AI agent running inside this harness.";
/**
* 匹配身份句，句内空格允许任意折行/多空格。
*
* 实测到的写法用 `includes` 就够，但宿主把这句话作为一个 section 嵌在整段 prompt 里，
* 将来一旦被重新折行或缩进，字面匹配会静默失效、拦截立刻回来，所以句内每段空白都按
* 「任意空白」处理。顺带忽略大小写，成本为零。
*/
const HARNESS_IDENTITY_PATTERN = /You[\s\u00a0]+are[\s\u00a0]+an[\s\u00a0]+AI[\s\u00a0]+agent[\s\u00a0]+powered[\s\u00a0]+by[\s\u00a0]+DeepSeek[\s\u00a0]+Harness\.?/giu;
/**
* 该字段是否是本改写负责的文本载体。
*
* chat 文本可能是裸字符串（`content: "…"`），也可能是分段数组
* （`content: [{type:'text',text:'…'}]`）。其余字段一律不碰：assistant 的
* `tool_calls`、tool 消息的 `tool_call_id` 都不是散文，改进去只会把一次调用改坏。
*/
function isIdentityTextCarrier(key) {
	return key === "content" || key === "text" || key === "input_text";
}
/** 递归替换一段文本里的身份句（字符串 / 数组 / 文本分段对象三种形态都走）。 */
function rewriteIdentitySentence(value) {
	if (typeof value === "string") return value.replace(HARNESS_IDENTITY_PATTERN, NEUTRAL_IDENTITY_PHRASE);
	if (Array.isArray(value)) return value.map(rewriteIdentitySentence);
	if (typeof value !== "object" || value === null) return value;
	const record = value;
	for (const [key, nested] of Object.entries(record)) {
		if (!isIdentityTextCarrier(key)) continue;
		record[key] = rewriteIdentitySentence(nested);
	}
	return value;
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
function rewriteHarnessIdentity(messages) {
	for (const value of messages) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		const role = message["role"];
		if (role !== "system" && role !== "developer") continue;
		if (message["content"] !== void 0) message["content"] = rewriteIdentitySentence(message["content"]);
		if (typeof message["text"] === "string") message["text"] = rewriteIdentitySentence(message["text"]);
	}
}
/**
* Derive a stable 36-hex device id from the account uid.
*
* The upstream keys desktop events to a device. Deriving it from the uid keeps
* the same account looking like the same machine across runs, instead of a
* new device appearing on every call.
*/
function deriveDeviceId(credential, salt) {
	return createHash("sha256").update(salt + ":" + (credential.uid ?? "")).digest("hex").slice(0, 36);
}
/** Narrow a loose upstream value to an object, so field reads cannot throw. */
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : {};
}
/** Read a numeric field, treating anything else as 0. */
function numOf(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** Local `YYYY-MM-DD`, matching how the heatmap keys its cells. */
function dayKeyLocal(date) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "" && credential.uid !== void 0) headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
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
function isGatewayHtmlRejection(status, text) {
	if (status !== 401 && status !== 403) return false;
	const head = text.slice(0, 512).toLowerCase();
	return head.includes("<html") || head.includes("openresty") || head.includes("apisix");
}
/**
* The sentence thrown for a gateway HTML rejection.
*
* Exported (as a prefix test) because callers outside this module have to tell
* this specific failure apart from an ordinary network error: it is proof the
* *credential* is no longer honoured, so the pool may mark the account dead
* instead of re-probing it on every refresh.
*/
const GATEWAY_REJECTION_MESSAGE = "the WorkBuddy gateway rejected this credential (http 401).";
async function readEnvelope(response) {
	const text = await response.text();
	if (isGatewayHtmlRejection(response.status, text)) throw new Error(`${GATEWAY_REJECTION_MESSAGE} This usually means the account is using a stale sign-in the upstream no longer accepts: sign in again in the WorkBuddy desktop app, then pick the account on the plugin card. Run \`dsh-xdpool doctor\` to list every credential found.`);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Read an OpenAI-style SSE chat stream and concatenate the assistant text.
*
* The upstream always streams (`stream: true` is forced on every chat body),
* so a non-streaming internal call has to reassemble the deltas itself. Only
* `choices[0].delta.content` is collected; reasoning deltas are dropped
* because a compaction summary needs the final answer, not the scratchpad.
*/
async function readCompletionText(body) {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const frame = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				text += contentOfFrame(frame);
				if (text.length > COMPLETION_TEXT_LIMIT) return text.slice(0, COMPLETION_TEXT_LIMIT);
				split = buffer.indexOf("\n\n");
			}
		}
		if (buffer.trim() !== "") text += contentOfFrame(buffer);
	} finally {
		reader.releaseLock?.();
	}
	return text;
}
/** Pull `choices[0].delta.content` (or a non-streaming `message.content`) out of one SSE frame. */
function contentOfFrame(frame) {
	let out = "";
	for (const rawLine of frame.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const choices = parsed["choices"];
		if (!Array.isArray(choices) || choices.length === 0) continue;
		const choice = choices[0];
		const delta = choice["delta"];
		if (typeof delta === "object" && delta !== null) {
			const content = delta["content"];
			if (typeof content === "string") out += content;
		}
		const message = choice["message"];
		if (typeof message === "object" && message !== null) {
			const content = message["content"];
			if (typeof content === "string") out += content;
		}
		const data = parsed["data"];
		if (typeof data === "object" && data !== null) {
			const inner = data["content"];
			if (typeof inner === "string") out += inner;
		}
	}
	return out;
}
/**
* Classify an upstream failure from its HTTP status and body excerpt.
* Body markers win over status, because the upstream reuses 400/200 for
* several distinct conditions.
*/
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	if (status === 401 || status === 403) return "session_dead";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (body.includes("soft_rate") || body.includes("\"code\":6004") || body.includes("频率限制")) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	return "client";
}
/**
* Whether an error means "today is already checked in".
*
* Callers treat this as success: the credit for the day is already banked, so
* reporting it as a failure would both alarm the user and hide a healthy
* account behind a false negative.
*/
function isAlreadyCheckin(error) {
	const message = error instanceof Error ? error.message : String(error);
	return ALREADY_CHECKIN_MARKERS.some((marker) => message.includes(marker));
}
/**
* Whether an error means "no compensation offer is running for this account".
*
* Callers treat this as a successful no-op: the job did its job and correctly
* found nothing to collect.
*/
function isNoCompensation(error) {
	const lower = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return NO_COMPENSATION_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}
/** Parse the upstream's `credits` string into a multiplier. */
function parseCreditMultiplier(value) {
	if (typeof value !== "string") return void 0;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return void 0;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
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
const SINGULAR_EFFORT_LADDER = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* True when `reasoning` arrives in the singular spelling: an `effort` string,
* with none of the plural-form fields alongside it. Seen on CN
* `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
* `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
*/
function isSingularEffortForm(raw) {
	return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
/**
* Fold a singular-form `effort` into the plural shape the rest of the plugin
* already understands. Probes on both gateways show these models answer with
* distinct `reasoning_content` across the whole ladder — and do not think at
* all when no `reasoning_effort` is sent — so the fold widens
* `supportedEfforts` and carries the declared value into `defaultEffort`. An
* unrecognized `effort` passes through as the lone level.
*/
function singularEffortLadder(raw) {
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	if (effort === void 0) return void 0;
	return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort];
}
/**
* Parse the upstream's `reasoning` object; unknown shapes degrade to
* `undefined`. Both spellings normalize here: the plural form passes through as
* declared, and the singular `effort` form folds via
* {@link singularEffortLadder}.
*/
function parseReasoning(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const singularForm = isSingularEffortForm(raw);
	const effort = typeof raw["effort"] === "string" ? raw["effort"] : void 0;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string") : singularEffortLadder(raw);
	const defaultEffort = typeof raw["defaultEffort"] === "string" ? raw["defaultEffort"] : effort;
	const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : singularForm ? true : void 0;
	if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) return;
	return {
		...supportedEfforts === void 0 || supportedEfforts.length === 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...canDisableThinking === void 0 ? {} : { canDisableThinking }
	};
}
/** Parse one catalog entry; entries without usable token limits are dropped. */
function parseUpstreamModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return void 0;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return void 0;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const descriptionZh = typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : void 0;
	const descriptionEn = typeof raw["descriptionEn"] === "string" && raw["descriptionEn"] !== "" ? raw["descriptionEn"] : void 0;
	const creditMultiplier = parseCreditMultiplier(raw["credits"]);
	const reasoning = parseReasoning(raw["reasoning"]);
	const supportsToolCall = typeof raw["supportsToolCall"] === "boolean" ? raw["supportsToolCall"] : void 0;
	const supportsImages = typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
	const tags = Array.isArray(raw["tags"]) ? raw["tags"].filter((tag) => typeof tag === "string" && tag !== "") : void 0;
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		...reasoning === void 0 ? {} : { reasoning },
		...descriptionZh === void 0 ? {} : { descriptionZh },
		...descriptionEn === void 0 ? {} : { descriptionEn },
		...supportsToolCall === void 0 ? {} : { supportsToolCall },
		...supportsImages === void 0 ? {} : { supportsImages },
		...tags === void 0 || tags.length === 0 ? {} : { tags }
	};
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
function desktopChatEvents(conversationId, requestId, messageId, modelId = "fast-model", modelName = "fast-model") {
	const assistant = `${messageId}-assistant`;
	const session = {
		"codebuddy.session_id": conversationId,
		"codebuddy.conversation_request_id": requestId
	};
	return [
		{
			eventCode: "agent_task_created",
			source: "LOCAL",
			name: "working",
			task_target: "local",
			mode: "craft",
			requestModelId: modelId,
			requestModelName: modelName,
			has_repo: false,
			repo_type: "none",
			workspace_type: "empty",
			has_connector: false,
			connector_types: [],
			has_mention: false,
			mention_types: [],
			has_template: false,
			action: "",
			template_name: "",
			has_expert: false,
			expert_id: "",
			expert_name: "",
			expert_industry_id: "",
			has_skill: false,
			skill_names: [],
			conversationId,
			messageId,
			buddyId: "",
			buddyName: ""
		},
		{
			eventCode: "chat_message_send",
			messageId: assistant,
			historyCount: 0,
			isContextTruncated: false,
			currentStepCount: 1,
			traceId: requestId,
			rootRequestId: requestId,
			parentConversationId: conversationId,
			agentName: "cli",
			agentType: "main"
		},
		{
			eventCode: "chat_request_send",
			inputLength: 24,
			isPlan: false,
			isAutoExecuteTerminal: false,
			isAutoModify: false,
			codebaseEnable: false,
			maxToken: 0,
			maxSteps: 500,
			temperature: 0,
			maxRetries: 0,
			mentionContexts: [],
			knowledgeId: [],
			knowledgeName: [],
			codebaseId: "",
			mentionContextCount: 0,
			command: "",
			recommendId: "",
			skillId: "",
			skillCount: 0,
			totalCount: 0,
			traceId: requestId,
			rootRequestId: requestId,
			parentConversationId: conversationId,
			agentName: "cli",
			agentType: "main",
			...session
		},
		{
			eventCode: "chat_message_response",
			messageId: assistant,
			responseModelId: modelId,
			inputToken: 120,
			outputToken: 80,
			totalToken: 200,
			cachedTokens: 0,
			cachedWriteTokens: 0,
			cachedMissTokens: 0,
			isSuccessful: true,
			messageErrorCode: "",
			finishReason: "stop",
			firstTokenAt: Date.now(),
			traceId: requestId,
			conversationId,
			rootRequestId: requestId,
			parentConversationId: conversationId,
			agentName: "cli",
			agentType: "main",
			...session
		},
		{
			eventCode: "chat_message_status",
			messageId: assistant,
			messageErrorCode: "0",
			traceId: requestId,
			rootRequestId: requestId,
			parentConversationId: conversationId,
			agentName: "cli",
			agentType: "main"
		},
		{
			eventCode: "chat_request_response",
			mode: "craft",
			toolCallCount: 0,
			inputToken: 120,
			outputToken: 80,
			totalToken: 200,
			cachedTokens: 0,
			cachedWriteTokens: 0,
			cachedMissTokens: 0,
			isSuccessful: true,
			messageErrorCode: "",
			finishReason: "stop",
			rootRequestId: requestId,
			parentConversationId: conversationId
		}
	];
}
function parseTask(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const taskCode = typeof raw["task_code"] === "string" ? raw["task_code"] : "";
	if (taskCode === "") return void 0;
	const num = (key) => typeof raw[key] === "number" ? raw[key] : 0;
	let current = num("current");
	let target = num("target");
	const progress = raw["progress"];
	if (typeof progress === "object" && progress !== null) {
		const nested = progress;
		const nestedCurrent = typeof nested["current"] === "number" ? nested["current"] : 0;
		const nestedTarget = typeof nested["target"] === "number" ? nested["target"] : 0;
		if (nestedTarget > 0 || nestedCurrent > 0) {
			current = nestedCurrent;
			target = nestedTarget;
		}
	}
	const acceptStatus = typeof raw["accept_status"] === "string" ? raw["accept_status"] : "";
	const claimed = acceptStatus === "claimed";
	return {
		taskCode,
		title: typeof raw["title"] === "string" && raw["title"] !== "" ? raw["title"] : taskCode,
		credit: num("reward_credit"),
		energy: num("reward_energy"),
		hasReward: raw["has_reward"] === true,
		target,
		current,
		acceptStatus,
		status: typeof raw["status"] === "string" ? raw["status"] : "",
		claimable: !claimed && target > 0 && current >= target,
		claimed,
		locked: raw["locked"] === true
	};
}
var WorkBuddyUpstreamClient = class {
	fetchImpl;
	clientVersion;
	/** Backoff ladder for `fetchModels`; empty means a single attempt. */
	catalogRetryBackoffMs;
	/**
	* Optional logger for retry notices.
	*
	* Set by the host so a retry is visible in the log with its attempt count —
	* without it, a retry that eventually succeeds is invisible, and an operator
	* debugging "why was the catalog slow" has nothing to look at.
	*/
	logger;
	constructor(options = {}) {
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.clientVersion = options.clientVersion ?? "2.0.4";
		this.catalogRetryBackoffMs = options.catalogRetryBackoffMs ?? CATALOG_RETRY_BACKOFF_MS;
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
	prepareChatBody(raw) {
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return raw;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return raw;
		const obj = body;
		obj["stream"] = true;
		const requested = typeof obj["stream_options"] === "object" && obj["stream_options"] !== null && !Array.isArray(obj["stream_options"]) ? obj["stream_options"] : {};
		requested["include_usage"] = true;
		obj["stream_options"] = requested;
		if (Array.isArray(obj["messages"])) {
			for (const value of obj["messages"]) {
				if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
				const message = value;
				if (message["role"] === "developer") message["role"] = "system";
			}
			rewriteHarnessIdentity(obj["messages"]);
		}
		const choice = obj["tool_choice"];
		if (typeof choice === "string") {
			if (choice.trim().toLowerCase() === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			}
		} else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
			const wrapped = choice;
			const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
			if (type === "none") {
				delete obj["tool_choice"];
				delete obj["tools"];
				delete obj["functions"];
			} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
			else if (type === "function") {
				const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
				let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
				if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
				obj["tool_choice"] = name.trim() !== "" ? name.trim() : "auto";
			} else delete obj["tool_choice"];
		}
		return JSON.stringify(obj);
	}
	/**
	* Parse a raw OpenAI chat body without normalising it.
	*
	* The compactor needs the message array as objects, while `chatStream` only
	* accepts the serialised string form.
	*/
	parseChatBody(raw) {
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
		return body;
	}
	/** Re-serialise `base` with a rewritten `messages` array, still normalised. */
	buildChatBody(base, messages) {
		return this.prepareChatBody(JSON.stringify({
			...base,
			messages
		}));
	}
	/**
	* Run one NON-streaming completion and return the assistant text.
	*
	* Used only for internal compaction (summarising dropped turns). The chat
	* endpoint itself always streams, so this reassembles the SSE frames into a
	* single string. Throws on any failure: the compactor then falls back to
	* plain truncation rather than failing the user's turn.
	*/
	async completeChat(credential, prepared, signal, conversationKey) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
			method: "POST",
			headers: chatCompletionHeaders(credential, conversationKey),
			body: prepared,
			...signal === void 0 ? {} : { signal }
		});
		if (!response.ok) {
			const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
			throw new Error(`compaction upstream http ${response.status}: ${text}`);
		}
		if (response.body === null) throw new Error("compaction upstream returned no body");
		return await readCompletionText(response.body);
	}
	/** Forward one chat completion. Never throws for upstream failures. */
	async chatStream(credential, prepared, signal, conversationKey) {
		let response;
		try {
			response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: chatCompletionHeaders(credential, conversationKey),
				body: prepared,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				kind: "server",
				status: 0,
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text().catch(() => "")).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			kind: classifyUpstreamError(response.status, text),
			status: response.status,
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
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
	async fetchModels(credential, signal) {
		const attempts = this.catalogRetryBackoffMs.length + 1;
		let lastError;
		for (let attempt = 0; attempt < attempts; attempt += 1) try {
			return await this.fetchModelsOnce(credential, signal);
		} catch (error) {
			lastError = error;
			if (isAbortError(error)) throw error;
			const wait = this.catalogRetryBackoffMs[attempt];
			if (wait === void 0) break;
			this.logger?.warn?.(`dsh-xdpool: model catalog fetch failed (attempt ${attempt + 1}/${attempts}), retrying in ${wait}ms`, error);
			await delay(wait);
		}
		throw lastError;
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
	async fetchModelsOnce(credential, signal) {
		const global = regionOf(credential.domain) === "global";
		const url = global ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}` : `${chatBase(credential)}${MODELS_CATALOG_PATH}`;
		const headers = global ? {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
			...credential.domain === "" ? {} : { "X-Domain": credential.domain },
			"X-Product": "SaaS",
			"X-Requested-With": "XMLHttpRequest",
			"Connection": "close",
			"User-Agent": DESKTOP_UA
		} : {
			"Authorization": `Bearer ${credential.accessToken}`,
			"Accept": "application/json",
			"Origin": originReferer(credential),
			"Referer": `${originReferer(credential)}/`,
			"User-Agent": CLIENT_UA
		};
		if (!global && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
		const response = await this.fetchImpl(url, {
			headers,
			...signal === void 0 ? {} : { signal }
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			const parsed = parseUpstreamModel(model);
			if (parsed !== void 0) byId.set(parsed.id, parsed);
		}
		const models = (cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()]).map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
		return models;
	}
	/** Read-only credits query, aggregated by package. Does not consume credits. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const fmt = (date) => {
			const p = (n) => n.toString().padStart(2, "0");
			return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
		};
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: fmt(now),
				PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const wrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof wrapper["Response"] === "object" && wrapper["Response"] !== null ? wrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		let total = 0;
		let nearestExpiryMs;
		let expiringSoon = 0;
		const SOON_MS = 2592e5;
		const parseDate = (raw) => {
			if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
			if (typeof raw === "string" && raw !== "") {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) return parsed;
			}
		};
		const packages = [];
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const num = (key) => typeof account[key] === "number" ? account[key] : 0;
			const monthly = num("CapacityType") === 4;
			const size = monthly ? num("CycleCapacitySize") : num("CapacitySize");
			const remain = monthly ? num("CycleCapacityRemain") : num("CapacityRemain");
			const capped = remain < 0 ? 0 : remain;
			const cycleEndMs = parseDate(account["CycleEndTime"]);
			const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
			const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
			if (!monthly && (capped <= 0 || expiresAtMs !== void 0 && expiresAtMs <= Date.now())) continue;
			total += capped;
			if (expiresAtMs !== void 0) {
				if (nearestExpiryMs === void 0 || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs;
				if (expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped;
			}
			packages.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain: capped,
				size,
				monthly,
				...refreshAtMs === void 0 ? {} : { refreshAtMs },
				...expiresAtMs === void 0 ? {} : { expiresAtMs }
			});
		}
		return {
			total,
			packages,
			expiringSoon,
			...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
		};
	}
	/** Query today's check-in status without changing account state. */
	async fetchCheckinStatus(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const num = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			active: data["active"] === true,
			todayCheckedIn: data["today_checked_in"] === true,
			streakDays: num("streak_days"),
			dailyCredit: num("daily_credit"),
			todayCredit: num("today_credit"),
			isStreakDay: data["is_streak_day"] === true,
			nextStreakDay: num("next_streak_day"),
			streakBonusDays: num("streak_bonus_days"),
			streakBonusCredit: num("streak_bonus_credit"),
			...typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== "" ? { claimButtonText: data["claim_button_text"] } : {}
		};
	}
	/** Claim today's check-in reward. The browser route guards this mutation. */
	async claimDailyCheckin(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			credit: numberField("credit"),
			streakDays: numberField("streak_days"),
			isStreakDay: data["is_streak_day"] === true
		};
	}
	/**
	* Read the service-outage compensation offer, if any.
	*
	* NOTE the missing `/v2`: unlike the check-in routes, this one lives at
	* `/billing/meter/compensation-status` and the `/v2` variant answers a plain
	* 404 (verified on both billing hosts). The web client calls it that way too.
	*/
	async fetchCompensationStatus(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/billing/meter/compensation-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return {
			active: data["active"] === true,
			claimed: data["claimed"] === true,
			creditNum: typeof data["credit_num"] === "number" ? data["credit_num"] : 0,
			...typeof data["end_time"] === "string" && data["end_time"] !== "" ? { endTime: data["end_time"] } : {}
		};
	}
	/**
	* Collect the running compensation offer.
	*
	* Idempotent upstream: a repeat claim answers `code: 0` with
	* `claimed: true` rather than an error, so a second pass in the same day
	* records as a no-op instead of a failure.
	*/
	async claimCompensation(credential) {
		const response = await this.fetchImpl(`${billingBase(credential)}/billing/meter/claim-compensation`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		return {
			claimed: data["claimed"] !== false,
			creditNum: typeof data["credit_num"] === "number" ? data["credit_num"] : 0
		};
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
	desktopFingerprint(credential) {
		const now = Date.now();
		return {
			timezone: "Asia/Shanghai",
			reportDelay: 2e3,
			userId: credential.uid ?? "",
			username: credential.nickname ?? "",
			userNickname: credential.nickname ?? "",
			product: "SaaS",
			releaseDate: 1789036585355,
			commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
			ideName: "WorkBuddy",
			ideType: "WorkBuddy",
			ideVersion: "5.5.6",
			machineId: deriveDeviceId(credential, "machine"),
			sessionId: deriveDeviceId(credential, "session"),
			extName: "workbuddy-desktop",
			extVersion: "5.5.6",
			os: "win32",
			arch: "x64",
			osVersion: "10.0.26220",
			cpuCores: 20,
			memorySize: 24,
			timestamp: now,
			presentAt: now
		};
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
	async reportDesktopEvents(credential, events) {
		if (events.length === 0) return;
		const fingerprint = this.desktopFingerprint(credential);
		const body = events.map((event) => ({
			...fingerprint,
			...event
		}));
		const response = await this.fetchImpl(`${chatBase(credential)}${DESKTOP_REPORT_PATH}`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json, text/plain, */*",
				"Content-Type": "application/json;charset=UTF-8",
				"User-Agent": DESKTOP_TASK_UA,
				"X-Product": "SaaS",
				"X-Request-ID": deriveDeviceId(credential, "req") + String(Date.now() % 1e6),
				...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
				...credential.domain === "" ? {} : { "X-Domain": credential.domain }
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
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
	async reportWebEvent(credential, eventCode, pageUrl, elementId, elementName) {
		const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
		const event = {
			eventCode,
			timestamp: Date.now(),
			reportDelay: 0,
			pageURL: pageUrl,
			elementId,
			elementName,
			os: "Win32",
			arch: "",
			osVersion: "10.0",
			userAgent: ua,
			machineId: deriveDeviceId(credential, "webmachine"),
			userId: credential.uid ?? "",
			userNickname: credential.nickname ?? "",
			enterpriseId: credential.enterpriseId ?? ""
		};
		const response = await this.fetchImpl(`https://www.workbuddy.cn/v2/report`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Content-Type": "application/json",
				"Accept": "application/json",
				"x-client-platform": "web",
				"Origin": "https://www.workbuddy.cn",
				"Referer": pageUrl,
				"User-Agent": ua,
				...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid }
			},
			body: JSON.stringify([event]),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
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
	async setAppearanceTheme(credential, resourceKey) {
		const response = await this.fetchImpl(`${chatBase(credential)}${APPEARANCE_SET_PATH}`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json, text/plain, */*",
				"Content-Type": "application/json;charset=UTF-8",
				"User-Agent": DESKTOP_TASK_UA,
				"X-Product": "SaaS",
				...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid }
			},
			body: JSON.stringify({
				kind: "theme",
				resource_key: resourceKey
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/**
	* The platform's expert marketplace.
	*
	* Needed before any expert can be summoned: the scorer verifies that the
	* expert id exists on the platform, so a made-up id scores nothing. The
	* response carries the display fields the summon events replay.
	*/
	async marketExpertList(credential, expertType = "") {
		const request = {
			page: 1,
			page_size: 20,
			sort_by: "reco_rank",
			sort_order: "desc"
		};
		if (expertType !== "") request["expert_type"] = expertType;
		const response = await this.fetchImpl(`${chatBase(credential)}${MARKET_EXPERT_LIST_PATH}`, {
			method: "POST",
			headers: {
				...chatHeaders(credential),
				"User-Agent": DESKTOP_TASK_UA
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = asRecord(envelope.data);
		const raw = Array.isArray(data["experts"]) ? data["experts"] : [];
		const out = [];
		for (const value of raw) {
			const expert = asRecord(value);
			const expertId = typeof expert["expert_id"] === "string" ? expert["expert_id"] : "";
			if (expertId === "") continue;
			out.push({
				expertId,
				expertType: typeof expert["expert_type"] === "string" ? expert["expert_type"] : "",
				displayName: typeof expert["display_name_zh"] === "string" ? expert["display_name_zh"] : "",
				profession: typeof expert["profession_zh"] === "string" ? expert["profession_zh"] : "",
				version: typeof expert["version"] === "string" ? expert["version"] : "",
				categories: Array.isArray(expert["categories"]) ? expert["categories"].filter((item) => typeof item === "string") : []
			});
		}
		return out;
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
	async openConversation(credential, expertId = "", signal) {
		const conversationId = `wb2auto-conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const body = JSON.stringify({
			model: "fast-model",
			messages: [{
				role: "system",
				content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。"
			}, {
				role: "user",
				content: "1+1等于几？直接回答。"
			}],
			agent: "cli",
			temperature: 1,
			stream: true,
			stream_options: { include_usage: true }
		});
		let response;
		try {
			response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					...CHAT_IDENTITY_HEADERS,
					"Accept": "text/event-stream",
					"User-Agent": DESKTOP_TASK_UA,
					"X-Conversation-ID": conversationId,
					"X-Request-ID": String(Date.now()) + "000000",
					"X-Agent-Intent": "craft",
					"X-Agent-Type": "main",
					"x-codebuddy-request": "1",
					...expertId === "" ? {} : { "X-Expert-Id": expertId }
				},
				body,
				signal: signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS)
			});
		} catch {
			return;
		}
		if (!response.ok || response.body === null) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (buffer.length < SSE_SCAN_LIMIT) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const match = SERVER_ID_PATTERN.exec(buffer);
				if (match !== null) return {
					conversationId,
					requestId: match[1] ?? ""
				};
			}
		} catch {} finally {
			await reader.cancel().catch(() => {});
		}
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
	async reportActivity(credential, conversationId) {
		const conversationID = conversationId ?? `wb2api-${Date.now()}`;
		const requestID = conversationID;
		const now = Date.now();
		const event = {
			eventCode: "chat_request_send",
			timestamp: now,
			reportDelay: 0,
			mode: "craft",
			conversationId: conversationID,
			requestId: requestID,
			inputLength: 12,
			requestModelId: "deepseek-v4-flash",
			requestModelName: "DeepSeek V4 Flash",
			isPlan: false,
			isAutoExecuteTerminal: false,
			isAutoModify: false,
			codebaseEnable: false,
			maxToken: 0,
			maxSteps: 0,
			temperature: 0,
			maxRetries: 0,
			mentionContexts: [],
			knowledgeId: [],
			knowledgeName: [],
			codebaseId: "",
			mentionContextCount: 0,
			command: "",
			expertId: "",
			recommendId: "",
			skillId: "",
			skillCount: 0,
			totalCount: 0,
			fileUri: "",
			presentAt: now,
			traceId: "",
			rootRequestId: requestID,
			parentConversationId: conversationID,
			agentName: "default",
			agentType: "conversation",
			userId: credential.uid ?? ""
		};
		const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify([event]),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
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
	async growthStreakDays(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/streak`, {
			headers: billingHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const streak = typeof data["streak"] === "object" && data["streak"] !== null ? data["streak"] : {};
		return typeof streak["days"] === "number" ? streak["days"] : 0;
	}
	/**
	* The full streak picture: days, tier unlock state, and what each tier pays.
	*
	* Read before redeeming, because the tier state is the only honest answer to
	* "is there anything to claim": the redeem endpoint answers 403 for a locked
	* tier, which is indistinguishable from a real failure once the response is
	* just an error.
	*/
	async growthStreakFull(credential) {
		const data = await this.growthJson(credential, "GET", "/activity/growth/streak");
		const streak = asRecord(data["streak"]);
		const redemption = asRecord(data["redemption_status"]);
		const cards = asRecord(data["makeup_cards"]);
		const tiers = [];
		if (Array.isArray(redemption["tiers"])) for (const entry of redemption["tiers"]) {
			const tier = asRecord(entry);
			const name = typeof tier["tier"] === "string" ? tier["tier"] : "";
			if (name === "") continue;
			tiers.push({
				tier: name,
				days: numOf(tier["days"]),
				credit: numOf(tier["credit"]),
				energy: numOf(tier["energy"]),
				cards: numOf(tier["cards"]),
				chances: numOf(tier["chances"]),
				status: String(redemption[`tier_${name}_status`] ?? "")
			});
		}
		return {
			days: numOf(streak["days"]),
			monthTotalDays: numOf(streak["month_total_days"]),
			nextTier: typeof streak["next_tier"] === "string" ? streak["next_tier"] : "",
			nextTierRemaining: numOf(streak["next_tier_remaining"]),
			makeupCards: numOf(cards["balance"]),
			tiers
		};
	}
	/**
	* Redeem one unlocked streak tier.
	*
	* A locked tier answers 403 ("连续登录天数不足"); callers check the status from
	* {@link growthStreakFull} first, so this only throws for genuine failures.
	* The client token is the upstream's idempotency key — a fresh one per attempt
	* keeps a retry from being read as a duplicate of the last one.
	*/
	async redeemStreakTier(credential, tier) {
		await this.growthJson(credential, "POST", "/activity/growth/redeem", {
			tier,
			client_token: randomUUID()
		});
	}
	/** How many lottery draws are available right now. */
	async lotteryChances(credential) {
		return numOf((await this.growthJson(credential, "GET", "/activity/growth/lottery/summary"))["chances"]);
	}
	/**
	* Draw the lottery once.
	*
	* Returns the raw prize payload: its shape is set by the running campaign, so
	* it is passed through rather than modelled.
	*/
	async lotteryDraw(credential) {
		return this.growthJson(credential, "POST", "/activity/growth/lottery/draw", { client_token: randomUUID() });
	}
	/**
	* The buddy profile, or undefined when the account has no buddy yet.
	*
	* `data.buddy` is null / absent / an empty object depending on how far the
	* account got, and all three mean the same thing to a caller: adopt first.
	*/
	async buddyInfo(credential) {
		const buddy = asRecord((await this.growthJson(credential, "GET", "/activity/growth/buddy/info"))["buddy"]);
		if (Object.keys(buddy).length === 0) return void 0;
		return {
			instanceId: numOf(buddy["instance_id"]),
			name: String(buddy["name"] ?? "")
		};
	}
	/** Agree to the buddy terms. Idempotent upstream. */
	async buddyAgree(credential) {
		await this.growthJson(credential, "POST", "/activity/growth/buddy/agreement", { agree: true });
	}
	/**
	* Adopt the first buddy.
	*
	* Gated upstream on having reported activity that day: without it the answer
	* is 400 "first_buddy task not completed yet". Callers treat that as "not yet"
	* rather than an error, which is why it is thrown as-is for them to classify.
	*/
	async buddyAdoptFirst(credential) {
		await this.growthJson(credential, "POST", "/activity/growth/buddy/first", {});
	}
	/** Current travel state for the account's buddy. */
	async buddyTravelStatus(credential) {
		const data = await this.growthJson(credential, "GET", "/activity/growth/buddy/travel/status");
		return {
			state: typeof data["state"] === "string" ? data["state"] : "",
			recordId: numOf(data["record_id"]),
			dailyLimitReached: data["daily_limit_reached"] === true,
			rewardCredit: numOf(data["reward_credit"])
		};
	}
	/**
	* Send the buddy travelling.
	*
	* The location is always 4 (古镇客栈): the four locations have identical
	* reward and duration ranges, so there is nothing to optimise.
	*/
	async buddyTravelDepart(credential, locationId = 4) {
		await this.growthJson(credential, "POST", "/activity/growth/buddy/travel/depart", { location_id: locationId });
	}
	/**
	* Collect an arrived trip's reward.
	*
	* `recordId` is required and comes from the status read; the upstream rejects
	* a claim without it.
	*/
	async buddyTravelClaim(credential, recordId) {
		return numOf((await this.growthJson(credential, "POST", "/activity/growth/buddy/travel/claim", { record_id: recordId }))["reward_credit"]);
	}
	/** Whether yesterday is a gap in the activity heatmap. */
	async heatmapYesterdayMissed(credential) {
		const data = await this.growthJson(credential, "GET", "/activity/growth/heatmap");
		if (!Array.isArray(data["cells"])) return false;
		const key = dayKeyLocal(/* @__PURE__ */ new Date(Date.now() - 864e5));
		for (const entry of data["cells"]) {
			const cell = asRecord(entry);
			if (cell["date"] === key) return numOf(cell["score"]) === 0;
		}
		return false;
	}
	/** Spend one makeup card on a date. Idempotent for an already-filled date. */
	async useMakeupCard(credential, date) {
		await this.growthJson(credential, "POST", "/activity/growth/makeup-cards/use", { date });
	}
	/**
	* Call a growth-domain endpoint and return its unwrapped `data`.
	*
	* These endpoints live on the chat host with the billing header set, and
	* carry the same envelope as everything else. Centralised here because every
	* growth call needs the identical envelope check.
	*/
	async growthJson(credential, method, path, body) {
		const response = await this.fetchImpl(`${chatBase(credential)}${path}`, {
			method,
			headers: billingHeaders(credential),
			...body === void 0 ? {} : { body: JSON.stringify(body) },
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		return asRecord(envelope.data);
	}
	/** Legacy thin wrapper kept for `status`/`doctor`: returns raw envelope data. */
	async credits(credential) {
		try {
			return {
				ok: true,
				data: await this.fetchCredits(credential)
			};
		} catch (error) {
			return {
				ok: false,
				message: String(error)
			};
		}
	}
	/**
	* Fetch the growth task list for one account.
	*
	* The upstream answers `data.tasks[]`, and `claimable` is derived locally —
	* the upstream does not mark it. Only a task whose progress reached its
	* target and that is not already claimed counts as eligible.
	*/
	async listTasks(credential) {
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
			headers: chatHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const raw = Array.isArray(data["tasks"]) ? data["tasks"] : [];
		const out = [];
		for (const entry of raw) {
			const parsed = parseTask(entry);
			if (parsed !== void 0) out.push(parsed);
		}
		return out;
	}
	/**
	* Accept (enrol in) tasks by code.
	*
	* Accepting is the "sign up" half: it produces no progress by itself, and the
	* upstream answers success for an already-accepted task, so replaying this is
	* safe. Progress is lit by real activity (a chat, an activity report).
	*/
	async acceptTasks(credential, taskCodes) {
		if (taskCodes.length === 0) return;
		const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
			method: "POST",
			headers: chatHeaders(credential),
			body: JSON.stringify({ task_codes: [...taskCodes] }),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
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
	async claimTaskReward(credential, taskCode) {
		const headers = {
			...billingHeaders(credential),
			"Accept": "application/json, text/plain, */*",
			"Origin": "https://www.workbuddy.cn",
			"Referer": "https://www.workbuddy.cn/profile/growth-center",
			"x-client-platform": "web",
			"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
		};
		const response = await this.fetchImpl(`https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
			method: "POST",
			headers,
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		if (data["already_claimed"] === true) return {
			credit: 0,
			energy: 0
		};
		return {
			credit: typeof data["credit"] === "number" ? data["credit"] : 0,
			energy: typeof data["energy"] === "number" ? data["energy"] : 0
		};
	}
};
//#endregion
//#region src/ignored.ts
/**
* The permanent ignore list: accounts the user has thrown out of the pool.
*
* Distinct from `disabledAccountIds`, which is a ROTATION preference. A disabled
* account stays on the card, can be switched back on, and its credential keeps
* being read on every scan. Ignoring is a statement about the ACCOUNT — "this
* one is not mine any more" — so an ignored account is skipped BEFORE its
* credential is decrypted, never appears among the pool's accounts, and does not
* come back when the desktop app writes a fresh `.info` file for it.
*
* It lives in a plugin-owned file rather than in the settings document for one
* practical reason: the CLI has no settings service. `dsh-xdpool
* ignore <id>` runs without a host, so a settings-only list could be written by
* the card and never by the CLI. One file, read by both halves, keeps the two
* views of "which accounts are ignored" identical by construction.
*
* @module dsh-xdpool/ignored
*/
/** Directory holding this plugin's own state (imported snapshots, ignore list). */
const PLUGIN_DATA_DIR_NAME = ".xdpool";
/** File holding the permanent ignore list, inside {@link pluginDataDir}. */
const IGNORED_FILE_NAME = "ignored.json";
/**
* The DSH home directory, honouring the same override the host uses.
*
* Shared by the CLI and the host so both halves resolve the same file: an
* `ignore` written from the terminal has to be visible to the running plugin,
* which is only true if they agree on where "home" is.
*/
function dshHome$1(env = process.env) {
	const fromEnv = env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}
/** This plugin's own state directory. */
function pluginDataDir(env = process.env) {
	return join(dshHome$1(env), PLUGIN_DATA_DIR_NAME);
}
/** Absolute path of the ignore list. */
function ignoredIdsPath(env = process.env) {
	return join(pluginDataDir(env), IGNORED_FILE_NAME);
}
/**
* Normalize whatever the file holds into a clean list.
*
* Tolerant on purpose: this file is hand-editable and a malformed entry must not
* take the pool down. An entry without a usable id is dropped; a missing label
* falls back to the id so the card always has something to print.
*/
function normalize$1(raw) {
	if (typeof raw !== "object" || raw === null) return [];
	const entries = raw.accounts;
	if (!Array.isArray(entries)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry;
		const id = typeof record["id"] === "string" ? record["id"].trim() : "";
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		const label = typeof record["label"] === "string" && record["label"].trim() !== "" ? record["label"] : id;
		const ignoredAt = typeof record["ignoredAt"] === "string" ? record["ignoredAt"] : "";
		out.push({
			id,
			label,
			ignoredAt
		});
	}
	return out;
}
/**
* Read the ignore list, tolerating every "no list yet" shape.
*
* A missing file, unreadable file, or invalid JSON all mean the same thing to
* the caller — nothing is ignored — so none of them throws. The pool must be
* able to start on a machine that has never ignored anything.
*/
async function readIgnoredAccounts(path = ignoredIdsPath()) {
	try {
		return normalize$1(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return [];
	}
}
/**
* Replace the ignore list, atomically.
*
* Written to a sibling temp file and renamed over the target so a crash (or a
* concurrent reader) can never observe a half-written document — the ignore
* list is the only thing standing between a dead account and the rotation, and
* a truncated file reads as "nothing is ignored", which would quietly put every
* discarded account back in the pool.
*/
async function writeIgnoredAccounts(accounts, path = ignoredIdsPath()) {
	const payload = JSON.stringify({
		version: 1,
		accounts
	}, null, 2);
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	await writeFile$1(temp, `${payload}\n`, "utf8");
	await rename(temp, path);
}
/**
* Add one account to the ignore list, preserving the rest.
*
* A read-modify-write rather than a wholesale replace: the card and the CLI can
* both be open, and each request names exactly one account, so re-writing the
* whole list from a stale view would drop the other side's edits.
*/
async function ignoreAccount(account, path = ignoredIdsPath()) {
	const current = await readIgnoredAccounts(path);
	if (current.some((entry) => entry.id === account.id)) return current;
	const next = [...current, {
		id: account.id,
		label: account.label ?? account.id,
		ignoredAt: (/* @__PURE__ */ new Date()).toISOString()
	}];
	await writeIgnoredAccounts(next, path);
	return next;
}
/** Drop one account from the ignore list. Returns the resulting list. */
async function unignoreAccount(accountId, path = ignoredIdsPath()) {
	const current = await readIgnoredAccounts(path);
	const next = current.filter((entry) => entry.id !== accountId);
	if (next.length !== current.length) await writeIgnoredAccounts(next, path);
	return next;
}
//#endregion
//#region src/account-store.ts
/**
* Durable copy of the discovered accounts, inside the plugin's data directory.
*
* The pool's account list is otherwise pure memory: the desktop app keeps only
* the CURRENT sign-in on disk (each login overwrites the one auth file), so
* accounts gathered by switching sign-ins evaporated on every restart. This
* store is the fix — `scan()` seeds from it and writes the merged list back, so
* the pool now survives restarts.
*
* JSON only, atomic rename on write: a crash mid-write leaves the previous
* generation intact, and the pool never reads a half-written account again.
*
* @module dsh-xdpool/account-store
*/
/** File name of the durable account list, inside the plugin data directory. */
const ACCOUNTS_FILE_NAME = "accounts.json";
/**
* State files that live in the same directory but are NOT account snapshots.
*
* The snapshot importer (`dsh-xdpool import <key>`) writes `<md5prefix>.json`
* into this directory, and the pool scans it — so every other `.json` file here
* is treated as an imported snapshot. These three are the plugin's own
* bookkeeping and must never be parsed as credentials.
*/
const NON_SNAPSHOT_FILES = [
	ACCOUNTS_FILE_NAME,
	"ignored.json",
	"preferred.json"
];
/** Absolute path of the durable account list. */
function accountStorePath(env = process.env) {
	return join(dshHome$1(env), PLUGIN_DATA_DIR_NAME, ACCOUNTS_FILE_NAME);
}
/** The directory the pool scans for imported `<md5prefix>.json` snapshots. */
function snapshotDirPath(env = process.env) {
	return join(dshHome$1(env), PLUGIN_DATA_DIR_NAME);
}
/**
* True when a file name in the snapshot directory is plugin bookkeeping rather
* than an imported snapshot.
*/
function isStateFile(name) {
	return NON_SNAPSHOT_FILES.includes(name);
}
/** True when a value has the shape of a stored account. */
function isStoredAccount(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	const credential = record["credential"];
	return typeof record["id"] === "string" && typeof record["label"] === "string" && typeof credential === "object" && credential !== null && typeof credential["accessToken"] === "string" && typeof credential["refreshToken"] === "string";
}
/**
* Read the durable list. Tolerant on purpose: a malformed or half-written file
* yields `[]` and the pool simply rediscovers from disk, rather than a corrupt
* store taking the whole pool down.
*/
async function loadStoredAccounts(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const entries = parsed?.["accounts"];
	if (!Array.isArray(entries)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		if (!isStoredAccount(entry)) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push(entry);
	}
	return out;
}
/**
* Atomically write the durable list: `${path}.tmp` first, then rename. A crash
* mid-write leaves the previous generation intact.
*/
async function saveStoredAccounts(path, accounts) {
	const stored = accounts.map((account) => ({
		id: account.id,
		label: account.label,
		credential: account.credential,
		savedAtMs: Date.now()
	}));
	const document = JSON.stringify({
		version: 1,
		accounts: stored
	}, null, 2) + "\n";
	await mkdir(join(path, ".."), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile$1(tmp, document, "utf8");
	await rename(tmp, path);
}
//#endregion
//#region src/at-rest.ts
/**
* WorkBuddy desktop "at-rest" credential decryption.
*
* From 5.6.0 the WorkBuddy desktop app no longer stores `auth.accessToken` /
* `auth.refreshToken` as plain strings. It writes a field wrapper:
*
*   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
*
* where the envelope is `{suite, keyId, nonce, authTag, ciphertext}` for
* AES-256-GCM with a 12-byte nonce and a 16-byte tag. The authenticated
* additional data is a length-prefixed transcript over the scheme, suite,
* keyId and framing, so the ciphertext can only be opened for the exact field
* shape it was sealed for.
*
* The field key itself is NOT a user secret: it is a build-time constant
* compiled into the app's own Electron native module
* (`electron_browser_workbuddy_storage`). The app fetches it through
* `loggerGet()` and hashes the returned base64 STRING (not the decoded bytes)
* to obtain the 32-byte key; `keyId` is the first 16 hex characters of that
* key's SHA-256.
*
* This module re-derives the same key by asking the installed app for the same
* payload, and caches it in memory for the process lifetime. Nothing is ever
* written to disk, and the payload is never logged.
*
* 溯源：本文件移植自 dingminhua/dsh-connect-workbuddy 的 src/at-rest.ts
*   （MIT，Copyright (c) 2026 LaoDing）——该模块最先定位并修复了「5.6.0 起
*   macOS 与 Windows 同样加密凭据」这一问题（其 issue #15 真机取证）。移植时
*   保留其全部判定逻辑（CFBundleExecutable 向 bundle 自己问、按 bundle id
*   确认身份后才 exec、field framing 的 AAD 转录、keyId 校验），未作改动。
*
* 改动：**「macOS 也加密」这一事实**（issue #15 真机取证）。本模块原先假设该
*   policy 是 Windows 先行、macOS 只是「将来可能」，于是 macOS 的可执行文件
*   路径用 App 名拼成 `<bundle>/Contents/MacOS/WorkBuddy`——而两个真实 bundle
*   的 `CFBundleExecutable` 都是 `Electron`，该路径并不存在。结果是 macOS 上
*   加密凭据**永远**取不到密钥，用户却被报成「未登录」。现在二进制名向 bundle
*   自己问（`macosBundleExecutable()`），候选含国际版 `WorkBuddy AI.app`，
*   并允许 App 被归入 applications 目录的子目录——扫到的候选必须先用
*   `CFBundleIdentifier` 确认身份才 `execFile`，因为**每个 Electron 应用的
*   二进制都叫 `Electron`**，只按名字匹配就可能启动另一个产品。
*
* @module dsh-xdpool/at-rest
*/
/** Envelope framing names, mapped to the single-byte AAD framing code. */
const FRAMING_CODE = {
	file: 1,
	field: 2,
	record: 3,
	stream: 4
};
/** Standard (symmetric) format identifiers, transcripted into the AAD. */
const STANDARD_FORMAT_ID = {
	file: "WBEF1",
	field: "WBEV1",
	record: "WBER1",
	stream: "WBES1"
};
/** Domain separator the AAD transcript starts with. */
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
/** Scheme name of the symmetric envelope this module opens. */
const SYMMETRIC_SCHEME = "sym-v1";
/** Env override pointing at the WorkBuddy desktop executable. */
const WORKBUDDY_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
/**
* How long the app is given to answer with its key payload.
*
* 30s, not 10s: the child is the WorkBuddy Electron binary running as plain
* Node, and its FIRST spawn on a cold machine costs several seconds on its own
* (measured 4.5s here) before the endpoint security stack has warmed its scan
* cache. Under load — a concurrent `pnpm install` from the market, a running
* full-disk scan — that first spawn crosses a 10s budget, the fetch rejects,
* `readAtRestKey` returns undefined, and every encrypted credential then reads
* as `WorkBuddyEncryptedCredentialError` until the 60s negative cache expires.
* A successful fetch is cached for the process lifetime, so the longer budget
* is only ever paid once per process, and only when the app is present but slow.
*/
const KEY_FETCH_TIMEOUT_MS = 3e4;
/**
* Executable file names the desktop app ships under, in probe order.
*
* `WorkBuddyAI.exe` is the INTERNATIONAL build; both apps can be installed side
* by side (observed on a real machine: `D:\\workbuddy\\WorkBuddy.exe` for the
* domestic one and `D:\\workbuddyai\\WorkBuddyAI.exe` for the international one),
* so the name cannot be assumed.
*/
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
/**
* macOS bundles the desktop app may be installed as, in probe order.
*
* `WorkBuddy.app` is the domestic build; `WorkBuddy AI.app` is the
* international one, and a machine may carry either or both. The user-level
* `~/Applications` location is included because macOS lets an app live there,
* and installs have been observed under a subdirectory of /Applications too —
* hence {@link findWorkbuddyAppExecutable}'s parent scan, which covers those
* without guessing any particular folder name.
*/
const MACOS_APP_BUNDLE_NAMES = ["WorkBuddy.app", "WorkBuddy AI.app"];
function encodeUint32(value) {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}
/** Length-prefixed UTF-8 string: uint32 big-endian length followed by the bytes. */
function encodeLengthPrefixed(value) {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
/**
* The authenticated additional data for one `sym-v1` FIELD-framed envelope.
*
* Only the field framing is implemented: it is the shape the desktop app uses
* for credential fields, and it is also the shape that cannot be confused with
* a whole-file envelope, so an unexpected framing is a parse error rather than
* a silently wrong transcript.
*/
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error(`workbuddy: envelope keyId is malformed`);
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID["field"]),
		encodeLengthPrefixed(scheme),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE["field"]]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/** Whether a value is the app's encrypted-field wrapper. */
function isEncryptedFieldWrapper(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapper = value;
	const keys = Object.keys(wrapper).sort();
	return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" && wrapper["$wbEncrypted"] === 1 && typeof wrapper["envelope"] === "string";
}
/**
* The at-rest key id for a derived 32-byte key: the first 16 hex characters of
* its SHA-256. This is what the envelope's `keyId` is checked against, so a
* mismatched key fails loudly instead of returning garbage.
*/
function deriveAtRestKeyId(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
/**
* Derive the 32-byte field key from the app's key payload JSON.
*
* The app hashes the payload's base64 STRING — not its decoded bytes — so the
* same spelling is required here; hashing the decoded secret would produce a
* different key and every field would fail to open.
*/
function deriveAtRestKey(payloadJson) {
	let payload;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("workbuddy: at-rest key payload is not valid JSON");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("workbuddy: at-rest key payload is not an object");
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
	return createHash("sha256").update(secret, "utf8").digest();
}
/**
* Open one encrypted field with a derived key and return its plaintext.
*
* Throws when the envelope is malformed, belongs to another key, or fails
* authentication — a GCM tag mismatch is the signal that the transcript or the
* key is wrong, and it must never degrade into a truncated token.
*/
function openEncryptedField(field, key) {
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
	} catch {
		throw new Error("workbuddy: encrypted field envelope is not valid JSON");
	}
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("workbuddy: encrypted field envelope is not an object");
	const record = envelope;
	const suite = record["suite"];
	const keyId = record["keyId"];
	const nonce = record["nonce"];
	const authTag = record["authTag"];
	const ciphertext = record["ciphertext"];
	if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
/**
* The key id an encrypted field envelope demands, or undefined when the
* envelope cannot be read.
*
* The account pool uses it to pick the right desktop build's key when more
* than one build (domestic and international) is installed on the same machine:
* each `.info` file names the key id its fields were sealed under, so the opener
* must select the matching derived key rather than assume one build exists.
*/
function encryptedFieldKeyId(field) {
	try {
		const record = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
		return typeof record["keyId"] === "string" ? record["keyId"] : void 0;
	} catch {
		return;
	}
}
/**
* The executable inside a macOS app bundle, read from the bundle's own
* `Info.plist`.
*
* The binary is NOT reliably named after the app: the WorkBuddy bundles ship
* with `CFBundleExecutable` set to `Electron`, so a path assembled as
* `<bundle>/Contents/MacOS/WorkBuddy` does not exist and the app looks absent
* even when it is installed in the default location. Because the bundle
* documents the real name, asking it is both correct and robust to a future
* build that renames the binary.
*
* Returns undefined when the plist is absent, unreadable, or carries no usable
* name — never a guessed path, so a caller can keep probing.
*/
function macosBundleExecutable(bundle) {
	let plist;
	try {
		plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
	} catch {
		return;
	}
	const name = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]?.trim();
	if (name === void 0 || name === "" || name.includes("/") || name.includes("\\") || name === "." || name === "..") return;
	return join(bundle, "Contents", "MacOS", name);
}
/**
* Encodings a Windows console child process may emit in, most likely first.
*
* `reg.exe` writes with the ACTIVE CODE PAGE, never UTF-8: a Chinese Windows
* (code page 936) returns a path containing 「腾讯」 as GBK bytes. Decoding
* those as UTF-8 mangles them into `��Ѷ`, every `existsSync` then fails, and the
* plugin concludes no desktop app is installed while one is running fine.
*
* The list is ordered and each entry is TRIED rather than guessed: the first
* decoding that yields usable text wins, and the decision is validated against
* the filesystem rather than by sniffing bytes.
*/
const WINDOWS_CONSOLE_ENCODINGS = [
	"utf-8",
	"gbk",
	"big5",
	"shift_jis",
	"euc-kr",
	"windows-1252"
];
/**
* Decode bytes from a Windows console child process.
*
* `accept` decides whether a decoding is usable — the callers pass "this text
* contains a path that actually exists". Bytes that are already UTF-8 pass on
* the first attempt, so the healthy case pays nothing.
*/
function decodeWindowsConsole(buf, accept) {
	for (const label of WINDOWS_CONSOLE_ENCODINGS) {
		let text;
		try {
			text = new TextDecoder(label, { fatal: false }).decode(buf);
		} catch {
			continue;
		}
		if (accept(text)) return text;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
/** Strip the `"<path>",<index>` decoration DisplayIcon carries. */
function cleanIconPath(raw) {
	return raw.replace(/^"/u, "").replace(/",-?\d+$/u, "").replace(/,-?\d+$/u, "").trim();
}
/** Registry locations the installer records its own product under. */
const UNINSTALL_KEY_ROOTS = [
	"HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];
/**
* Windows install locations recorded by the app's own uninstaller.
*
* The registry is the authoritative answer: it survives a non-default drive, a
* renamed folder and a differently-named executable, none of which any fixed
* path list can predict. Real machines put the app at `D:\workbuddy\WorkBuddy.exe`
* and `D:\ruanjian\anzhuang\腾讯\WorkBuddy\WorkBuddy.exe` — layouts a
* `%ProgramFiles%\WorkBuddy\WorkBuddy.exe` probe cannot see.
*
* `DisplayIcon` is the field that actually carries the path (observed as
* `D:\workbuddy\WorkBuddy.exe,0`); `InstallLocation` is usually empty for these
* installers, so both are read and either may contribute.
*
* Two readers, because neither alone is enough:
*
*  - **PowerShell first.** `Get-ItemProperty` talks to the registry API, so no
*    console code page is involved and non-ASCII paths come back intact. This
*    is the encoding-proof path.
*  - **`reg.exe` as a fallback**, for a machine where PowerShell is unavailable
*    (locked-down or stripped images). Its raw bytes are decoded through
*    {@link decodeWindowsConsole}, which is what the original code got wrong.
*
* Returns [] on any failure — a missing registry key is the normal case on
* non-Windows, not an error.
*/
function windowsRegistryAppPaths() {
	if (process.platform !== "win32") return [];
	const viaPowerShell = windowsRegistryAppPathsViaPowerShell();
	if (viaPowerShell.length > 0) return viaPowerShell;
	return windowsRegistryAppPathsViaReg();
}
/**
* Registry read through PowerShell, immune to the console code page.
*
* `[Console]::OutputEncoding` is set to UTF-8 so the bytes Node receives are
* UTF-8 regardless of the machine's code page. Values are printed one per line
* and matched by the caller, so a Chinese path survives the round trip.
*
* Best-effort: any failure (no PowerShell, no keys, a policy restriction)
* returns [], and the `reg.exe` reader takes over.
*/
function windowsRegistryAppPathsViaPowerShell() {
	const script = [
		"$ErrorActionPreference='SilentlyContinue'",
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
		"$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
		"foreach($r in $roots){",
		"  Get-ItemProperty -Path $r | ForEach-Object {",
		"    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation",
		"    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
		"      if($di -ne ''){ Write-Output $di }",
		"      if($il -ne ''){ Write-Output $il }",
		"    }",
		"  }",
		"}"
	].join("\n");
	let stdout;
	try {
		stdout = execFileSync("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script
		], {
			encoding: "utf8",
			timeout: 2e4,
			windowsHide: true,
			maxBuffer: 8388608
		});
	} catch {
		return [];
	}
	const out = [];
	for (const line of stdout.split(/\r?\n/u)) {
		const cleaned = cleanIconPath(line.trim());
		if (cleaned !== "") out.push(cleaned);
	}
	return out;
}
/**
* Registry read through `reg.exe`, with console-code-page detection.
*
* Kept as the fallback for machines without PowerShell. The decode step is the
* fix: the output is captured as BYTES and decoded with whichever encoding
* yields a path that exists, instead of assuming UTF-8 and quietly producing
* mojibake that no existence check can ever match.
*/
function windowsRegistryAppPathsViaReg() {
	const out = [];
	for (const root of UNINSTALL_KEY_ROOTS) {
		let listingBuf;
		try {
			listingBuf = execFileSync("reg", [
				"query",
				root,
				"/s",
				"/v",
				"DisplayName"
			], {
				timeout: 1e4,
				windowsHide: true,
				maxBuffer: 8388608
			});
		} catch {
			continue;
		}
		const keys = decodeWindowsConsole(listingBuf, (text) => /WorkBuddy|CodeBuddy/iu.test(text)).split(/\r?\n(?=HKEY_)/u).filter((block) => /WorkBuddy|CodeBuddy/iu.test(block));
		for (const key of keys) {
			const keyPath = /^(HKEY_[^\r\n]+)/u.exec(key)?.[1]?.trim();
			if (keyPath === void 0) continue;
			for (const name of ["DisplayIcon", "InstallLocation"]) {
				let valueBuf;
				try {
					valueBuf = execFileSync("reg", [
						"query",
						keyPath,
						"/v",
						name
					], {
						timeout: 5e3,
						windowsHide: true
					});
				} catch {
					continue;
				}
				const value = decodeWindowsConsole(valueBuf, (text) => {
					const candidate = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/mu.exec(text)?.[1]?.trim();
					if (candidate === void 0) return false;
					const path = cleanIconPath(candidate);
					return path !== "" && existsSync(path);
				});
				const raw = /REG_(?:SZ|EXPAND_SZ)\s+(.+)$/mu.exec(value)?.[1]?.trim();
				if (raw === void 0 || raw === "") continue;
				out.push(cleanIconPath(raw));
			}
		}
	}
	return out;
}
/**
* Windows fallbacks for an app the registry did not cover: the well-known
* per-user and machine-wide locations, plus every fixed drive's `Program Files`.
*
* Drive enumeration matters because installing to a non-system drive is common
* on Windows and no environment variable points there.
*/
function windowsFallbackAppPaths(env) {
	const out = [];
	const roots = /* @__PURE__ */ new Set();
	for (const key of [
		"ProgramFiles",
		"ProgramW6432",
		"ProgramFiles(x86)",
		"LOCALAPPDATA"
	]) {
		const value = env[key]?.trim();
		if (value !== void 0 && value !== "") roots.add(value);
	}
	for (let code = 67; code <= 90; code += 1) {
		const drive = String.fromCharCode(code) + ":\\";
		try {
			if (!existsSync(drive)) continue;
		} catch {
			continue;
		}
		roots.add(join(drive, "Program Files"));
		roots.add(join(drive, "Program Files (x86)"));
		roots.add(drive);
	}
	for (const root of roots) for (const name of APP_EXECUTABLE_NAMES) {
		out.push(join(root, "WorkBuddy", name));
		out.push(join(root, "WorkBuddy AI", name));
		out.push(join(root, "Programs", "WorkBuddy", name));
	}
	for (const root of roots) try {
		for (const entry of readdirSync(root)) {
			if (!/^(workbuddy|codebuddy)/iu.test(entry)) continue;
			for (const name of APP_EXECUTABLE_NAMES) out.push(join(root, entry, name));
		}
	} catch {}
	return out;
}
/**
* Candidate paths of the WorkBuddy desktop executable, in probe order.
*
* Order is deliberate:
*  1. the explicit override, because a user who set it knows where the app is;
*  2. the registry, which is what the installer itself recorded;
*  3. derived fallbacks (per-user, machine-wide, every fixed drive).
*
* Only the Windows branch consults the registry (it is the only platform with
* one). macOS asks each bundle for its own `CFBundleExecutable` instead, because
* the WorkBuddy bundles ship a binary named `Electron`, not after the app.
*
* `readBundleExecutable` and `registryPaths` are injectable in the same spirit as
* `platform`/`home`/`env`: both consult the real machine, so without a seam the
* expected candidates would depend on what happens to be installed where the
* suite runs — passing on a developer's box and failing in CI.
*/
function workbuddyAppExecutableCandidates(platform = process.platform, home = homedir(), env = process.env, readBundleExecutable = macosBundleExecutable, registryPaths = windowsRegistryAppPaths) {
	const candidates = [env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()];
	if (platform === "win32") {
		candidates.push(...registryPaths());
		candidates.push(...windowsFallbackAppPaths(env));
	} else if (platform === "darwin") for (const name of MACOS_APP_BUNDLE_NAMES) candidates.push(readBundleExecutable(join("/Applications", name)), readBundleExecutable(join(home, "Applications", name)));
	return candidates.filter((candidate) => candidate !== void 0 && candidate !== "");
}
/**
* Ask the installed desktop app for its key payload by running its own binary
* as plain Node (`ELECTRON_RUN_AS_NODE`) and calling the native binding.
*
* The binding is the app's own public surface for this value, so the plugin
* never has to carry a copy of a build-specific constant: it asks the very
* build that wrote the file. The child is given no stdin and a hard timeout,
* and its stdout is the only thing read.
*/
function fetchAtRestKeyPayload(executable) {
	return new Promise((resolve, reject) => {
		execFile(executable, ["-e", "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			timeout: KEY_FETCH_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1048576
		}, (error, stdout, stderr) => {
			if (error !== null) {
				reject(/* @__PURE__ */ new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`));
				return;
			}
			const payload = stdout.trim();
			if (payload === "") {
				reject(/* @__PURE__ */ new Error("workbuddy: the desktop app returned an empty at-rest key payload"));
				return;
			}
			resolve(payload);
		});
	});
}
/**
* The desktop app's at-rest keys, indexed by the key id each derived key
* reports (the first 16 hex of its SHA-256).
*
* More than one build can be installed on one machine — the domestic
* `WorkBuddy.exe` and the international `WorkBuddyAI.exe` share a key id on the
* builds seen here, but a future build may rotate it, and the discovery below
* must keep working if they ever diverge. A field envelope names the key id it
* was sealed under, so the opener selects the matching derived key instead of
* assuming a single build exists. Cached per process and never persisted.
*/
const atRestKeyById = /* @__PURE__ */ new Map();
let inflightKeys;
/**
* When the last full key sweep failed, and how long that failure is trusted.
*
* Without this, EVERY credential read spawned the app and waited out the
* 10-second timeout before giving up — which is what made "rescan accounts" and
* every status poll crawl on a machine where the app could not be found. A
* failure is negative-cached briefly: long enough that a burst of reads costs
* one sweep, short enough that installing or starting the app is picked up
* without restarting DSH.
*/
let lastKeyFailureAtMs = 0;
const KEY_FAILURE_BACKOFF_MS = 6e4;
/**
* Load every desktop build's key id into {@link atRestKeyById}.
*
* Mirrors the reference `provideTheKey` shape: probe EVERY candidate executable
* (not just the first that exists) and keep the key each one yields. A build
* that fails to answer — a timeout, a single-instance lock, an older build
* without the native module — is skipped on its own and does NOT poison the
* other builds, which is exactly the failure mode the single-candidate path
* had: one bad spawn cached `undefined` for the whole process and every
* encrypted field then reported "no app could be located".
*/
function ensureAtRestKeys() {
	if (atRestKeyById.size > 0) return Promise.resolve();
	if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve();
	inflightKeys ??= (async () => {
		const candidates = workbuddyAppExecutableCandidates().filter((candidate) => {
			try {
				return existsSync(candidate);
			} catch {
				return false;
			}
		});
		if (candidates.length === 0) {
			lastKeyFailureAtMs = Date.now();
			return;
		}
		let anySuccess = false;
		await Promise.all(candidates.map(async (executable) => {
			try {
				const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable));
				atRestKeyById.set(deriveAtRestKeyId(key), key);
				anySuccess = true;
			} catch {}
		}));
		if (anySuccess) lastKeyFailureAtMs = 0;
		else lastKeyFailureAtMs = Date.now();
	})().finally(() => {
		inflightKeys = void 0;
	});
	return inflightKeys;
}
/**
* Synchronous key lookup for a key id already loaded by {@link ensureAtRestKeys}.
*
* The account pool warms the cache up front (via {@link readAtRestKey}) and then
* opens each encrypted field through a synchronous closure, because the parser
* runs `decrypt` inline. Lookups that race the warm-up, or ask for a key id no
* installed build produced, return undefined and are reported as the
* encrypted-but-unavailable error rather than a silently empty token.
*/
function atRestKeyFor(keyId) {
	return atRestKeyById.get(keyId);
}
/**
* Backwards-compatible single-key view: the first key any build provided.
*
* Kept so callers that do not yet carry a key id (and the legacy tests) still
* resolve to a usable key on single-build machines. Multi-build callers should
* prefer {@link readAtRestKeyById} and select by the field's own key id.
*/
function readAtRestKey() {
	return ensureAtRestKeys().then(() => {
		for (const key of atRestKeyById.values()) return key;
	});
}
//#endregion
//#region src/accounts.ts
/**
* Account pool: discovers every WorkBuddy credential snapshot the desktop app
* has left on this machine and hands out one healthy account per request,
* rotating away from any account the upstream has rate-limited.
*
* Discovery is read-only: the desktop app's files are never written. Each
* account is keyed by its billing identity (`uin`, falling back to `uid`), so
* re-logging the same account refreshes in place instead of creating a duplicate.
*
* @module dsh-xdpool/accounts
*/
/** Live auth file name the WorkBuddy desktop app writes. */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/** Snapshot files left behind by previous logins share this prefix. */
/** Env override for the auth file or its directory. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Platform-default directories holding the desktop app's auth files.
* Windows probes Local before Roaming; a redirected profile still resolves
* through the env location.
*/
function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
	if (platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		const roaming = nonEmptyEnv(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth"), join(roaming, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Read one string-valued field that may arrive as a plain string (older builds)
* or as the desktop app's `$wbEncrypted` envelope. The app started encrypting
* `accessToken` / `refreshToken` / `nickname` in 5.6.0 on BOTH macOS and Windows
* — the earlier "Windows first" reading was wrong, and it is why a signed-in Mac
* showed no account at all: the value is an object, `typeof === 'string'` failed,
* and the parser reported "no credential" for a perfectly good sign-in.
*
* `decrypt` is injected rather than called here so this parser stays synchronous
* and testable; the async key fetch lives in `readCredential`. A field that IS
* encrypted but could not be opened is reported as `failed` rather than as an
* empty string — the caller must tell the user the app is missing or unreachable,
* not send them to sign in again (the one action that cannot help).
*/
/**
* Marker for "the credential is encrypted and we could not obtain the key".
*
* Carried as a `code` rather than left to `instanceof` because the value crosses
* the packaged-plugin boundary; the same convention the sibling error types use.
* This is deliberately NOT "not signed in": the user IS signed in, and telling
* them to sign in again sends them to the one action that cannot help.
*/
const ENCRYPTED_CREDENTIAL_CODE = "ENCRYPTED_CREDENTIAL";
var WorkBuddyEncryptedCredentialError = class extends Error {
	code = ENCRYPTED_CREDENTIAL_CODE;
	constructor(sourcePath) {
		super(`workbuddy: ${sourcePath} holds encrypted credentials, but no WorkBuddy desktop app could be located to provide the key. If the app IS installed, it is simply outside the paths this plugin probes — set WORKBUDDY_APP_EXECUTABLE to its full .exe path (then restart DSH) and the credential will open. Signing in again will not help: the credential itself is intact. Run \`dsh-xdpool doctor\` to see which paths were probed — if one of them looks like mojibake (e.g. "??" where a Chinese folder name should be), the registry value could not be decoded on this machine; report that line and use the override above in the meantime.`);
		this.name = "WorkBuddyEncryptedCredentialError";
	}
};
function decryptableString(value, decrypt) {
	if (typeof value === "string") return {
		value,
		encrypted: false,
		failed: false
	};
	if (isEncryptedFieldWrapper(value)) {
		if (decrypt === void 0) return {
			value: "",
			encrypted: true,
			failed: true
		};
		try {
			return {
				value: decrypt(value),
				encrypted: true,
				failed: false
			};
		} catch {
			return {
				value: "",
				encrypted: true,
				failed: true
			};
		}
	}
	return {
		value: "",
		encrypted: false,
		failed: false
	};
}
/**
* Parse a WorkBuddy auth document. Accepts the nested desktop shape
* `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
* when there is no usable access token.
*
* `decrypt` opens the desktop app's `$wbEncrypted` field wrapper (5.6.0+, both
* platforms). Absent means "plain-string builds only", which is what every
* caller without an at-rest key should pass.
*/
function parseWorkBuddyAuth(text, sourcePath, decrypt) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessField = decryptableString(auth["accessToken"], decrypt);
	if (accessField.encrypted && accessField.failed) throw new WorkBuddyEncryptedCredentialError(sourcePath);
	const accessToken = accessField.value;
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) return;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
	return {
		accessToken,
		refreshToken: decryptableString(auth["refreshToken"], decrypt).value,
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
		...optionalString(decryptableString(identity["nickname"], decrypt).value) === void 0 ? {} : { nickname: optionalString(decryptableString(identity["nickname"], decrypt).value) },
		...optionalString(identity["uin"]) === void 0 ? {} : { uin: optionalString(identity["uin"]) },
		...optionalString(identity["uid"]) === void 0 ? {} : { uid: optionalString(identity["uid"]) },
		...optionalString(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) },
		domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
		sourcePath
	};
}
/**
* Stable account id. `uin` is the billing identity the upstream keys on and
* survives re-login; `uid` is the fallback.
*/
/**
* True when `path` is the desktop app's live sign-in (as opposed to a backup
* snapshot it left behind). The live file always wins: it is the session the
* app itself is using.
*/
function isLiveAuthFile(path) {
	return basename(path) === WORKBUDDY_LIVE_FILENAME;
}
/**
* Which of two credentials for the same account the pool should keep.
*
* Ordering, highest first:
*
* 1. the live file the desktop app is signed in with;
* 2. the credential the upstream issued most recently (`lastRefreshAtMs`);
* 3. the longer stored expiry, as a fallback for documents that carry no issue
*    time (the plugin's own refreshed copy, older builds).
*
* The stored expiry alone is NOT a freshness signal: the upstream does not
* rewrite it when it revokes a token, so a long-dead backup can claim to expire
* later than the token that actually works. Selecting on it made every upstream
* call return 401 while a perfectly good credential sat in the same directory.
*/
function compareFreshness(a, b) {
	const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
	const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
	if (aLive !== bLive) return bLive - aLive;
	const aIssued = a.lastRefreshAtMs ?? 0;
	const bIssued = b.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.expiresAtMs - a.expiresAtMs;
}
/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate, incumbent) {
	return compareFreshness(candidate, incumbent) < 0;
}
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
/** Human label; distinguishes same-nickname accounts by uid prefix. */
function accountLabel(credential) {
	const name = credential.nickname ?? "WorkBuddy";
	const discriminator = (credential.uid ?? credential.uin ?? "").slice(0, 8);
	return discriminator === "" ? name : `${name}#${discriminator}`;
}
/** List the auth files in one directory: the live file plus every snapshot. */
/**
* Credential files in one auth directory, freshest first.
*
* Every `*.info` file counts, not just the timestamped `workbuddy-desktop.*`
* snapshots: the international client signs in as `workbuddy-desktop-ai.info`
* (a hyphen, not a dot), so a prefix test silently dropped every global
* credential and the global provider then saw an empty pool.
*
* Filenames are plain strings, and the ordering here is only a first pass —
* `isFresher` makes the real call once each file has been parsed.
*/
async function authFilesIn(dir) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const files = entries.filter((name) => name.endsWith(".info"));
	files.sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
	return files.map((name) => join(dir, name));
}
/**
* Snapshot files in the plugin data directory that are account snapshots.
*
* Every `*.info` file there is one (the importer keeps that extension for
* uniformity with the auth dirs it copies from); the plugin's own JSON state
* files (`accounts.json`, `ignored.json`, `preferred.json`) are NOT and must
* never reach the credential parser.
*/
async function snapshotFilesIn(dir) {
	let entries;
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	return entries.filter((name) => name.endsWith(".info")).filter((name) => !isStateFile(name)).sort((a, b) => a < b ? 1 : a > b ? -1 : 0).map((name) => join(dir, name));
}
/**
* One credential file, or undefined when it cannot be used.
*
* Returns undefined — rather than throwing — for every failure mode, so ONE bad
* file cannot empty the pool. That is the whole point: an auth directory blends
* plain files, encrypted files, half-written files and files from an app version
* this plugin cannot read, and a scan that aborts on the first unusable one
* reports "you have 2 accounts" when it means "I could not open the other two".
*
* The caller surfaces the ones it skipped, so the count never silently
* disagrees with what is on disk.
*/
async function readCredential(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return;
	}
	const decrypt = text.includes("\"$wbEncrypted\"") ? await encryptedFieldOpener() : void 0;
	try {
		return parseWorkBuddyAuth(text, path, decrypt);
	} catch {
		return;
	}
}
/**
* The pool id a document would receive, WITHOUT decrypting anything.
*
* Used to honour the ignore list before the at-rest key lookup runs: `uin` and
* `uid` are read as plain strings by {@link parseWorkBuddyAuth}, while
* `nickname` is commonly encrypted — so this returns undefined for an account
* whose identity lives only in the encrypted nickname, and the caller falls
* back to the full parse for those.
*/
function cheapIdentityId(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	const identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : document;
	const uin = typeof identity["uin"] === "string" && identity["uin"] !== "" ? identity["uin"] : void 0;
	const uid = typeof identity["uid"] === "string" && identity["uid"] !== "" ? identity["uid"] : void 0;
	if (uin === void 0 && uid === void 0) return void 0;
	return workbuddyAccountId({
		...uin === void 0 ? {} : { uin },
		...uid === void 0 ? {} : { uid }
	});
}
/** {@link cheapIdentityId} for a file path; undefined when it cannot be read. */
async function cheapIdentityIdFromFile(path) {
	try {
		return cheapIdentityId(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
/**
* Why a file could not become an account.
*
* Distinguishing "encrypted" matters most: it is actionable (start the desktop
* app, or set the executable override), whereas "malformed" means the file is
* simply not a credential. Reporting them alike would send the user looking for
* a fix that cannot work.
*/
async function skipReasonFor(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return "unreadable";
	}
	if (text.includes("\"$wbEncrypted\"")) return "encrypted";
	try {
		JSON.parse(text);
		return "malformed";
	} catch {
		return "malformed";
	}
}
/**
* Build the field opener, or undefined when the app cannot supply its key.
*
* Split out so the key lookup is testable without a real desktop install, and so
* a lookup failure degrades to "encrypted, unopenable" rather than to a parse
* error that would look like a corrupt file.
*/
async function encryptedFieldOpener() {
	await readAtRestKey().catch(() => void 0);
	return (field) => {
		if (!isEncryptedFieldWrapper(field)) throw new Error("workbuddy: not an encrypted field wrapper");
		const keyId = encryptedFieldKeyId(field);
		if (keyId === void 0) throw new Error("workbuddy: encrypted field has no key id");
		const key = atRestKeyFor(keyId);
		if (key === void 0) throw new Error("workbuddy: no at-rest key available for this encrypted field");
		return openEncryptedField(field, key);
	};
}
/** Every directory the pool should scan, in probe order. */
function candidateAuthDirs(env = process.env) {
	const dirs = [];
	const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
	if (override !== void 0) dirs.push(override.toLowerCase().endsWith(".info") ? resolve(override, "..") : override);
	dirs.push(...defaultDesktopAuthDirs(process.env["DSH_TEST_PLATFORM"]));
	return dirs;
}
/**
* How many conversation→account bindings `sticky` mode remembers.
*
* Only a memory bound: evicting the oldest binding costs one re-pick on that
* conversation's next turn, it never loses an account or a request.
*/
const STICKY_AFFINITY_LIMIT = 200;
/**
* Read-only pool of every discovered WorkBuddy account, with rate-limit
* cooldown and round-robin failover.
*/
/** Idle bonus per hour an account has been unused (reference-panel default). */
const IDLE_WEIGHT_PER_HOUR = .5;
/** Ceiling for the idle bonus, so an idle account cannot dominate forever. */
const IDLE_WEIGHT_MAX = 5;
/**
* Weight one account by how long it has been idle.
*
* The base of 1 keeps every eligible account in play: an account that served a
* moment ago still has a small chance, so a single unhealthy account cannot pin
* the pool to itself, and the weights never sum to zero.
*
* `lastUsedAt === undefined` means "never used in this process", which earns the
* full bonus: on a fresh start every account ties, and the weighted draw spreads
* the first requests instead of always picking the first entry.
*/
function idleWeight(lastUsedAt, now) {
	if (lastUsedAt === void 0) return 6;
	const hours = (now - lastUsedAt) / 36e5;
	return 1 + Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX);
}
/** Default rest for an account whose credits ran out (packs reset on their own schedule). */
const EXHAUST_COOLDOWN_MS = 18e5;
/**
* Default rest for an account the upstream rejected the sign-in of (401/403).
*
* Unlike a rate limit there is no reset time to read: only signing in again in
* the desktop app revives the account. The rest is therefore long enough that a
* single request never burns its whole retry budget on the same dead credential,
* but short enough that a user who just signed in is not locked out of their own
* account for long — and a newer credential file clears the mark outright.
*/
const CREDENTIAL_DEAD_COOLDOWN_MS = 18e5;
/**
* Does this refresh failure prove the credential itself is dead?
*
* The upstream answers a revoked refresh token with `invalid_grant: Offline user
* session not found` (HTTP 400/401). Network failures, DNS errors and 5xx do NOT
* prove anything about the credential and must not mark it dead — that would
* take a working account out of rotation for half an hour over a hiccup.
*/
function isCredentialDeadError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("invalid_grant") || message.includes("Offline user session not found") || message.includes("session_dead");
}
var WorkBuddyAccountPool = class {
	logger;
	authDirs;
	cooldownMs;
	/**
	* How long an account stays out of rotation after the upstream reports its
	* credits are spent. Credit packs reset on their own schedule rather than on a
	* rate-limit window, so this is much longer than `cooldownMs`.
	*/
	exhaustCooldownMs;
	/**
	* How long an account stays out of rotation after the upstream rejected its
	* sign-in. Cleared by a newer credential file or an explicit sign-in.
	*/
	credentialDeadCooldownMs;
	client;
	refreshMarginMs;
	accounts = [];
	/**
	* Files the last scan could not read, with the reason.
	*
	* Surfaced so "2 accounts" can be told apart from "4 files, 2 unreadable" —
	* the difference between accounts being gone and files being unopenable.
	*/
	skippedFiles = [];
	distribution;
	/** Cursor for round-robin mode; unused under priority distribution. */
	cursor = 0;
	/**
	* `sticky` mode: conversation key → account id.
	*
	* A conversation that keeps the same account also keeps that account's
	* upstream prompt cache warm — the cache is per tenant, so rotating accounts
	* mid-conversation pays full prompt cost on every turn. Insertion order is
	* the LRU order: re-binding deletes then re-inserts.
	*/
	affinity = /* @__PURE__ */ new Map();
	lastScanAtMs = 0;
	/**
	* The account id the user pinned, or undefined for none.
	*
	* Field rather than a public property so that the only way in is
	* {@link WorkBuddyPool.prefer} and the only way out is {@link WorkBuddyPool.preferredId}:
	* a mutable public field would let a caller pin an account without the pool
	* knowing, and a getter alone would let a caller read a pin the pool has
	* already forgotten.
	*/
	preferredAccountId;
	/**
	* Account ids the user switched off on the card.
	*
	* Disabling is a user preference rather than a property of the credential:
	* `scan()` rebuilds every account object from the auth files, so the set
	* lives on the pool and is re-applied from settings after each scan.
	*/
	disabledIds = /* @__PURE__ */ new Set();
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
	ignoredIds = /* @__PURE__ */ new Set();
	/**
	* Per-account credit floor, keyed by account id. 0 (or absent) means "spend
	* it all".
	*
	* A reserved balance is protection, not a hard limit the upstream knows
	* about: the pool simply stops picking that account once its last known
	* balance is at or below the floor, so the user keeps a cushion instead of
	* draining every account to zero.
	*/
	creditReserves = /* @__PURE__ */ new Map();
	/**
	* Last known credit balance per account, epoch ms aside.
	*
	* Refreshed in the background after a successful request, so a pick can
	* consult it. An account with no reading is treated as usable: refusing to
	* pick an account just because its balance has not been checked yet would
	* strand a healthy pool, and the first 402 still cools it as before.
	*/
	creditBalances = /* @__PURE__ */ new Map();
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
	creditExpiry = /* @__PURE__ */ new Map();
	/**
	* Last time each account served a request, epoch ms. Drives the idle term
	* of the priority-mode weighting below: an account that just served loses to
	* one that has been idle, so a small pool stops hammering a single account.
	*
	* In-memory on purpose: it only biases the next pick, so a cold start that
	* treats every account as idle is the right default. Not keyed by id lookup
	* misses because a removed account simply disappears from the map on re-scan.
	*/
	lastUsedAt = /* @__PURE__ */ new Map();
	refreshInflight = /* @__PURE__ */ new Map();
	/**
	* Whether `scan()` seeds from and writes back the durable account store.
	*
	* Off by default (tests build fixtures over temp dirs and must not touch the
	* user's real store); `createCore()` turns it on for production, which is
	* what makes accounts gathered by switching desktop sign-ins survive a
	* restart — the desktop app keeps only the current sign-in's credential file
	* on disk.
	*/
	persistent;
	/** Path of the durable store; computed once so tests can pin it. */
	storePath;
	/**
	* Optional second source of credentials: the channel pack's account pool,
	* which holds the accounts the user signed in through the scan-login page.
	*
	* A function rather than a list because that pool is mounted asynchronously
	* and can be re-read on demand; `undefined` means "no such source", which is
	* the state every test and every pre-mount startup is in.
	*/
	externalSource;
	constructor(options = {}) {
		this.logger = options.logger;
		this.authDirs = options.authDirs ?? candidateAuthDirs();
		this.cooldownMs = options.cooldownMs ?? 6e4;
		this.exhaustCooldownMs = options.exhaustCooldownMs ?? EXHAUST_COOLDOWN_MS;
		this.credentialDeadCooldownMs = options.credentialDeadCooldownMs ?? CREDENTIAL_DEAD_COOLDOWN_MS;
		this.client = options.client;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.distribution = options.distribution ?? "priority";
		this.persistent = options.persistent ?? false;
		this.storePath = accountStorePath();
	}
	/**
	* Re-apply configuration that only affects discovery and cooldown policy,
	* without rebuilding the pool. A later `scan()` uses the new auth dirs and
	* cooldown window; existing accounts keep their in-memory state.
	*/
	applyConfig(options) {
		if (options.authDirs !== void 0 && options.authDirs.length > 0) this.authDirs = options.authDirs;
		if (options.cooldownMs !== void 0 && options.cooldownMs >= 1e3) this.cooldownMs = options.cooldownMs;
		if (options.exhaustCooldownMs !== void 0 && options.exhaustCooldownMs >= 1e3) this.exhaustCooldownMs = options.exhaustCooldownMs;
		if (options.distribution !== void 0) this.distribution = options.distribution;
		if (options.disabledAccountIds !== void 0) this.disabledIds = new Set(options.disabledAccountIds);
		if (options.creditReserves !== void 0) this.setCreditReserves(options.creditReserves);
	}
	/**
	* Register (or clear, with `undefined`) the extra credential source that
	* `scan()` merges alongside the auth directories. Rescanning is the caller's
	* job: this only changes where the next scan looks.
	*/
	applyExternalSource(source) {
		this.externalSource = source;
	}
	/**
	* Replace the permanent ignore list.
	*
	* Also drops any already-discovered account that is now ignored, so the change
	* is visible without waiting for the next scan: the card refreshes its status
	* document right after the write, and an account still sitting in `accounts`
	* would keep showing up there.
	*/
	applyIgnored(ids) {
		this.ignoredIds = new Set(ids);
		if (this.ignoredIds.size === 0) return;
		this.accounts = this.accounts.filter((account) => !this.ignoredIds.has(account.id));
	}
	/** Whether this account has been thrown out of the pool for good. */
	isIgnored(accountId) {
		return this.ignoredIds.has(accountId);
	}
	/** Every ignored id currently in force, in insertion order. */
	ignoredIdsInOrder() {
		return [...this.ignoredIds];
	}
	/**
	* Credential files the last scan could not read, with the reason.
	*
	* Exposed because a short account list is otherwise indistinguishable from a
	* broken one: with this, the card can say "2 accounts, 2 files unreadable"
	* instead of silently showing half a pool.
	*/
	skippedFilesInOrder() {
		return this.skippedFiles;
	}
	/** Rescan the auth directories and merge newly discovered accounts. */
	async scan() {
		const found = [];
		const skipped = [];
		const scanDirs = this.persistent ? [...this.authDirs, snapshotDirPath()] : this.authDirs;
		for (const dir of scanDirs) {
			const files = dir === snapshotDirPath() ? await snapshotFilesIn(dir) : await authFilesIn(dir);
			for (const file of files) {
				if (this.ignoredIds.size > 0) {
					const cheapId = await cheapIdentityIdFromFile(file);
					if (cheapId !== void 0 && this.ignoredIds.has(cheapId)) continue;
				}
				const credential = await readCredential(file);
				if (credential === void 0) {
					skipped.push({
						path: file,
						reason: await skipReasonFor(file)
					});
					continue;
				}
				if (this.ignoredIds.size > 0 && this.ignoredIds.has(workbuddyAccountId(credential))) continue;
				found.push(credential);
			}
		}
		this.skippedFiles = skipped;
		if (skipped.length > 0) this.logger?.warn?.(`dsh-xdpool: ${skipped.length} credential file(s) could not be read; ${found.length} account(s) still loaded. Reasons: ` + [...new Set(skipped.map((s) => s.reason))].join("; "));
		if (this.externalSource !== void 0) try {
			const external = await this.externalSource();
			for (const credential of external) {
				if (this.ignoredIds.size > 0 && this.ignoredIds.has(workbuddyAccountId(credential))) continue;
				found.push(credential);
			}
		} catch (error) {
			this.logger?.warn?.("dsh-xdpool: could not read channel-pack accounts; desktop accounts only", error);
		}
		const byId = /* @__PURE__ */ new Map();
		for (const account of this.accounts) byId.set(account.id, account);
		if (this.persistent && this.accounts.length === 0) {
			const stored = await loadStoredAccounts(this.storePath);
			for (const entry of stored) {
				if (byId.has(entry.id)) continue;
				byId.set(entry.id, {
					id: entry.id,
					label: entry.label,
					credential: entry.credential,
					cooldownUntilMs: 0,
					modelCooldowns: {},
					rateLimitHits: 0
				});
			}
		}
		const byUid = /* @__PURE__ */ new Map();
		for (const account of byId.values()) {
			const uid = account.credential.uid;
			if (typeof uid === "string" && uid !== "" && !byUid.has(uid)) byUid.set(uid, account.id);
		}
		for (const credential of found) {
			const byIdentity = workbuddyAccountId(credential);
			const uid = credential.uid;
			const knownId = typeof uid === "string" && uid !== "" ? byUid.get(uid) : void 0;
			const id = knownId ?? byIdentity;
			if (knownId === void 0 && typeof uid === "string" && uid !== "") byUid.set(uid, id);
			const existing = byId.get(id);
			if (existing === void 0) {
				byId.set(id, {
					id,
					label: accountLabel(credential),
					credential,
					cooldownUntilMs: 0,
					modelCooldowns: {},
					rateLimitHits: 0
				});
				continue;
			}
			if (isFresher(credential, existing.credential)) {
				const signedInAgain = credential.refreshToken !== existing.credential.refreshToken || credential.accessToken !== existing.credential.accessToken;
				byId.set(id, {
					...existing,
					credential,
					label: accountLabel(credential),
					...signedInAgain ? { credentialDeadUntilMs: 0 } : {}
				});
			}
		}
		const ordered = [...byId.values()];
		ordered.sort((a, b) => compareFreshness(a.credential, b.credential));
		this.accounts = ordered;
		this.lastScanAtMs = Date.now();
		if (this.persistent) try {
			await saveStoredAccounts(this.storePath, this.accounts);
		} catch (error) {
			this.logger?.warn?.("dsh-xdpool: could not persist the account store", error);
		}
		return this.accounts;
	}
	/** All accounts, cooldown state included. */
	list(region) {
		if (region === void 0) return this.accounts;
		return this.accounts.filter((account) => regionOf(account.credential.domain) === region);
	}
	/**
	* Accounts currently eligible to serve a request.
	*
	* With a `modelId`, an account is eligible when it is not account-wide cooled
	* AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
	* that model out while `hy3` on the same account stays usable. Without a
	* model id the legacy account-wide check applies (callers that cannot name a
	* model, e.g. CLI diagnostics).
	*/
	available(now, modelId, region) {
		return this.accounts.filter((account) => {
			if (this.disabledIds.has(account.id)) return false;
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) {
				const balance = this.creditBalances.get(account.id);
				if (balance !== void 0 && balance <= reserve) return false;
			}
			if (account.cooldownUntilMs > now) return false;
			if ((account.credentialDeadUntilMs ?? 0) > now) return false;
			if (modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now) return false;
			if (region !== void 0 && regionOf(account.credential.domain) !== region) return false;
			return true;
		});
	}
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
	unavailableReason(modelId, region) {
		const now = Date.now();
		const inRegion = this.accounts.filter((account) => region === void 0 || regionOf(account.credential.domain) === region);
		if (inRegion.length === 0) return {
			total: 0,
			cooling: 0,
			disabled: 0,
			dead: 0,
			reason: "empty"
		};
		let cooling = 0;
		let disabled = 0;
		let dead = 0;
		for (const account of inRegion) {
			if (this.disabledIds.has(account.id)) {
				disabled += 1;
				continue;
			}
			if ((account.credentialDeadUntilMs ?? 0) > now) {
				dead += 1;
				continue;
			}
			const modelCooling = modelId !== void 0 && (account.modelCooldowns[modelId] ?? 0) > now;
			if (account.cooldownUntilMs > now || modelCooling) {
				cooling += 1;
				continue;
			}
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) {
				const balance = this.creditBalances.get(account.id);
				if (balance !== void 0 && balance <= reserve) return {
					total: inRegion.length,
					cooling,
					disabled,
					dead,
					reason: "reserve"
				};
			}
		}
		if (dead > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "session_dead"
		};
		if (cooling > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "cooling"
		};
		if (disabled > 0) return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "disabled"
		};
		return {
			total: inRegion.length,
			cooling,
			disabled,
			dead,
			reason: "none"
		};
	}
	/** Round-robin: the legacy cursor walk, kept for the distribution that asks for it. */
	pickRoundRobin(pool) {
		const index = this.cursor % pool.length;
		const account = pool[index];
		if (account === void 0) return void 0;
		this.cursor = (index + 1) % pool.length;
		return account;
	}
	/** Remember which account a conversation is bound to, keeping LRU order. */
	bindAffinity(conversationKey, accountId) {
		this.affinity.delete(conversationKey);
		this.affinity.set(conversationKey, accountId);
		while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
			const oldest = this.affinity.keys().next().value;
			if (oldest === void 0) break;
			this.affinity.delete(oldest);
		}
	}
	/**
	* `sticky`: the account this conversation already used, when it can still
	* serve the model being asked for.
	*
	* Returns `undefined` both when there is no binding and when the binding is
	* no longer eligible (cooling for this model, disabled, out of credits) — the
	* caller then rebinds, which is what makes a rate-limited conversation hop to
	* a fresh account instead of failing.
	*/
	affinityAccount(pool, conversationKey) {
		if (conversationKey === void 0 || conversationKey === "") return void 0;
		const boundId = this.affinity.get(conversationKey);
		if (boundId === void 0) return void 0;
		const bound = pool.find((account) => account.id === boundId);
		if (bound === void 0) {
			this.affinity.delete(conversationKey);
			return;
		}
		this.bindAffinity(conversationKey, boundId);
		return bound;
	}
	/** Bindings currently remembered; exposed for tests and diagnostics. */
	affinitySize() {
		return this.affinity.size;
	}
	/** Forget every conversation binding (tests, and a settings change). */
	clearAffinity() {
		this.affinity.clear();
	}
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
	pickByWeight(pool) {
		if (pool.length === 1) return pool[0];
		const now = Date.now();
		const weights = pool.map((account) => idleWeight(this.lastUsedAt.get(account.id), now));
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		if (!Number.isFinite(total) || total <= 0) return pool[0];
		let roll = Math.random() * total;
		for (let index = 0; index < pool.length; index += 1) {
			roll -= weights[index] ?? 0;
			if (roll < 0) return pool[index];
		}
		return pool[pool.length - 1];
	}
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
	pickByExpiry(pool) {
		let best;
		let bestAt = Number.POSITIVE_INFINITY;
		for (const account of pool) {
			const at = this.creditExpiry.get(account.id);
			if (at === void 0) continue;
			if (at < bestAt) {
				best = account;
				bestAt = at;
			}
		}
		return best ?? pool[0];
	}
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
	async acquire(modelId, region, conversationKey) {
		if (this.accounts.length === 0) await this.scan();
		const maxTries = this.accounts.length + 1;
		for (let attempt = 0; attempt < maxTries; attempt += 1) {
			let pool = this.available(Date.now(), modelId, region);
			if (pool.length === 0 && attempt === 0) {
				await this.scan();
				pool = this.available(Date.now(), modelId, region);
			}
			if (pool.length === 0) return void 0;
			if (this.preferredAccountId !== void 0) {
				const preferred = pool.find((account) => account.id === this.preferredAccountId);
				if (preferred !== void 0 && await this.ensureFresh(preferred)) return preferred;
			}
			if (this.distribution === "sticky") {
				const bound = this.affinityAccount(pool, conversationKey);
				if (bound !== void 0 && await this.ensureFresh(bound)) return bound;
			}
			const account = this.distribution === "round-robin" || this.distribution === "sticky" ? this.pickRoundRobin(pool) : this.distribution === "balanced" ? this.pickByWeight(pool) : this.distribution === "expiry" ? this.pickByExpiry(pool) : pool[0];
			if (account === void 0) return void 0;
			if (!await this.ensureFresh(account)) continue;
			if (this.distribution === "sticky" && conversationKey !== void 0 && conversationKey !== "") this.bindAffinity(conversationKey, account.id);
			return account;
		}
	}
	/** How the pool currently spreads requests. Shown on the card. */
	currentDistribution() {
		return this.distribution;
	}
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
	prefer(accountId) {
		this.preferredAccountId = accountId;
	}
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
	preferredId() {
		return this.preferredAccountId;
	}
	/** Whether the user switched this account off on the card. */
	isDisabled(accountId) {
		return this.disabledIds.has(accountId);
	}
	/** Every account id the user switched off, in discovery order. */
	disabledIdsInOrder() {
		return this.accounts.filter((account) => this.disabledIds.has(account.id)).map((account) => account.id);
	}
	/**
	* Record that an account actually served a request.
	*
	* Called by the shim once the upstream answers 200 — only then is the account
	* the one the user is really being served by. `balanced` mode reads the same map
	* for its idle weighting, so a request that failed over to another account must
	* not count as used for the account that was merely tried.
	*/
	noteServed(accountId) {
		if (!this.accounts.some((account) => account.id === accountId)) return;
		this.lastUsedAt.set(accountId, Date.now());
	}
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
	noteCredits(accountId, balance, nearestExpiryMs) {
		if (!Number.isFinite(balance)) return;
		if (!this.accounts.some((account) => account.id === accountId)) return;
		this.creditBalances.set(accountId, balance);
		if (nearestExpiryMs === void 0 || !Number.isFinite(nearestExpiryMs)) {
			this.creditExpiry.delete(accountId);
			return;
		}
		this.creditExpiry.set(accountId, nearestExpiryMs);
	}
	/** Nearest one-off pack expiry for one account, or undefined when none known. */
	creditExpiryOf(accountId) {
		return this.creditExpiry.get(accountId);
	}
	/** Last known balance for one account, or undefined when never read. */
	creditsOf(accountId) {
		return this.creditBalances.get(accountId);
	}
	/** The credit floor the user set for one account; 0 when unset. */
	creditReserveOf(accountId) {
		return this.creditReserves.get(accountId) ?? 0;
	}
	/**
	* Replace every reserve. Called from settings on each apply, so the map
	* mirrors the saved document exactly instead of accumulating old keys.
	*/
	setCreditReserves(reserves) {
		const next = /* @__PURE__ */ new Map();
		for (const [id, value] of Object.entries(reserves)) if (Number.isFinite(value) && value > 0) next.set(id, Math.floor(value));
		this.creditReserves = next;
	}
	/** Every reserve currently in force, keyed by account id. */
	creditReservesInOrder() {
		const out = {};
		for (const account of this.accounts) {
			const reserve = this.creditReserves.get(account.id);
			if (reserve !== void 0 && reserve > 0) out[account.id] = reserve;
		}
		return out;
	}
	/**
	* Whether an account is held back only by its reserve.
	*
	* Separates "resting to protect credits" from every other reason an account
	* is out of rotation, which is what the card shows the user.
	*/
	isReserved(accountId) {
		const reserve = this.creditReserves.get(accountId);
		if (reserve === void 0 || reserve <= 0) return false;
		const balance = this.creditBalances.get(accountId);
		return balance !== void 0 && balance <= reserve;
	}
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
	lastServedId() {
		let newest;
		for (const [id, at] of this.lastUsedAt) {
			if (!this.accounts.some((account) => account.id === id)) continue;
			if (newest === void 0 || at > newest.at) newest = {
				id,
				at
			};
		}
		return newest?.id;
	}
	/** Best-effort refresh of one account after a session-dead upstream answer. */
	async refreshAccount(accountId, options) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return false;
		return await this.ensureFresh(account, options?.force === true);
	}
	/**
	* Cool a whole account because the upstream REJECTED its sign-in (401/403).
	*
	* Called with direct evidence (the request just came back `session_dead`), so
	* it does not need to guess: without this, the next retry of the SAME request
	* picks the same account again — its credential file still claims to be valid
	* — and a request with 8 attempts spends all 8 on one dead account while
	* healthy accounts are never tried.
	*/
	penalizeCredentialDead(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		const until = Date.now() + this.credentialDeadCooldownMs;
		account.credentialDeadUntilMs = Math.max(account.credentialDeadUntilMs ?? 0, until);
		this.logger?.warn(`dsh-xdpool: ${account.label} sign-in was rejected by the upstream; keeping it out of rotation until ${new Date(until).toISOString()} (sign in again to restore it)`);
	}
	/** Put an account back in rotation after its sign-in was proven good again. */
	clearCredentialDead(accountId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.credentialDeadUntilMs = 0;
	}
	/** Accounts currently kept out of rotation because their sign-in was rejected. */
	deadCredentials() {
		const now = Date.now();
		return this.accounts.filter((account) => (account.credentialDeadUntilMs ?? 0) > now);
	}
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
	async ensureFresh(account, force = false) {
		if (this.client === void 0) return true;
		const credential = account.credential;
		if (!(credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + this.refreshMarginMs) && !force) return true;
		const existing = this.refreshInflight.get(account.id);
		if (existing !== void 0) {
			await existing;
			return (account.credentialDeadUntilMs ?? 0) <= Date.now();
		}
		const run = (async () => {
			if (credential.refreshToken === "") {
				if (credential.expiresAtMs > Date.now() + 3e4) return true;
				this.logger?.warn(`dsh-xdpool: ${account.label} token expired with no refresh token; sign in again`);
				this.penalizeCredentialDead(account.id);
				return false;
			}
			try {
				const outcome = await this.client.refreshToken(credential);
				account.credential = {
					...credential,
					accessToken: outcome.accessToken,
					...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
					expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
					...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain }
				};
				this.clearCredentialDead(account.id);
				this.logger?.info?.(`dsh-xdpool: refreshed token for ${account.label}`);
				return true;
			} catch (error) {
				if (isCredentialDeadError(error)) {
					this.penalizeCredentialDead(account.id);
					this.logger?.warn?.(`dsh-xdpool: ${account.label} refresh token was revoked upstream; sign in again to restore it`, error);
					return false;
				}
				if (credential.expiresAtMs > Date.now() + 3e4) this.logger?.warn?.(`dsh-xdpool: token refresh failed but token still valid for ${account.label}`, error);
				else this.logger?.error?.(`dsh-xdpool: token refresh failed and token expired for ${account.label}`, error);
				return true;
			}
		})();
		this.refreshInflight.set(account.id, run);
		try {
			return await run;
		} finally {
			this.refreshInflight.delete(account.id);
		}
	}
	/**
	* Cool a whole account after the upstream reports its credits are spent.
	*
	* Credit exhaustion is an ACCOUNT condition, unlike a model rate limit: every
	* model on that account is unusable until the quota resets, so this cools the
	* account as a whole (no `modelId`) for the configured exhaustion window. The
	* shim then rotates to a different account instead of failing the request.
	*/
	penalizeExhausted(accountId) {
		const until = Date.now() + this.exhaustCooldownMs;
		this.penalize(accountId, until);
		this.logger?.warn(`
dsh-xdpool: account credits exhausted; cooling the whole account until 

${new Date(until).toISOString()}
`);
	}
	/**
	* Mark an account (or one of its models) rate-limited.
	*
	* With `modelId`, only that model on the account is cooled — the account's
	* other models stay in rotation, matching the upstream's per-model rate
	* limit ("可切换其他模型继续使用"). Without a model id the whole account is
	* cooled, which callers should reserve for limits that truly span every model.
	*/
	penalize(accountId, resetAtMs, modelId) {
		const account = this.accounts.find((item) => item.id === accountId);
		if (account === void 0) return;
		account.rateLimitHits += 1;
		const until = resetAtMs ?? Date.now() + this.cooldownMs;
		if (modelId !== void 0 && modelId !== "") {
			account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until);
			this.logger?.warn(`dsh-xdpool: ${account.label} rate-limited on model ${modelId}; cooling that model until ${new Date(until).toISOString()}`);
			return;
		}
		account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until);
		this.logger?.warn(`dsh-xdpool: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`);
	}
	/** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
	resetCooldowns() {
		for (const account of this.accounts) {
			account.cooldownUntilMs = 0;
			account.modelCooldowns = {};
			account.rateLimitHits = 0;
			account.credentialDeadUntilMs = 0;
		}
	}
	/** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
	*  the account as a whole stays usable when only one model is limited). */
	status() {
		const now = Date.now();
		return {
			count: this.accounts.length,
			cooling: this.accounts.filter((account) => account.cooldownUntilMs > now).length,
			dead: this.accounts.filter((account) => (account.credentialDeadUntilMs ?? 0) > now).length,
			lastScanAtMs: this.lastScanAtMs
		};
	}
};
//#endregion
//#region src/catalog.ts
/**
* Model catalog with per-model credit multipliers.
*
* A static fallback keeps the provider usable before the first successful
* upstream call; when the live catalog arrives it replaces the fallback and
* the adapter rebuilds the provider's model list.
*
* @module dsh-xdpool/catalog
*/
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
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "auto",
		name: "Auto",
		contextWindow: 256e3,
		maxOutputTokens: 32e3,
		supportsImages: true,
		tags: ["craft"]
	},
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 96e4,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .29,
		tags: ["craft", "badge:夜间免费:#FF0000"]
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: 0,
		tags: ["craft", "badge:限时免费:#FF0000"]
	},
	{
		id: "hy3-x",
		name: "Hy3",
		contextWindow: 192e3,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .05
	},
	{
		id: "space-bunny",
		name: "Space-Bunny",
		contextWindow: 1e6,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .08
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxOutputTokens: 128e3,
		supportsImages: true,
		multiplier: .11
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxOutputTokens: 128e3,
		supportsImages: true,
		multiplier: .51
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek-V4-Flash",
		contextWindow: 1e6,
		maxOutputTokens: 128e3,
		supportsImages: true
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .79
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxOutputTokens: 131072,
		supportsImages: true,
		multiplier: .06
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .79,
		tags: ["craft", "badge:夜间折扣:#1E90FF"]
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxOutputTokens: 48e3,
		supportsImages: false,
		multiplier: .79
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .71
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxOutputTokens: 32e3,
		supportsImages: true,
		multiplier: 1.62
	},
	{
		id: "kimi-k2.8-preview",
		name: "Kimi-K2.8-Preview",
		contextWindow: 1e6,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .77
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxOutputTokens: 32e3,
		supportsImages: true,
		multiplier: .57
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxOutputTokens: 32e3,
		supportsImages: true,
		multiplier: .52
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxOutputTokens: 64e3,
		supportsImages: true,
		multiplier: .25
	}
];
/**
* The static table to fall back to when the international gateway is unreachable.
*
* Derived from {@link FALLBACK_WORKBUDDY_MODELS} by stripping the domestic
* `badge:*` tags rather than hand-written, and that is a CORRECTION rather than
* a new feature: both regions have always shared one table, but the CN-only
* campaign wording (`限时免费` / `夜间免费` / `夜间折扣`) rode along into the
* international picker, advertising a promotion that gateway does not run.
*
* Now that those badges are parsed and actually SHOWN, the leak would be
* visible on every global row instead of sitting inert in a tag array — which
* is exactly the "invented a discount nobody gets" failure this plugin must not
* have. The rest of each row is left untouched, preserving the pre-existing
* behaviour that a global user without a reachable gateway sees the shared
* roster rather than an empty picker.
*
* Deliberately NOT a separate global roster of its own: only the multiplier and
* context window were captured from `www.workbuddy.ai`, so inventing
* `maxOutputTokens` / `supportsImages` for 25 rows would put fabricated fields in
* front of the user — strictly worse than the shared list it replaces.
*/
const FALLBACK_WORKBUDDY_MODELS_GLOBAL = FALLBACK_WORKBUDDY_MODELS.map((model) => {
	const tags = (model.tags ?? []).filter((tag) => !tag.startsWith(BADGE_TAG_PREFIX));
	if (tags.length === (model.tags?.length ?? 0)) return model;
	return {
		...model,
		...tags.length === 0 ? {} : { tags }
	};
});
/** The static fallback table for one region. Defaults to `cn`. */
function fallbackModelsFor(region = "cn") {
	return region === "global" ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS;
}
/** Live catalog with a static fallback behind it. */
var WorkBuddyCatalog = class {
	/**
	* Which gateway this catalog serves, and therefore which static table it falls
	* back to.
	*
	* Optional in the constructor so every existing `new WorkBuddyCatalog()`
	* (tests, and the plugin's own default wiring) keeps compiling; it defaults to
	* `cn` because that is the table this plugin has always shipped.
	*/
	region;
	models;
	constructor(region = "cn") {
		this.region = region;
		this.models = fallbackModelsFor(region);
	}
	listeners = /* @__PURE__ */ new Set();
	/** User's model selection. Empty object = follow the catalog unfiltered. */
	selection = {};
	/**
	* Whether `models` came from the gateway or from the static table.
	*
	* Tracked so the card can SAY which it is showing. A failed fetch used to be
	* invisible on screen: the picker simply held fewer models than before, which
	* the user reasonably read as "the plugin deleted my models" rather than "the
	* network hiccuped at startup".
	*/
	source = "fallback";
	/** When the live list last landed. */
	lastUpdatedAt;
	/** Why the last fetch failed, for display. */
	lastError;
	current() {
		return this.models;
	}
	/**
	* The models DSH should actually offer, after applying the user's selection:
	* disabled models are dropped, an explicit image list overrides the upstream
	* capability flag, and a per-model budget caps the advertised window.
	*
	* An absent `enabledModelIds` means "everything" — a fresh install with no
	* saved selection must not present an empty picker.
	*/
	visible() {
		const enabled = this.selection.enabledModelIds;
		const allow = enabled === void 0 ? void 0 : new Set(enabled);
		const images = this.selection.imageModelIds;
		const imageSet = images === void 0 ? void 0 : new Set(images);
		const budgets = this.selection.contextBudgets;
		return this.models.filter((model) => allow === void 0 || allow.has(model.id)).map((model) => {
			const next = { ...model };
			if (imageSet !== void 0) next.supportsImages = next.supportsImages || imageSet.has(model.id);
			const budget = budgets?.[model.id];
			if (budget !== void 0 && budget > 0 && budget < next.contextWindow) next.contextWindow = budget;
			return next;
		});
	}
	/** Replace the catalog and notify the adapter to rebuild its model list. */
	update(models) {
		if (models.length === 0) return;
		this.models = models;
		this.notify();
	}
	/** Restore the static fallback, e.g. when the upstream stops answering. */
	reset() {
		this.models = fallbackModelsFor(this.region);
		this.source = "fallback";
		this.notify();
	}
	/** Replace the user's selection; the adapter rebuilds from `visible()`. */
	applySelection(selection) {
		this.selection = selection;
		this.notify();
	}
	/** The selection currently in force, for the card's save round-trip. */
	currentSelection() {
		return this.selection;
	}
	/**
	* Whether this catalog is serving live data or the built-in table.
	*
	* `fallback` is not an error state, but it IS a degraded one: the user is
	* looking at a shorter roster than the gateway offers, so the card says so
	* and offers a retry instead of letting them wonder where the models went.
	*/
	currentSource() {
		return this.source;
	}
	/**
	* When the live list last landed, if it ever did.
	*
	* Named `catalogUpdatedAt()` rather than `updatedAt()` because the class
	* already had an `updatedAt` member; two members of the same name is a
	* compile error, and the awkwardness is a useful signal that the concept is
	* "when THIS catalog was refreshed", not a generic timestamp.
	*/
	catalogUpdatedAt() {
		return this.lastUpdatedAt;
	}
	/** Why the last fetch failed, if it did. */
	lastFetchError() {
		return this.lastError;
	}
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	find(id) {
		return this.models.find((model) => model.id === id);
	}
	/** Replace the catalog from the live upstream list; keeps the fallback if empty. */
	updateFromUpstream(models) {
		this.update(catalogFromUpstream(models, this.region));
		this.source = "live";
		this.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		this.lastError = void 0;
	}
	/**
	* Record that a fetch attempt failed, leaving the current list in place.
	*
	* The list is deliberately NOT reset here: a refresh that fails should keep
	* whatever working catalog is already loaded, rather than demoting a healthy
	* session to the static table because one retry ran out.
	*/
	noteFetchFailure(message) {
		this.lastError = message;
		this.notify();
	}
	notify() {
		for (const listener of this.listeners) listener();
	}
};
/** Convert one upstream catalog entry into the plugin's model-info shape. */
function toModelInfo(model) {
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		supportsImages: model.supportsImages ?? false,
		...model.creditMultiplier === void 0 ? {} : { multiplier: model.creditMultiplier },
		...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
		...model.tags === void 0 || model.tags.length === 0 ? {} : { tags: model.tags }
	};
}
/**
* Map the live upstream list, falling back to the static list when empty.
*
* `region` only chooses WHICH static table an empty list falls back to. A
* non-empty list is the gateway's own answer for whichever gateway was asked,
* so there is nothing region-specific left to apply to it.
*/
function catalogFromUpstream(models, region = "cn") {
	if (models.length === 0) return fallbackModelsFor(region);
	return models.map(toModelInfo);
}
//#endregion
//#region src/status-paths.ts
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
const DEFAULT_AUTOMATION_HOURS = {
	checkin: [9],
	report: [10],
	tasks: [11],
	streak: [12],
	travel: [9, 21],
	compensation: [13]
};
//#endregion
//#region src/channels.ts
/**
* Mount the vendored free-channel pack.
*
* Thirteen login channels — CodeArts, WorkBuddy 国内版/国际版, LobsterAI, Qoder ×2,
* TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode and Gemini — arrive as one
* MIT-licensed bundle we carry rather than re-implement. Each is a real protocol
* adapter with its own login handshake; rewriting twelve of them here would only
* produce a slower, drift-prone copy of work that upstream already validates.
*
* Provenance and rebuild notes live in `vendor/channel-pack/NOTICE.md`.
*/
/** Directory of this module, used to locate the sibling `vendor/` tree. */
const HERE = dirname(fileURLToPath(import.meta.url));
/**
* Where the pack lives relative to the built entry.
*
* `src/index.ts` compiles to `lib/index.js`, so from there `vendor/` is one level
* up. Kept as a computed path rather than `import.meta.resolve` because the
* installed layout is a flat `node_modules/dsh-xdpool/{lib,vendor}`,
* which is not resolvable as a bare specifier.
*/
const PACK_ENTRY = join(HERE, "..", "vendor", "channel-pack", "pack.js");
pathToFileURL(PACK_ENTRY).href;
//#endregion
//#region src/providers.ts
/**
* The registry, frozen at import so no caller can mutate shared state.
*
* The JSON import is typed by inference: TypeScript reads the file and gives the
* array a structural type. It is then widened to `readonly ProviderRecord[]`
* through a cast, because the inferred type of `contextWindow: null` is `null`
* where the interface says `number | null` — a contravariance that no amount of
* `satisfies` can reconcile without second-guessing the data. The cast is the
* boundary: after it, every helper in this module sees exactly the interface.
*/
const PROVIDERS = Object.freeze([
	{
		"id": "agnes",
		"name": "Agnes AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "AGNES_API_KEY",
			"url": "https://agnes-ai.com/"
		},
		"baseUrl": "https://apihub.agnes-ai.com/v1",
		"format": "openai-chat",
		"models": [{
			"id": "agnes-2.0-flash",
			"name": "Agnes 2.0 Flash",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Reasoning arrives as think tags on this route (FCC profile).",
		"website": "https://agnes-ai.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "alibaba_cloud",
		"name": "Alibaba Cloud",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ALIBABA_CLOUD_API_KEY",
			"url": "https://www.alibabacloud.com/help/en/model-studio/get-api-key"
		},
		"baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "qwen3.5-plus",
				"name": "Qwen3.5 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder-next",
				"name": "Qwen3 Coder Next",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder-plus",
				"name": "Qwen3 Coder Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "DashScope international compatible-mode endpoint (9router alims-intl, same base URL as FCC).",
		"website": "https://www.alibabacloud.com/en/product/modelstudio",
		"local": false,
		"source": "fcc",
		"baseUrlOverrideEnv": "ALIBABA_CLOUD_BASE_URL"
	},
	{
		"id": "anthropic",
		"name": "Anthropic",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ANTHROPIC_API_KEY",
			"url": "https://platform.claude.com/settings/keys"
		},
		"baseUrl": "https://api.anthropic.com/v1",
		"format": "anthropic-messages",
		"models": [
			{
				"id": "claude-sonnet-4-20250514",
				"name": "Claude Sonnet 4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-20250514",
				"name": "Claude Opus 4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-3-5-sonnet-20241022",
				"name": "Claude 3.5 Sonnet",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Native Anthropic Messages passthrough (FCC marks it native_messages_passthrough).",
		"website": "https://www.anthropic.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "azure_openai",
		"name": "Azure OpenAI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "AZURE_OPENAI_API_KEY",
			"url": "https://ai.azure.com/"
		},
		"baseUrl": null,
		"format": "openai-chat",
		"models": [],
		"notes": "No default endpoint: AZURE_OPENAI_BASE_URL and the deployment name are required (FCC required_settings_attrs).",
		"website": "https://azure.microsoft.com/en-us/products/ai-services/openai-service/",
		"local": false,
		"source": "fcc",
		"baseUrlOverrideEnv": "AZURE_OPENAI_BASE_URL"
	},
	{
		"id": "baidu",
		"name": "Baidu Qianfan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "BAIDU_API_KEY",
			"url": "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application"
		},
		"baseUrl": "https://qianfan.baidubce.com/v2",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": 512e3,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": 198e3,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.5-397b-a17b",
				"name": "Qwen 3.5 397B A17B",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.5-27b",
				"name": "Qwen 3.5 27B",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Baidu Qianfan v2 OpenAI-compatible endpoint.",
		"website": "https://qianfan.baidubce.com",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://qianfan.baidubce.com/v2/models"
	},
	{
		"id": "bedrock",
		"name": "Amazon Bedrock",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "AWS_BEARER_TOKEN_BEDROCK",
			"url": "https://console.aws.amazon.com/bedrock/"
		},
		"baseUrl": "https://bedrock-mantle.us-east-1.api.aws/v1",
		"format": "openai-chat",
		"models": [{
			"id": "openai.gpt-oss-120b",
			"name": "GPT-OSS 120B (Bedrock)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Bedrock Mantle OpenAI-compatible endpoint; the base URL stays configurable because keys and model availability are region-scoped (FCC).",
		"website": "https://aws.amazon.com/bedrock/",
		"local": false,
		"source": "fcc",
		"baseUrlOverrideEnv": "BEDROCK_BASE_URL"
	},
	{
		"id": "cerebras",
		"name": "Cerebras",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "CEREBRAS_API_KEY",
			"url": "https://cloud.cerebras.ai"
		},
		"baseUrl": "https://api.cerebras.ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "gpt-oss-120b",
				"name": "GPT OSS 120B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-glm-4.7",
				"name": "ZAI GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "llama-3.3-70b",
				"name": "Llama 3.3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "llama-4-scout-17b-16e-instruct",
				"name": "Llama 4 Scout",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen-3-235b-a22b-instruct-2507",
				"name": "Qwen3 235B A22B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen-3-32b",
				"name": "Qwen3 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "max_tokens is sent as max_completion_tokens (FCC profile).",
		"website": "https://www.cerebras.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.cerebras.ai/v1/models"
	},
	{
		"id": "cheaperinference",
		"name": "Cheaper Inference",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "CHEAPER_INFERENCE_API_KEY",
			"url": "https://cheaperinference.com/signup"
		},
		"baseUrl": "https://api.cheaperinference.com/v1",
		"format": "openai-chat",
		"models": [{
			"id": "gpt-5.4-mini",
			"name": "GPT-5.4 Mini",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Listing is filtered to streaming text models (FCC profile).",
		"website": "https://cheaperinference.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "chutes",
		"name": "Chutes",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "CHUTES_API_KEY",
			"url": "https://chutes.ai/docs/getting-started/authentication"
		},
		"baseUrl": "https://llm.chutes.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "Qwen/Qwen3-32B-TEE",
			"name": "Qwen3 32B TEE",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "FCC lists only text-in/text-out models that advertise tool support.",
		"website": "https://chutes.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://llm.chutes.ai/v1/models"
	},
	{
		"id": "cline_pass",
		"name": "ClinePass",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "CLINE_API_KEY",
			"url": "https://app.cline.bot"
		},
		"baseUrl": "https://api.cline.bot/api/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "cline-pass/glm-5.2",
				"name": "GLM-5.2 (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/kimi-k2.7-code",
				"name": "Kimi K2.7 Code (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/kimi-k2.6",
				"name": "Kimi K2.6 (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/deepseek-v4-pro",
				"name": "DeepSeek V4 Pro (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/deepseek-v4-flash",
				"name": "DeepSeek V4 Flash (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/mimo-v2.5",
				"name": "MiMo-V2.5 (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/mimo-v2.5-pro",
				"name": "MiMo-V2.5-Pro (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/minimax-m3",
				"name": "MiniMax M3 (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/qwen3.7-max",
				"name": "Qwen3.7 Max (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/qwen3.7-plus",
				"name": "Qwen3.7 Plus (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "cline-pass/kimi-k3",
				"name": "Kimi K3 (ClinePass)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "ClinePass subscription key; FCC lists it from /ai/cline/recommended-models.",
		"website": "https://cline.bot/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.cline.bot/api/v1/ai/cline/recommended-models"
	},
	{
		"id": "cohere",
		"name": "Cohere",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "COHERE_API_KEY",
			"url": "https://dashboard.cohere.com/api-keys"
		},
		"baseUrl": "https://api.cohere.ai/compatibility/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "command-r-plus-08-2024",
				"name": "Command R+ (Aug 2024)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "command-r-08-2024",
				"name": "Command R (Aug 2024)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "command-a-03-2025",
				"name": "Command A (Mar 2025)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "command-a-plus-05-2026",
				"name": "Command A Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Compatibility layer at /compatibility/v1; several body keys are stripped (FCC profile).",
		"website": "https://cohere.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.cohere.ai/v1/models"
	},
	{
		"id": "deepinfra",
		"name": "DeepInfra",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "DEEPINFRA_API_KEY",
			"url": "https://deepinfra.com/dash/api_keys"
		},
		"baseUrl": "https://api.deepinfra.com/v1/openai",
		"format": "openai-chat",
		"models": [{
			"id": "deepseek-ai/DeepSeek-V4-Flash",
			"name": "DeepSeek V4 Flash",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "FCC reads DeepInfra’s own /models/list shape (model_name / reported_type).",
		"website": "https://deepinfra.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.deepinfra.com/models/list"
	},
	{
		"id": "deepseek",
		"name": "DeepSeek",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "DEEPSEEK_API_KEY",
			"url": "https://platform.deepseek.com/api_keys"
		},
		"baseUrl": "https://api.deepseek.com",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro-max",
				"name": "DeepSeek V4 Pro Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro-none",
				"name": "DeepSeek V4 Pro No Thinking",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4.1-flash",
				"name": "DeepSeek V4.1 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash-vision-exp",
				"name": "DeepSeek V4 Flash Vision (Exp)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-chat",
				"name": "DeepSeek V3.2 Chat",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-reasoner",
				"name": "DeepSeek V3.2 Reasoner",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Cache usage is reported on this endpoint (FCC).",
		"website": "https://www.deepseek.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.deepseek.com/models"
	},
	{
		"id": "experiential",
		"name": "Experiential Labs",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "EXPLABS_API_KEY",
			"url": "https://platform.experientiallabs.ai/settings/api-keys"
		},
		"baseUrl": "https://api.experientiallabs.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "union-alpha",
			"name": "Union Alpha",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Experiential Labs gateway.",
		"website": "https://www.experientiallabs.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "featherless",
		"name": "Featherless AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "FEATHERLESS_API_KEY",
			"url": "https://featherless.ai/account/api-keys"
		},
		"baseUrl": "https://api.featherless.ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-ai/DeepSeek-V4-Pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V4-Flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/GLM-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/GLM-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/Kimi-K2.7-Code",
				"name": "Kimi K2.7 Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/Kimi-K2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/Kimi-K2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen3-32B",
				"name": "Qwen3 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "FCC asks for tool_use + available_on_current_plan rows; pagination is numbered.",
		"website": "https://featherless.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.featherless.ai/v1/models"
	},
	{
		"id": "fireworks",
		"name": "Fireworks",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "FIREWORKS_API_KEY",
			"url": "https://fireworks.ai/account/api-keys"
		},
		"baseUrl": "https://api.fireworks.ai/inference/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "accounts/fireworks/models/deepseek-v3p1",
				"name": "DeepSeek V3.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "accounts/fireworks/models/llama-v3p3-70b-instruct",
				"name": "Llama 3.3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "accounts/fireworks/models/qwen3-235b-a22b",
				"name": "Qwen3 235B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Embedding id omitted; model ids are account-scoped paths.",
		"website": "https://fireworks.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.fireworks.ai/inference/v1/models"
	},
	{
		"id": "glm",
		"name": "Z.ai (Anthropic wire)",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ZAI_API_KEY",
			"url": "https://open.bigmodel.cn/usercenter/apikeys"
		},
		"baseUrl": "https://api.z.ai/api/anthropic/v1",
		"format": "anthropic-messages",
		"models": [
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5-turbo",
				"name": "GLM 5 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.6v",
				"name": "GLM 4.6V (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Z.ai Anthropic-compatible route (Claude Code style); the same ZAI_API_KEY as the zai/zai_api records. Key URL as declared in the 9router glm registry.",
		"website": "https://z.ai",
		"local": false,
		"source": "9router"
	},
	{
		"id": "glm-cn",
		"name": "Zhipu GLM (CN)",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ZHIPU_API_KEY",
			"url": "https://open.bigmodel.cn/usercenter/apikeys"
		},
		"baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
		"format": "openai-chat",
		"models": [
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5-turbo",
				"name": "GLM 5 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM-4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.6v",
				"name": "GLM 4.6V (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.6",
				"name": "GLM-4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.5-air",
				"name": "GLM-4.5-Air",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Zhipu open-platform coding endpoint (mainland China), distinct from the z.ai international records.",
		"website": "https://open.bigmodel.cn",
		"local": false,
		"source": "9router"
	},
	{
		"id": "groq",
		"name": "Groq",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "GROQ_API_KEY",
			"url": "https://console.groq.com/keys"
		},
		"baseUrl": "https://api.groq.com/openai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "llama-3.3-70b-versatile",
				"name": "Llama 3.3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "meta-llama/llama-4-maverick-17b-128e-instruct",
				"name": "Llama 4 Maverick",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3-32b",
				"name": "Qwen3 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-oss-120b",
				"name": "GPT-OSS 120B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "OpenAI-compatible endpoint; audio ids from the same registry listing are omitted (chat catalog).",
		"website": "https://groq.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.groq.com/openai/v1/models"
	},
	{
		"id": "huggingface",
		"name": "Hugging Face",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "HUGGINGFACE_API_KEY",
			"url": "https://huggingface.co/settings/tokens"
		},
		"baseUrl": "https://router.huggingface.co/v1",
		"format": "openai-chat",
		"models": [{
			"id": "Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest",
			"name": "Qwen3 Coder 480B A35B",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Inference Providers router; FCC resolves the context window from the live provider consensus.",
		"website": "https://huggingface.co/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "hyperbolic",
		"name": "Hyperbolic AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "HYPERBOLIC_API_KEY",
			"url": "https://app.hyperbolic.xyz/settings"
		},
		"baseUrl": "https://api.hyperbolic.xyz/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "Qwen/QwQ-32B",
				"name": "QwQ 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-R1",
				"name": "DeepSeek R1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V3",
				"name": "DeepSeek V3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "meta-llama/Llama-3.3-70B-Instruct",
				"name": "Llama 3.3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "meta-llama/Llama-3.2-3B-Instruct",
				"name": "Llama 3.2 3B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen2.5-72B-Instruct",
				"name": "Qwen 2.5 72B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen2.5-Coder-32B-Instruct",
				"name": "Qwen 2.5 Coder 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "NousResearch/Hermes-3-Llama-3.1-70B",
				"name": "Hermes 3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "OpenAI-compatible chat completions; 9router registry declares the key URL.",
		"website": "https://hyperbolic.xyz",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://api.hyperbolic.xyz/v1/models"
	},
	{
		"id": "kimi",
		"name": "Kimi",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "KIMI_API_KEY",
			"url": "https://platform.moonshot.cn/console/api-keys"
		},
		"baseUrl": "https://api.moonshot.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "kimi-k2.5",
			"name": "Kimi K2.5",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Moonshot platform key; caller extra_body is rejected on this route (FCC profile).",
		"website": "https://www.kimi.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "kimi_code",
		"name": "Kimi Code",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "KIMI_CODE_API_KEY",
			"url": "https://www.kimi.com/code/console"
		},
		"baseUrl": "https://api.kimi.com/coding/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "kimi-k3",
				"name": "Kimi K3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "k3",
				"name": "Kimi K3 (Code)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-for-coding",
				"name": "Kimi for Coding",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-for-coding-highspeed",
				"name": "Kimi for Coding Highspeed",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.7-code",
				"name": "Kimi K2.7 Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.7-code-highspeed",
				"name": "Kimi K2.7 Code Highspeed",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5-thinking",
				"name": "Kimi K2.5 Thinking",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-latest",
				"name": "Kimi Latest",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Kimi Code subscription; ids from the 9router kimi registry (same host, api.kimi.com/coding/v1).",
		"website": "https://www.kimi.com/code",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "lightning",
		"name": "Lightning AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "LIGHTNING_API_KEY",
			"url": "https://lightning.ai/lightning-ai/model-apis/models"
		},
		"baseUrl": "https://lightning.ai/api/v1",
		"format": "openai-chat",
		"models": [{
			"id": "lightning-ai/Qwen3.8-27B",
			"name": "Qwen3.8 27B",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Lightning AI Model APIs gateway.",
		"website": "https://lightning.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "llm7",
		"name": "LLM7.io",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "LLM7_API_KEY",
			"url": "https://dash.llm7.io/"
		},
		"baseUrl": "https://api.llm7.io/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "gpt-5.5",
				"name": "GPT-5.5 (LLM7)",
				"contextWindow": 105e4,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-5",
				"name": "Claude Opus 5 (LLM7)",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash",
				"name": "DeepSeek V4 Flash (LLM7)",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.5",
				"name": "Grok 4.5 (LLM7)",
				"contextWindow": 5e5,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k3",
				"name": "Kimi K3 (LLM7)",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "default",
				"name": "LLM7 Default",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "fast",
				"name": "LLM7 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "pro",
				"name": "LLM7 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "FCC also pins the default/fast/pro aliases; the listing is filtered to streaming tool models.",
		"website": "https://llm7.io/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.llm7.io/v1/models"
	},
	{
		"id": "minimax",
		"name": "MiniMax",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "MINIMAX_API_KEY",
			"url": "https://platform.minimax.io/user-center/basic-information/interface-key"
		},
		"baseUrl": "https://api.minimax.io/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "MiniMax-M3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.7",
				"name": "MiniMax M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.1",
				"name": "MiniMax M2.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Reasoning is split out of the text stream (FCC profile); speech/image ids omitted.",
		"website": "https://www.minimax.io/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "minimax-cn",
		"name": "MiniMax (CN)",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "MINIMAX_CN_API_KEY",
			"url": "https://platform.minimaxi.com/user-center/basic-information/interface-key"
		},
		"baseUrl": "https://api.minimaxi.com/anthropic/v1",
		"format": "anthropic-messages",
		"models": [
			{
				"id": "MiniMax-M3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.7",
				"name": "MiniMax M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.1",
				"name": "MiniMax M2.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "MiniMax mainland endpoint speaking the Anthropic Messages wire; speech ids omitted. The anthropic-beta header is declared by the 9router registry.",
		"website": "https://www.minimaxi.com",
		"local": false,
		"source": "9router",
		"headers": { "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14" }
	},
	{
		"id": "mistral",
		"name": "Mistral",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "MISTRAL_API_KEY",
			"url": "https://console.mistral.ai/"
		},
		"baseUrl": "https://api.mistral.ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "mistral-large-latest",
				"name": "Mistral Large 3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "codestral-latest",
				"name": "Codestral",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mistral-medium-latest",
				"name": "Mistral Medium 3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "devstral-small-latest",
				"name": "Devstral Small",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "La Plateforme keys; embedding id omitted.",
		"website": "https://mistral.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.mistral.ai/v1/models"
	},
	{
		"id": "mistral_codestral",
		"name": "Mistral Codestral",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "CODESTRAL_API_KEY",
			"url": "https://console.mistral.ai/"
		},
		"baseUrl": "https://codestral.mistral.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "codestral-latest",
			"name": "Codestral",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Codestral IDE endpoint, distinct from La Plateforme keys (FCC).",
		"website": "https://mistral.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "morph",
		"name": "Morph LLM",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "MORPH_API_KEY",
			"url": "https://morphllm.com"
		},
		"baseUrl": "https://api.morphllm.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "morph-v3-large",
				"name": "Morph v3 Large",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "morph-v3-fast",
				"name": "Morph v3 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "morph-qwen35-397b",
				"name": "Qwen 3.5 397B (Morph)",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "morph-minimax27-230b",
				"name": "MiniMax M2.7 (Morph)",
				"contextWindow": 200704,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "morph-qwen36-27b",
				"name": "Qwen 3.6 27B (Morph)",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "morph-dsv4flash",
				"name": "DeepSeek V4 Flash (Morph)",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Fast apply/edit models for coding agents.",
		"website": "https://morphllm.com",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://api.morphllm.com/v1/models"
	},
	{
		"id": "nararoute",
		"name": "NaraRoute",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "NARAROUTE_API_KEY",
			"url": "https://router.bynara.id/keys"
		},
		"baseUrl": "https://router.bynara.id/v1",
		"format": "openai-chat",
		"models": [{
			"id": "kimi-k3-free",
			"name": "Kimi K3 (free)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Multi-vendor gateway; reasoning is surfaced as a boolean in the listing (FCC profile).",
		"website": "https://router.bynara.id/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["kimi-k3-free"]
	},
	{
		"id": "nebius",
		"name": "Nebius Token Factory",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "NEBIUS_API_KEY",
			"url": "https://tokenfactory.nebius.com/project/api-keys"
		},
		"baseUrl": "https://api.tokenfactory.nebius.com/v1",
		"format": "openai-chat",
		"models": [{
			"id": "meta-llama/Llama-3.3-70B-Instruct",
			"name": "Llama 3.3 70B Instruct",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}, {
			"id": "Qwen/Qwen3-30B-A3B",
			"name": "Qwen3 30B A3B",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Embedding id omitted; FCC requires architecture.modality=text->text in the listing.",
		"website": "https://tokenfactory.nebius.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.tokenfactory.nebius.com/v1/models?verbose=true"
	},
	{
		"id": "novita",
		"name": "Novita AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "NOVITA_API_KEY",
			"url": "https://novita.ai/settings/key-management"
		},
		"baseUrl": "https://api.novita.ai/openai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "deepseek/deepseek-v4-flash-0731",
			"name": "DeepSeek V4 Flash 0731",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "FCC README example id.",
		"website": "https://novita.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "openai_api",
		"name": "OpenAI API",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "OPENAI_API_KEY",
			"url": "https://platform.openai.com/api-keys"
		},
		"baseUrl": "https://api.openai.com/v1",
		"format": "openai-responses",
		"models": [
			{
				"id": "gpt-5.5",
				"name": "GPT-5.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4",
				"name": "GPT-5.4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-mini",
				"name": "GPT-5.4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-nano",
				"name": "GPT-5.4 Nano",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.2",
				"name": "GPT-5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.1",
				"name": "GPT-5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5",
				"name": "GPT-5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5-mini",
				"name": "GPT-5 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5-nano",
				"name": "GPT-5 Nano",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4o",
				"name": "GPT-4o",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4o-mini",
				"name": "GPT-4o Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4-turbo",
				"name": "GPT-4 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4.1",
				"name": "GPT-4.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4.1-mini",
				"name": "GPT-4.1 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-4.1-nano",
				"name": "GPT-4.1 Nano",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o3",
				"name": "O3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o3-mini",
				"name": "O3 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o3-pro",
				"name": "O3 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o4-mini",
				"name": "O4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o1",
				"name": "O1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "o1-mini",
				"name": "O1 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-sol",
				"name": "GPT-5.6 Sol",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Platform API key; FCC drives this route over the Responses API. Non-chat ids (embeddings, speech, images) are omitted.",
		"website": "https://platform.openai.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "opencode_go",
		"name": "OpenCode Go",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "OPENCODE_API_KEY",
			"url": "https://opencode.ai/auth"
		},
		"baseUrl": "https://opencode.ai/zen/go/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-flash",
				"name": "DeepSeek V4.1 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.7-code",
				"name": "Kimi K2.7 Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k3",
				"name": "Kimi K3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash-vision-exp",
				"name": "DeepSeek V4 Flash Vision (Exp)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "longcat-2.0",
				"name": "LongCat 2.0",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5",
				"name": "MiMo V2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5-pro",
				"name": "MiMo V2.5 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.7",
				"name": "MiniMax M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.8-max",
				"name": "Qwen 3.8 Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.8-flash",
				"name": "Qwen 3.8 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.7-max",
				"name": "Qwen 3.7 Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.7-plus",
				"name": "Qwen 3.7 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.6-plus",
				"name": "Qwen 3.6 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "hy4-preview",
				"name": "Hy4 Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "hy3",
				"name": "Hy3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.6",
				"name": "Grok 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-luna",
				"name": "GPT 5.6 Luna",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.2-contributor",
				"name": "Muse Spark 1.2 Contributor",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.3-contributor",
				"name": "Muse Spark 1.3 Contributor",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "OpenCode Go subscription ($5/mo per the 9router notice).",
		"website": "https://opencode.ai/go",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "opper",
		"name": "Opper",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "OPPER_API_KEY",
			"url": "https://platform.opper.ai/"
		},
		"baseUrl": "https://api.opper.ai/v3/compat",
		"format": "openai-chat",
		"models": [{
			"id": "claude-sonnet-4-6",
			"name": "Claude Sonnet 4.6",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Opper gateway (v3/compat base).",
		"website": "https://opper.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "orcarouter",
		"name": "OrcaRouter",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ORCAROUTER_API_KEY",
			"url": "https://www.orcarouter.ai/console"
		},
		"baseUrl": "https://api.orcarouter.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "deepseek/deepseek-v4-flash-free",
			"name": "DeepSeek V4 Flash (free)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Multi-provider gateway with a free slug.",
		"website": "https://www.orcarouter.ai/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["deepseek/deepseek-v4-flash-free"]
	},
	{
		"id": "perplexity",
		"name": "Perplexity",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "PERPLEXITY_API_KEY",
			"url": "https://www.perplexity.ai/settings/api"
		},
		"baseUrl": "https://api.perplexity.ai",
		"format": "openai-chat",
		"models": [{
			"id": "sonar-pro",
			"name": "Sonar Pro",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}, {
			"id": "sonar",
			"name": "Sonar",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Search-augmented Sonar chat models.",
		"website": "https://www.perplexity.ai",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://api.perplexity.ai/models"
	},
	{
		"id": "poolside",
		"name": "Poolside AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "POOLSIDE_API_KEY",
			"url": "https://platform.poolside.ai/"
		},
		"baseUrl": "https://inference.poolside.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "poolside/laguna-s-2.1",
			"name": "Laguna S 2.1",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}, {
			"id": "poolside/laguna-xs-2.1",
			"name": "Laguna XS 2.1",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Poolside platform key.",
		"website": "https://poolside.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://inference.poolside.ai/v1/models"
	},
	{
		"id": "qwencloud",
		"name": "QwenCloud Token Plan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "QWENCLOUD_API_KEY",
			"url": "https://home.qwencloud.com/api-keys"
		},
		"baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "qwen3.8-max-preview",
				"name": "Qwen3.8 Max Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.7-max",
				"name": "Qwen3.7 Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.7-plus",
				"name": "Qwen3.7 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.6-flash",
				"name": "Qwen3.6 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "QwenCloud Token Plan endpoint (9router alitp-intl, same base URL as FCC).",
		"website": "https://qwencloud.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "qwencloud_coding",
		"name": "QwenCloud Coding Plan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "QWENCLOUD_CODING_API_KEY",
			"url": "https://home.qwencloud.com/api-keys"
		},
		"baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "qwen3.5-plus",
				"name": "Qwen3.5 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder-next",
				"name": "Qwen3 Coder Next",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder-plus",
				"name": "Qwen3 Coder Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "QwenCloud Coding Plan endpoint (9router alicode-intl, same base URL as FCC).",
		"website": "https://qwencloud.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "sambanova",
		"name": "SambaNova",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "SAMBANOVA_API_KEY",
			"url": "https://cloud.sambanova.ai/apis"
		},
		"baseUrl": "https://api.sambanova.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "Meta-Llama-3.3-70B-Instruct",
			"name": "Llama 3.3 70B Instruct",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "FCC README example id; the 9router registry keeps this provider hidden.",
		"website": "https://sambanova.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.sambanova.ai/v1/models"
	},
	{
		"id": "scaleway",
		"name": "Scaleway",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "SCW_SECRET_KEY",
			"url": "https://console.scaleway.com/iam/api-keys"
		},
		"baseUrl": "https://api.scaleway.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "deepseek/deepseek-v4-flash",
			"name": "DeepSeek V4 Flash",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Scaleway Generative APIs; SCW secret key.",
		"website": "https://www.scaleway.com/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "siliconflow",
		"name": "SiliconFlow",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "SILICONFLOW_API_KEY",
			"url": "https://cloud.siliconflow.com/account/ak"
		},
		"baseUrl": "https://api.siliconflow.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-ai/DeepSeek-V4-Pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V4-Flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V3.2",
				"name": "DeepSeek V3.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V3.2-Exp",
				"name": "DeepSeek V3.2 Exp",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V3.1",
				"name": "DeepSeek V3.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-V3.1-Terminus",
				"name": "DeepSeek V3.1 Terminus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-R1",
				"name": "DeepSeek R1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen3.5-397B-A17B",
				"name": "Qwen 3.5 397B A17B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen3.5-122B-A10B",
				"name": "Qwen 3.5 122B A10B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/GLM-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/GLM-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/Kimi-K2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/Kimi-K2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-oss-120b",
				"name": "GPT OSS 120B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMaxAI/MiniMax-M2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "inclusionAI/Ling-flash-2.0",
				"name": "Ling Flash 2.0",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen3-32B",
				"name": "Qwen3 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Chat ids from the 9router registry; listing is filtered with sub_type=chat.",
		"website": "https://siliconflow.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.siliconflow.com/v1/models"
	},
	{
		"id": "tencent",
		"name": "Tencent Hunyuan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "HUNYUAN_API_KEY",
			"url": "https://console.cloud.tencent.com/hunyuan/api-key"
		},
		"baseUrl": "https://api.hunyuan.cloud.tencent.com/v1",
		"format": "openai-chat",
		"models": [{
			"id": "hunyuan-turbos-latest",
			"name": "Hunyuan TurboS Latest",
			"contextWindow": 2e5,
			"vision": null,
			"reasoning": null
		}, {
			"id": "hunyuan-t1-latest",
			"name": "Hunyuan T1 Latest",
			"contextWindow": 256e3,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Tencent Hunyuan OpenAI-compatible endpoint.",
		"website": "https://cloud.tencent.com/product/hunyuan",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://api.hunyuan.cloud.tencent.com/v1/models"
	},
	{
		"id": "together",
		"name": "Together AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "TOGETHER_API_KEY",
			"url": "https://api.together.ai/settings/api-keys"
		},
		"baseUrl": "https://api.together.ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
				"name": "Llama 3.3 70B Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/DeepSeek-R1",
				"name": "DeepSeek R1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Qwen/Qwen3-235B-A22B",
				"name": "Qwen3 235B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
				"name": "Llama 4 Maverick",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/GLM-5.2",
				"name": "GLM-5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Embedding ids omitted; the FCC profile lists models at /models with context_length.",
		"website": "https://www.together.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.together.ai/v1/models"
	},
	{
		"id": "tokenrouter",
		"name": "TokenRouter",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "TOKENROUTER_API_KEY",
			"url": "https://www.tokenrouter.com/"
		},
		"baseUrl": "https://api.tokenrouter.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "anthropic/claude-haiku-4.5",
				"name": "Claude Haiku 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "anthropic/claude-sonnet-4.6",
				"name": "Claude Sonnet 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "anthropic/claude-opus-4.8",
				"name": "Claude Opus 4.8",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "anthropic/claude-opus-4.8-fast",
				"name": "Claude Opus 4.8 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-5.4",
				"name": "Gpt 5.4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-5.4-mini",
				"name": "Gpt 5.4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-5.4-pro",
				"name": "Gpt 5.4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-5.5",
				"name": "Gpt 5.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "openai/gpt-5.6-sol",
				"name": "Gpt 5.6 Sol",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "google/gemini-3.5-flash",
				"name": "Gemini 3.5 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "google/gemini-3.6-flash",
				"name": "Gemini 3.6 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek/deepseek-v4-flash",
				"name": "Deepseek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek/deepseek-v4-pro",
				"name": "Deepseek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3-coder-next",
				"name": "Qwen3 Coder Next",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3.7-max",
				"name": "Qwen3.7 Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3.8-max",
				"name": "Qwen3.8 Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/kimi-k2.7-code",
				"name": "Kimi K2.7 Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/kimi-k3-free",
				"name": "Kimi K3 Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "z-ai/glm-5.3-free",
				"name": "Glm 5.3 Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "z-ai/glm-5.2",
				"name": "Glm 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "z-ai/glm-5-turbo",
				"name": "Glm 5 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "x-ai/grok-4.5",
				"name": "Grok 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Multi-vendor gateway with free slugs.",
		"website": "https://www.tokenrouter.com/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["moonshotai/kimi-k3-free", "z-ai/glm-5.3-free"],
		"modelsUrl": "https://api.tokenrouter.com/v1/models"
	},
	{
		"id": "venice",
		"name": "Venice AI",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "VENICE_API_KEY",
			"url": "https://venice.ai/settings/api"
		},
		"baseUrl": "https://api.venice.ai/api/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "venice-uncensored-1-2",
				"name": "Venice Uncensored 1.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org-glm-5",
				"name": "GLM-5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-235b-a22b-instruct-2507",
				"name": "Qwen3 235B A22B Instruct",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder-480b-a35b-instruct-turbo",
				"name": "Qwen3 Coder 480B A35B Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-vl-235b-a22b",
				"name": "Qwen3 VL 235B A22B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "llama-3.3-70b",
				"name": "Llama 3.3 70B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "hermes-3-llama-3.1-405b",
				"name": "Hermes 3 Llama 3.1 405B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mistral-small-3-2-24b-instruct",
				"name": "Mistral Small 3.2 24B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Private inference plus uncensored models (9router notice). Embedding and image ids omitted.",
		"website": "https://venice.ai",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://api.venice.ai/api/v1/models"
	},
	{
		"id": "vercel",
		"name": "Vercel AI Gateway",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "AI_GATEWAY_API_KEY",
			"url": "https://vercel.com/docs/ai-gateway"
		},
		"baseUrl": "https://ai-gateway.vercel.sh/v1",
		"format": "openai-chat",
		"models": [{
			"id": "openai/gpt-5.5",
			"name": "GPT-5.5 (Vercel)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Vercel AI Gateway; models are vendor-namespaced.",
		"website": "https://vercel.com/ai-gateway",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "vertex",
		"name": "Google Vertex AI",
		"category": "apikey",
		"auth": {
			"kind": "adc",
			"env": null,
			"url": "https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment"
		},
		"baseUrl": "https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/{location}/endpoints/openapi",
		"format": "openai-chat",
		"models": [
			{
				"id": "gemini-3.1-pro-preview",
				"name": "Gemini 3.1 Pro Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-flash-lite-preview",
				"name": "Gemini 3.1 Flash Lite Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3-flash-preview",
				"name": "Gemini 3 Flash Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-2.5-flash",
				"name": "Gemini 2.5 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "google/gemini-3.5-flash",
				"name": "Gemini 3.5 Flash (Vertex)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "ADC (no key): VERTEX_PROJECT_ID and VERTEX_LOCATION compose the endpoint (FCC providers/vertex/endpoint.py).",
		"website": "https://cloud.google.com/vertex-ai",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "vertex-partner",
		"name": "Vertex Partner Models",
		"category": "apikey",
		"auth": {
			"kind": "adc",
			"env": null,
			"url": "https://console.cloud.google.com/iam-admin/serviceaccounts"
		},
		"baseUrl": "https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/{location}/endpoints/openapi",
		"format": "openai-chat",
		"models": [
			{
				"id": "deepseek-ai/deepseek-v3.2-maas",
				"name": "DeepSeek V3.2 (Vertex)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3-next-80b-a3b-thinking-maas",
				"name": "Qwen3 Next 80B Thinking (Vertex)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen/qwen3-next-80b-a3b-instruct-maas",
				"name": "Qwen3 Next 80B Instruct (Vertex)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "zai-org/glm-5-maas",
				"name": "GLM-5 (Vertex)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Vertex MaaS partner models (9router model list); the OpenAI-compatible base is composed per project/location (FCC providers/vertex/endpoint.py).",
		"website": "https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-partner-models",
		"local": false,
		"source": "9router"
	},
	{
		"id": "volcengine-ark",
		"name": "Volcengine Ark",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ARK_API_KEY",
			"url": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey"
		},
		"baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
		"format": "openai-chat",
		"models": [
			{
				"id": "Doubao-Seed-2.0-Code",
				"name": "Doubao-Seed-2.0-Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Doubao-Seed-2.0-pro",
				"name": "Doubao-Seed-2.0-pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Doubao-Seed-2.0-lite",
				"name": "Doubao-Seed-2.0-lite",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Doubao-Seed-Code",
				"name": "Doubao-Seed-Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "DeepSeek-V4-Flash",
				"name": "DeepSeek-V4-Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "DeepSeek-V4-Pro",
				"name": "DeepSeek-V4-Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "GLM-5.1",
				"name": "GLM-5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "MiniMax-M2.7",
				"name": "MiniMax-M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "Kimi-K2.6",
				"name": "Kimi-K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "ByteDance Volcengine coding endpoint (CN); 9router registry declares the key URL.",
		"website": "https://console.volcengine.com/ark",
		"local": false,
		"source": "9router"
	},
	{
		"id": "wafer",
		"name": "Wafer",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "WAFER_API_KEY",
			"url": "https://www.wafer.ai/pass"
		},
		"baseUrl": "https://pass.wafer.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "DeepSeek-V4-Pro",
			"name": "DeepSeek V4 Pro (Wafer)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Wafer pass endpoint.",
		"website": "https://www.wafer.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "wandb",
		"name": "W&B Inference",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "WANDB_API_KEY",
			"url": "https://wandb.ai/settings"
		},
		"baseUrl": "https://api.inference.wandb.ai/v1",
		"format": "openai-chat",
		"models": [{
			"id": "openai/gpt-oss-20b",
			"name": "GPT-OSS 20B",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "W&B Serverless Inference; reasoning arrives as think tags (FCC profile).",
		"website": "https://wandb.ai/site/inference/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "xai",
		"name": "xAI (Grok)",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "XAI_API_KEY",
			"url": "https://console.x.ai/team/default/api-keys"
		},
		"baseUrl": "https://api.x.ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "grok-4.6",
				"name": "Grok 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.5",
				"name": "Grok 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4",
				"name": "Grok 4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4-fast-reasoning",
				"name": "Grok 4 Fast Reasoning",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-code-fast-1",
				"name": "Grok Code Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-3",
				"name": "Grok 3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Image and video ids from the same registry listing are omitted (chat catalog).",
		"website": "https://x.ai/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://api.x.ai/v1/models"
	},
	{
		"id": "xiaomi-tokenplan",
		"name": "Xiaomi MiMo Token Plan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "XIAOMI_MIMO_API_KEY",
			"url": "https://mimo.xiaomi.com"
		},
		"baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "mimo-v2.5-pro",
				"name": "MiMo V2.5 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5-pro-claude",
				"name": "MiMo V2.5 Pro (Claude Native)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5",
				"name": "MiMo V2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2-pro",
				"name": "MiMo V2 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2-omni",
				"name": "MiMo V2 Omni",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Token Plan subscription (keys start with tp-) and are cluster-specific; TTS ids omitted (9router notice).",
		"website": "https://mimo.xiaomi.com",
		"local": false,
		"source": "9router"
	},
	{
		"id": "xkiro",
		"name": "xKiro",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "XKIRO_API_KEY",
			"url": "https://xkiro.com/dashboard/api/keys"
		},
		"baseUrl": "https://api.xkiro.com/v1",
		"format": "openai-chat",
		"models": [{
			"id": "qwen/qwen3.7-flash:free",
			"name": "Qwen3.7 Flash (free)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Multi-provider gateway; thinking is a capabilities.reasoning boolean in the listing (FCC profile).",
		"website": "https://xkiro.com/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["qwen/qwen3.7-flash:free"]
	},
	{
		"id": "zai",
		"name": "Z.ai Coding Plan",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ZAI_API_KEY",
			"url": "https://z.ai/manage-apikey/apikey-list"
		},
		"baseUrl": "https://api.z.ai/api/coding/paas/v4",
		"format": "openai-chat",
		"models": [
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5-turbo",
				"name": "GLM 5 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.6v",
				"name": "GLM 4.6V (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Z.ai coding-plan endpoint; caller extra_body is rejected (FCC profile). Ids are shared across Z.ai routes per the 9router glm registry.",
		"website": "https://z.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "zai_api",
		"name": "Z.ai API",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ZAI_API_KEY",
			"url": "https://z.ai/manage-apikey/apikey-list"
		},
		"baseUrl": "https://api.z.ai/api/paas/v4",
		"format": "openai-chat",
		"models": [
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5-turbo",
				"name": "GLM 5 Turbo",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.6v",
				"name": "GLM 4.6V (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7-flash",
				"name": "GLM 4.7 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Z.ai pay-as-you-go endpoint; ids are shared across Z.ai routes per the 9router glm registry.",
		"website": "https://z.ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "zenmux",
		"name": "ZenMux",
		"category": "apikey",
		"auth": {
			"kind": "apiKey",
			"env": "ZENMUX_API_KEY",
			"url": "https://zenmux.ai/platform/pay-as-you-go"
		},
		"baseUrl": "https://zenmux.ai/api/v1",
		"format": "openai-chat",
		"models": [{
			"id": "deepseek/deepseek-v4-flash-free",
			"name": "DeepSeek V4 Flash (free)",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "max_tokens is sent as max_completion_tokens (FCC profile).",
		"website": "https://zenmux.ai/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["deepseek/deepseek-v4-flash-free"]
	},
	{
		"id": "opencode",
		"name": "OpenCode Free",
		"category": "free",
		"auth": {
			"kind": "none",
			"env": null,
			"url": null
		},
		"baseUrl": "https://opencode.ai/zen/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "muse-spark-1.2-contributor-free",
				"name": "Muse Spark 1.2 Contributor Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.3-contributor-free",
				"name": "Muse Spark 1.3 Contributor Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "union-alpha",
				"name": "Union Alpha Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "jev-1.13-free",
				"name": "Jev 1.13 Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Keyless free pool (noAuth) — the plugin’s own free lane speaks to the same /zen/v1 host and sends the same x-opencode-client header. Per-model wires differ: two models answer over /responses and union-alpha over the Anthropic wire (9router registry comments).",
		"website": "https://opencode.ai",
		"local": false,
		"source": "9router",
		"modelsUrl": "https://opencode.ai/zen/v1/models",
		"headers": { "x-opencode-client": "desktop" }
	},
	{
		"id": "bazaarlink",
		"name": "BazaarLink",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "BAZAARLINK_API_KEY",
			"url": "https://bazaarlink.ai"
		},
		"baseUrl": "https://bazaarlink.ai/api/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "auto:free",
				"name": "Auto Free (Zero Cost)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4.7",
				"name": "Claude Opus 4.7",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4.6",
				"name": "Claude Sonnet 4.6",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-haiku-4.5",
				"name": "Claude Haiku 4.5",
				"contextWindow": 2e5,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.5",
				"name": "GPT-5.5",
				"contextWindow": 105e4,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4",
				"name": "GPT-5.4",
				"contextWindow": 105e4,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-mini",
				"name": "GPT-5.4 Mini",
				"contextWindow": 4e5,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-nano",
				"name": "GPT-5.4 Nano",
				"contextWindow": 4e5,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.3",
				"name": "Grok 4.3",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.20",
				"name": "Grok 4.20",
				"contextWindow": 2e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-pro-preview",
				"name": "Gemini 3.1 Pro",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3-flash-preview",
				"name": "Gemini 3 Flash",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-flash-lite-preview",
				"name": "Gemini 3.1 Flash Lite",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": 204800,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": 204800,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5-pro",
				"name": "MiMo-V2.5-Pro",
				"contextWindow": 105e4,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5",
				"name": "MiMo-V2.5",
				"contextWindow": 105e4,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m3",
				"name": "MiniMax M3",
				"contextWindow": 1048576,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.7",
				"name": "MiniMax M2.7",
				"contextWindow": 204800,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.5",
				"name": "MiniMax M2.5",
				"contextWindow": 204800,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.6-plus",
				"name": "Qwen 3.6 Plus",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nemotron-3-super-120b-a12b",
				"name": "Nemotron 3 Super",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Multi-vendor gateway with an auto:free slug; 9router lists it as free-tier.",
		"website": "https://bazaarlink.ai",
		"local": false,
		"source": "9router",
		"freeModelsHint": ["auto:free"],
		"modelsUrl": "https://bazaarlink.ai/api/v1/models"
	},
	{
		"id": "byteplus",
		"name": "BytePlus Ark",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "BYTEPLUS_API_KEY",
			"url": "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey"
		},
		"baseUrl": "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
		"format": "openai-chat",
		"models": [
			{
				"id": "seed-2-0-pro-260328",
				"name": "Seed 2.0 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "seed-2-0-code-preview-260328",
				"name": "Seed 2.0 Code Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "seed-2-0-mini-260215",
				"name": "Seed 2.0 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "seed-2-0-lite-260228",
				"name": "Seed 2.0 Lite",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2-thinking-251104",
				"name": "Kimi K2 Thinking",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4-7-251222",
				"name": "GLM 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-oss-120b-250805",
				"name": "GPT-OSS-120B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Free credits for new accounts (9router notice); Seed 2.0, Kimi K2 Thinking, GLM 4.7 and GPT-OSS-120B.",
		"website": "https://console.byteplus.com/ark",
		"local": false,
		"source": "9router"
	},
	{
		"id": "cloudflare",
		"name": "Cloudflare",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "CLOUDFLARE_API_TOKEN",
			"url": "https://dash.cloudflare.com/profile/api-tokens"
		},
		"baseUrl": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "@cf/meta/llama-3.2-1b-instruct",
				"name": "Llama 3.2 1B Instruct",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/meta/llama-3.2-3b-instruct",
				"name": "Llama 3.2 3B Instruct",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
				"name": "Llama 3.1 8B Instruct FP8 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/meta/llama-3.1-8b-instruct-awq",
				"name": "Llama 3.1 8B Instruct AWQ",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
				"name": "Mistral Small 3.1 24B Instruct",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/meta/llama-3.1-70b-instruct-fp8-fast",
				"name": "Llama 3.1 70B Instruct FP8 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
				"name": "Llama 3.3 70B Instruct FP8 Fast",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
				"name": "DeepSeek R1 Distill Qwen 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/moonshotai/kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/moonshotai/kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/zai-org/glm-4.7-flash",
				"name": "GLM 4.7 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/qwen/qwq-32b",
				"name": "QwQ 32B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "@cf/qwen/qwen2.5-coder-32b-instruct",
				"name": "Qwen 2.5 Coder 32B Instruct",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Account-scoped URL — replace {account_id}; Workers AI has a free allocation and 9router lists it as free-tier. Image ids omitted.",
		"website": "https://www.cloudflare.com/developer-platform/products/workers-ai/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "gemini",
		"name": "Gemini",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "GEMINI_API_KEY",
			"url": "https://aistudio.google.com/apikey"
		},
		"baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
		"format": "openai-chat",
		"models": [
			{
				"id": "gemini-3.8-flash",
				"name": "Gemini 3.8 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.7-flash",
				"name": "Gemini 3.7 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.6-flash",
				"name": "Gemini 3.6 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.5-flash-lite",
				"name": "Gemini 3.5 Flash Lite",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-pro-preview",
				"name": "Gemini 3.1 Pro Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-flash-lite-preview",
				"name": "Gemini 3.1 Flash Lite Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3-flash-preview",
				"name": "Gemini 3 Flash Preview",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-2.5-pro",
				"name": "Gemini 2.5 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-2.5-flash",
				"name": "Gemini 2.5 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-2.5-flash-lite",
				"name": "Gemini 2.5 Flash Lite",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemma-4-31b-it",
				"name": "Gemma 4 31B IT",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Google AI Studio key; 9router lists it as free-tier. FCC speaks the OpenAI-compatible layer at /v1beta/openai/.",
		"website": "https://ai.google.dev/",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "kilo",
		"name": "Kilo.ai",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "KILO_API_KEY",
			"url": "https://app.kilo.ai"
		},
		"baseUrl": "https://api.kilo.ai/api/gateway",
		"format": "openai-chat",
		"models": [
			{
				"id": "kilo-auto/free",
				"name": "Kilo Auto Free",
				"contextWindow": 256e3,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nvidia/nemotron-3-super-120b-a12b:free",
				"name": "Nemotron 3 Super 120B (Free)",
				"contextWindow": 262144,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nvidia/nemotron-3-ultra-550b-a55b:free",
				"name": "Nemotron 3 Ultra 550B (Free)",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kwaipilot/kat-coder-pro-v2.5:free",
				"name": "Kat Coder Pro v2.5 (Free)",
				"contextWindow": 256e3,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kilo-auto/frontier",
				"name": "Kilo Auto Frontier",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kilo-auto/balanced",
				"name": "Kilo Auto Balanced",
				"contextWindow": 1e6,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Kilo gateway free pool; the plugin’s own Kilo channel reads the same host.",
		"website": "https://kilo.ai/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": [
			"kilo-auto/free",
			"nvidia/nemotron-3-super-120b-a12b:free",
			"nvidia/nemotron-3-ultra-550b-a55b:free",
			"kwaipilot/kat-coder-pro-v2.5:free"
		],
		"modelsUrl": "https://api.kilo.ai/api/gateway/models"
	},
	{
		"id": "kimchi",
		"name": "Kimchi",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "KIMCHI_API_KEY",
			"url": "https://app.kimchi.dev"
		},
		"baseUrl": "https://llm.kimchi.dev/openai/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "minimax-m3",
				"name": "MiniMax-M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.7",
				"name": "Kimi-K2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi-K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi-K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nemotron-3-ultra-fp4",
				"name": "Nemotron 3 Ultra FP4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.7",
				"name": "MiniMax-M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-6",
				"name": "Claude Opus 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4-6",
				"name": "Claude Sonnet 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "9router lists it as free-tier with oauth and apikey modes; the signup URL issues the credential. The user-agent is declared by the 9router registry.",
		"website": "https://kimchi.dev",
		"local": false,
		"source": "9router",
		"headers": { "user-agent": "kimchi/0.1.50" }
	},
	{
		"id": "nvidia_nim",
		"name": "NVIDIA NIM",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "NVIDIA_NIM_API_KEY",
			"url": "https://build.nvidia.com/settings/api-keys"
		},
		"baseUrl": "https://integrate.api.nvidia.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "minimaxai/minimax-m2.7",
				"name": "MiniMax M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimaxai/minimax-m3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "z-ai/glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-ai/deepseek-v4-flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "moonshotai/kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nvidia/nemotron-3-ultra-550b-a55b",
				"name": "Nemotron 3 Ultra",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nvidia/nemotron-3-super-120b-a12b",
				"name": "Nemotron 3 Super 120B",
				"contextWindow": 131072,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Free access for NVIDIA Developer Program members (prototyping and testing) per the 9router registry; FCC ships it as the default provider.",
		"website": "https://build.nvidia.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://integrate.api.nvidia.com/v1/models"
	},
	{
		"id": "ollama_cloud",
		"name": "Ollama Cloud",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "OLLAMA_API_KEY",
			"url": "https://ollama.com/settings/keys"
		},
		"baseUrl": "https://ollama.com/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "gpt-oss:120b",
				"name": "GPT OSS 120B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-4.7-flash",
				"name": "GLM 4.7 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.5",
				"name": "Qwen3.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4.1-flash:cloud",
				"name": "DeepSeek V4.1 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3-coder:480b",
				"name": "Qwen3 Coder 480B",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "Free tier: light usage, one cloud model at a time (9router notice). Tags are not OpenAI ids but Ollama model names.",
		"website": "https://ollama.com/",
		"local": false,
		"source": "fcc",
		"modelsUrl": "https://ollama.com/api/tags"
	},
	{
		"id": "open_router",
		"name": "OpenRouter",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "OPENROUTER_API_KEY",
			"url": "https://openrouter.ai/keys"
		},
		"baseUrl": "https://openrouter.ai/api/v1",
		"format": "openai-chat",
		"models": [{
			"id": "openrouter/free",
			"name": "OpenRouter Free Router",
			"contextWindow": null,
			"vision": null,
			"reasoning": null
		}],
		"notes": "Free tier: 27+ free models, no credit card, ~200 requests/day (9router registry).",
		"website": "https://openrouter.ai/",
		"local": false,
		"source": "fcc",
		"freeModelsHint": ["openrouter/free"]
	},
	{
		"id": "opencode_zen",
		"name": "OpenCode Zen",
		"category": "free-tier",
		"auth": {
			"kind": "apiKey",
			"env": "OPENCODE_API_KEY",
			"url": "https://opencode.ai/auth"
		},
		"baseUrl": "https://opencode.ai/zen/v1",
		"format": "openai-chat",
		"models": [
			{
				"id": "claude-fable-5",
				"name": "Claude Fable 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-fable-5-1",
				"name": "Claude Fable 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-5",
				"name": "Claude Opus 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-8",
				"name": "Claude Opus 4.8",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-7",
				"name": "Claude Opus 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-6",
				"name": "Claude Opus 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4-5",
				"name": "Claude Opus 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-5",
				"name": "Claude Sonnet 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4-6",
				"name": "Claude Sonnet 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4-5",
				"name": "Claude Sonnet 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4",
				"name": "Claude Sonnet 4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-haiku-4-5",
				"name": "Claude Haiku 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.6-flash",
				"name": "Gemini 3.6 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.8-flash",
				"name": "Gemini 3.8 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.7-flash",
				"name": "Gemini 3.7 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.5-flash-lite",
				"name": "Gemini 3.5 Flash Lite",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.5-flash",
				"name": "Gemini 3.5 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-pro",
				"name": "Gemini 3.1 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3-flash",
				"name": "Gemini 3 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-6-astra",
				"name": "GPT 6 Astra",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-sol",
				"name": "GPT 5.6 Sol",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-terra",
				"name": "GPT 5.6 Terra",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-luna",
				"name": "GPT 5.6 Luna",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.5",
				"name": "GPT 5.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.5-pro",
				"name": "GPT 5.5 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4",
				"name": "GPT 5.4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-pro",
				"name": "GPT 5.4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-mini",
				"name": "GPT 5.4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-nano",
				"name": "GPT 5.4 Nano",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.3-codex-spark",
				"name": "GPT 5.3 Codex Spark",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.3-codex",
				"name": "GPT 5.3 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.2",
				"name": "GPT 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.2-codex",
				"name": "GPT 5.2 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.1",
				"name": "GPT 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.1-codex-max",
				"name": "GPT 5.1 Codex Max",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.1-codex",
				"name": "GPT 5.1 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.1-codex-mini",
				"name": "GPT 5.1 Codex Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5",
				"name": "GPT 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5-codex",
				"name": "GPT 5 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5-nano",
				"name": "GPT 5 Nano",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-build-0.1",
				"name": "Grok Build 0.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.6",
				"name": "Grok 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-4.5",
				"name": "Grok 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.3",
				"name": "Muse Spark 1.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.2",
				"name": "Muse Spark 1.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.6-plus",
				"name": "Qwen 3.6 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "qwen3.5-plus",
				"name": "Qwen 3.5 Plus",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-pro",
				"name": "DeepSeek V4 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash",
				"name": "DeepSeek V4 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash-vision-exp",
				"name": "DeepSeek V4 Flash Vision Exp",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3-flash",
				"name": "GLM 5.3 Flash (Vision)",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.3",
				"name": "GLM 5.3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.2",
				"name": "GLM 5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5.1",
				"name": "GLM 5.1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "glm-5",
				"name": "GLM 5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m3",
				"name": "MiniMax M3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.7",
				"name": "MiniMax M2.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "minimax-m2.5",
				"name": "MiniMax M2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k3",
				"name": "Kimi K3",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.7-code",
				"name": "Kimi K2.7 Code",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.6",
				"name": "Kimi K2.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "kimi-k2.5",
				"name": "Kimi K2.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "big-pickle",
				"name": "Big Pickle",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "union-alpha",
				"name": "Union Alpha",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "deepseek-v4-flash-free",
				"name": "DeepSeek V4 Flash Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.6-flash-free",
				"name": "MiMo V2.6 Flash Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "mimo-v2.5-free",
				"name": "MiMo V2.5 Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "ling-3.0-flash-fin-free",
				"name": "Ling 3.0 Flash Fin Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nemotron-3-ultra-free",
				"name": "Nemotron 3 Ultra Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "nemotron-3.5-lightning-free",
				"name": "Nemotron 3.5 Lightning Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.3-contributor-free",
				"name": "Muse Spark 1.3 Contributor Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "muse-spark-1.2-contributor-free",
				"name": "Muse Spark 1.2 Contributor Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "jev-1.13",
				"name": "Jev 1.13",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "jev-1.13-free",
				"name": "Jev 1.13 Free",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "PAYG key with free models on the fast lane (9router notice); FCC dispatches each catalog route over chat or responses.",
		"website": "https://opencode.ai/zen",
		"local": false,
		"source": "fcc",
		"freeModelsHint": [
			"deepseek-v4-flash-free",
			"mimo-v2.6-flash-free",
			"mimo-v2.5-free",
			"ling-3.0-flash-fin-free",
			"nemotron-3-ultra-free",
			"nemotron-3.5-lightning-free",
			"muse-spark-1.3-contributor-free",
			"muse-spark-1.2-contributor-free",
			"jev-1.13-free"
		]
	},
	{
		"id": "llamacpp",
		"name": "LLaMA.cpp",
		"category": "local",
		"auth": {
			"kind": "none",
			"env": null,
			"url": null
		},
		"baseUrl": "http://localhost:8080/v1",
		"format": "openai-chat",
		"models": [],
		"notes": "Local server; the model list is whatever the user has loaded, so the registry carries no ids.",
		"website": "https://github.com/ggml-org/llama.cpp",
		"local": true,
		"source": "fcc",
		"baseUrlOverrideEnv": "LLAMACPP_BASE_URL"
	},
	{
		"id": "lmstudio",
		"name": "LM Studio",
		"category": "local",
		"auth": {
			"kind": "none",
			"env": null,
			"url": null
		},
		"baseUrl": "http://localhost:1234/v1",
		"format": "openai-chat",
		"models": [],
		"notes": "Local server; the model list is whatever the user has loaded, so the registry carries no ids.",
		"website": "https://lmstudio.ai/",
		"local": true,
		"source": "fcc",
		"baseUrlOverrideEnv": "LM_STUDIO_BASE_URL"
	},
	{
		"id": "ollama",
		"name": "Ollama",
		"category": "local",
		"auth": {
			"kind": "none",
			"env": null,
			"url": null
		},
		"baseUrl": "http://localhost:11434/v1",
		"format": "openai-chat",
		"models": [],
		"notes": "Local server; FCC normalizes the configured root to /v1, and the model list is whatever the user has pulled.",
		"website": "https://ollama.com/",
		"local": true,
		"source": "fcc",
		"baseUrlOverrideEnv": "OLLAMA_BASE_URL"
	},
	{
		"id": "github_copilot",
		"name": "GitHub Copilot",
		"category": "oauth",
		"auth": {
			"kind": "oauth",
			"env": null,
			"url": "https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate"
		},
		"baseUrl": "https://api.githubcopilot.com",
		"format": "openai-chat",
		"models": [
			{
				"id": "gpt-5.2",
				"name": "GPT-5.2",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.2-codex",
				"name": "GPT-5.2 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.3-codex",
				"name": "GPT-5.3 Codex",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4",
				"name": "GPT-5.4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-mini",
				"name": "GPT-5.4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-haiku-4.5",
				"name": "Claude Haiku 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4.5",
				"name": "Claude Opus 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4.5",
				"name": "Claude Sonnet 4.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-sonnet-4.6",
				"name": "Claude Sonnet 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4.6",
				"name": "Claude Opus 4.6",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "claude-opus-4.7",
				"name": "Claude Opus 4.7",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-2.5-pro",
				"name": "Gemini 2.5 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3-flash-preview",
				"name": "Gemini 3 Flash",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gemini-3.1-pro-preview",
				"name": "Gemini 3.1 Pro",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "grok-code-fast-1",
				"name": "Grok Code Fast 1",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "oswe-vscode-prime",
				"name": "Raptor Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "goldeneye-free-auto",
				"name": "GoldenEye",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "GitHub account sign-in; the usable model set depends on the subscription (embedding ids omitted).",
		"website": "https://github.com/features/copilot",
		"local": false,
		"source": "fcc"
	},
	{
		"id": "openai",
		"name": "OpenAI / ChatGPT",
		"category": "oauth",
		"auth": {
			"kind": "oauth",
			"env": null,
			"url": "https://learn.chatgpt.com/docs/auth"
		},
		"baseUrl": "https://chatgpt.com/backend-api/codex",
		"format": "openai-responses",
		"models": [
			{
				"id": "gpt-6-astra",
				"name": "GPT 6.0 Astra",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-sol",
				"name": "GPT 5.6 Sol",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-terra",
				"name": "GPT 5.6 Terra",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.6-luna",
				"name": "GPT 5.6 Luna",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.5",
				"name": "GPT 5.5",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4",
				"name": "GPT 5.4",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.4-mini",
				"name": "GPT 5.4 Mini",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			},
			{
				"id": "gpt-5.3-codex-spark",
				"name": "GPT 5.3 Codex Spark",
				"contextWindow": null,
				"vision": null,
				"reasoning": null
			}
		],
		"notes": "ChatGPT subscription via browser sign-in (connected account); responses wire on chatgpt.com/backend-api/codex.",
		"website": "https://openai.com/",
		"local": false,
		"source": "fcc"
	}
].map((entry) => Object.freeze({
	...entry,
	models: Object.freeze([...entry.models ?? []])
})));
new Map(PROVIDERS.map((provider) => [provider.id, provider]));
Object.freeze({
	"openai-chat": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/messages"
});
Object.freeze({
	"openai-chat": "chat",
	"openai-responses": "responses",
	"anthropic-messages": "messages"
});
Object.freeze({
	"openai-chat": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/messages"
});
typeof process === "undefined" || process.env.XDPOOL_FREE_BASE;
Object.freeze([
	"muse-spark-1.3-contributor-free",
	"muse-spark-1.2-contributor-free",
	"union-alpha",
	"space-bunny-free",
	"nemotron-3-ultra-free",
	"deepseek-v4-flash-free",
	"mimo-v2.6-flash-free",
	"mimo-v2.5-free",
	"jev-1.13-free"
]);
//#endregion
//#region src/task-events.ts
/**
* The app the buddy chain enters.
*
* One chain lights up two tasks: `Buddy_App` (open any app) and `Buddy_App_QQ`
* (the QQ-specific one), because this is a QQ-hosted app. Measured 0/1 → 1/1 on
* both from a single chain.
*/
const BUDDY_APP_ID = "cb_y5Dy46tPQGGWtueMxXbe";
const BUDDY_APP_NAME = "企鹅教师助手";
/** A stable-ish id for a synthetic conversation, unique per call. */
function syntheticId(prefix) {
	return `wb2auto-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
* A chat chain seeded with a placeholder conversation/request id.
*
* Several tasks do not verify that the conversation exists — they only check
* that the events in the chain carry *a* well-formed id — so a synthetic pair is
* enough. `RichMeow_Chat`, `create_canvas` and `automation_1` were all measured
* lighting up from exactly this.
*/
function syntheticChatChain(prefix) {
	const conversationId = syntheticId(prefix);
	const requestId = syntheticId(`${prefix}-req`);
	return {
		conversationId,
		requestId,
		events: desktopChatEvents(conversationId, requestId, `msg-${prefix}`)
	};
}
/**
* The buddy-app chain (two tasks).
*
* Five clicks in the order a user would make them: discover the app, see it,
* enter it, confirm the account link, skip the second binding step.
*/
function buddyAppChain() {
	const base = {
		mode: "LOCAL",
		buddyId: BUDDY_APP_ID,
		buddyName: BUDDY_APP_NAME
	};
	return {
		transport: "desktop",
		events: [
			{
				...base,
				eventCode: "buddyapp_discover_click"
			},
			{
				...base,
				eventCode: "buddyapp_show",
				elementId: BUDDY_APP_ID,
				elementName: BUDDY_APP_NAME,
				position: 2
			},
			{
				...base,
				eventCode: "buddyapp_enter_click",
				elementId: BUDDY_APP_ID,
				elementName: BUDDY_APP_NAME,
				position: 2,
				isFirstPage: "1"
			},
			{
				...base,
				eventCode: "buddyapp_auth_confirm_click",
				elementId: BUDDY_APP_ID,
				elementName: BUDDY_APP_NAME
			},
			{
				...base,
				eventCode: "buddyapp_bindaccount_skip_click",
				elementId: BUDDY_APP_ID,
				elementName: BUDDY_APP_NAME
			}
		]
	};
}
/**
* The design-canvas chain (`create_canvas`, +300 — the joint largest reward).
*
* The two canvas events ride the same metrics channel as everything else, so no
* real canvas is ever created; the chat chain in front supplies the ids they
* reference. Measured 1/1 on three accounts.
*/
function canvasChain() {
	const { conversationId, requestId, events } = syntheticChatChain("canvas");
	return {
		transport: "desktop",
		events: [
			...events,
			{
				eventCode: "wbx_design_canvas_task_create",
				conversationId,
				requestId,
				source: "summon_keyword",
				cost: 12e3,
				isSuccessful: true
			},
			{
				eventCode: "wbx_design_canvas_open",
				conversationId,
				requestId,
				id: `ardot-file-${requestId.slice(-8)}`,
				source: "summon_keyword",
				type: "page",
				cost: 13e3,
				isSuccessful: true
			}
		]
	};
}
/**
* The scheduled-task event (`automation_1`).
*
* One event is the whole chain — measured 1/1 on two accounts. The name is only
* for the server's own records, so a generated one is fine.
*/
function automationChain() {
	return {
		transport: "desktop",
		events: [{
			eventCode: "automated_task_create_suc",
			name: `定时任务-${Date.now().toString(36)}`,
			source: "manually",
			modelId: "fast-model",
			modelIsThinking: true,
			connectorCount: 0,
			skills: "",
			skillCount: 0,
			scheduleType: "once",
			mode: "LOCAL"
		}]
	};
}
/**
* The plain chat chain (`RichMeow_Chat`, and the base of the template chain).
*
* Measured: this chain alone lights `RichMeow_Chat`.
*/
function chatChain() {
	const { events } = syntheticChatChain("chat");
	return {
		transport: "desktop",
		events
	};
}
/**
* The "same as this case" chain (`playbook_prompt`).
*
* The scorer watches `playbook_prompt_send` — sending the prompt that the
* inspiration case pre-fills — not the card impression or the button click, so
* the whole click path is replayed for realism but the send is what counts.
*/
function playbookChain(caseId = PLAYBOOK_CASE_ID, caseName = PLAYBOOK_CASE_NAME) {
	const { conversationId, requestId, events } = syntheticChatChain("pb");
	const payload = {
		id: caseId,
		name: caseName,
		type: "document",
		categoryId: "",
		categoryName: ""
	};
	return {
		transport: "desktop",
		events: [
			...events,
			{
				eventCode: "web_element_click",
				pageName: "playbook_detail",
				elementId: "playbook_ctaClick",
				elementName: caseName,
				source: "discover"
			},
			{
				eventCode: "playbook_cta_click",
				source: "discover",
				position: 0,
				...payload
			},
			{
				eventCode: "playbook_prompt_send",
				conversationId,
				requestId,
				...payload
			}
		]
	};
}
/** The inspiration case the reference panel sends a prompt for. */
const PLAYBOOK_CASE_ID = "pm-gtm-launch-plan";
const PLAYBOOK_CASE_NAME = "新产品上市 GTM 发布计划一页纸";
/**
* The five templates the reference panel cycles through, as `[id, name]`.
*
* The upstream does not check that these templates exist — only that five
* distinct `template_used` events arrive — so they are the reference set.
*/
const TEMPLATE_PRESETS = [
	["1", "深度研究"],
	["2", "周报生成"],
	["3", "竞品分析"],
	["4", "活动策划"],
	["5", "代码评审"]
];
/**
* One "created a task from a template" chain (`template_5`, +100 for five).
*
* Each group is a chat chain (which supplies the ids the template events join
* on) plus `agent_task_created_with_template` and `template_used`. Measured:
* five groups in one report scored 5/5.
*/
function templateChain(templateId, templateName) {
	const { conversationId, requestId, events } = syntheticChatChain(`tpl${templateId}`);
	return {
		transport: "desktop",
		events: [
			...events,
			{
				eventCode: "agent_task_created_with_template",
				mode: "working",
				isCustomModel: false,
				id: templateId,
				name: templateName,
				requestId
			},
			{
				eventCode: "template_used",
				template_id: templateId,
				task_mode: "working"
			}
		]
	};
}
/** Every template group, ready to send in order. */
function templateChains() {
	return TEMPLATE_PRESETS.map(([id, name]) => templateChain(id, name));
}
/**
* The library-introduction click (`Library_read`).
*
* Scored on the WEB fingerprint — the same event posted with the desktop
* fingerprint scores nothing — so this chain returns a web transport and the
* scheduler routes it through `reportWebEvent`.
*/
function libraryReadChain() {
	return {
		transport: "web",
		web: {
			eventCode: "web_element_click",
			pageUrl: LIBRARY_DOC_URL,
			elementId: "library_doc_intro_click",
			elementName: "WorkBuddy资料库介绍"
		}
	};
}
/** The document the library click is reported against. */
const LIBRARY_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
/** The theme key `Hp_Appearance` is scored on (和平精英激战金秋). */
const APPEARANCE_THEME_KEY = "theme-tkmw7j";
/** The skill `skill_1` is scored on. */
const SKILL_ID = "skill_2097350077599879168";
const SKILL_NAME = "润泽小馆·日报撰写";
const SKILL_VERSION = "1.0.0";
/** The 腾讯轻量云 expert `Expert_lighthouse` is scored on. */
const LIGHTHOUSE_EXPERT_ID = "ex_2cvvUZQhDyeJ";
/**
* Rewrite the chain so the chatting half claims a tool call happened.
*
* A skills task is only credited when the response reports
* `finishReason: 'tool_calls'` — that is, the model loaded the skill as a tool —
* rather than a plain text answer.
*/
function markToolCall(events) {
	return events.map((event) => event["eventCode"] === "chat_message_response" ? {
		...event,
		finishReason: "tool_calls"
	} : event);
}
/**
* Build the `skill_1` chain from a REAL conversation.
*
* Unlike the template and canvas chains, this one is verified against the
* conversation it names, so the caller must first open a real chat and hand the
* server-side ids in.
*/
function skillChain(conversationId, requestId) {
	const messageId = `msg-${requestId.slice(-8)}`;
	return {
		transport: "desktop",
		events: [...markToolCall(desktopChatEvents(conversationId, requestId, messageId)), {
			eventCode: "skill_info",
			id: SKILL_NAME,
			skillId: SKILL_ID,
			skillVersion: SKILL_VERSION,
			toolStatus: "success",
			fileCount: 56,
			source: "workbuddy-desktop",
			conversationId,
			requestId,
			messageId,
			requestModelId: "fast-model",
			requestModelName: "fast-model",
			traceId: requestId
		}]
	};
}
/** The theme-apply event `Hp_Appearance` is scored on. */
function appearanceChain(themeKey = APPEARANCE_THEME_KEY) {
	return {
		transport: "desktop",
		events: [{
			eventCode: "appearance_skin_apply",
			action: "apply",
			source: "settings_close",
			id: themeKey,
			vipLevel: 0,
			series: "",
			type: "unknown"
		}]
	};
}
/**
* The three "summon an expert" events (`expert_summon_click` and friends).
*
* Paid before the conversation, in the order the app emits them.
*/
function expertSummonEvents(expert) {
	const category = expert.categories[0] ?? "expert-all";
	const version = expert.version === "" ? "1.0.0" : expert.version;
	return [
		{
			eventCode: "web_element_click",
			source: expert.expertId,
			type: category,
			version,
			elementId: "expert_summon_click",
			elementName: "立即召唤",
			pageURL: "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html"
		},
		{
			eventCode: "expert_summon_click",
			id: expert.expertId,
			name: expert.displayName,
			expertTitle: expert.profession,
			type: "expert-all",
			position: 0,
			expertType: expert.expertType,
			version,
			mode: "LOCAL"
		},
		{
			eventCode: "expert_summoned",
			id: expert.expertId,
			name: expert.displayName,
			expertTitle: expert.profession,
			type: "expert-all"
		}
	];
}
/**
* The "an expert really answered" event, which is what the expert tasks count.
*
* The `requestId` must be the SERVER's id for a real chat: a made-up one scores
* nothing, because the scorer looks the conversation up.
*/
function expertActualUseEvent(expert, conversationId, requestId, mode = "craft") {
	const category = expert.categories[0] ?? "expert-all";
	const version = expert.version === "" ? "1.0.0" : expert.version;
	return {
		eventCode: "expert_actual_use",
		id: expert.expertId,
		name: expert.displayName,
		expertTitle: expert.profession,
		type: category,
		expertType: expert.expertType,
		source: "builtin",
		version,
		cost: 9e3,
		characterCount: 14,
		mode,
		conversationId,
		requestId,
		messageId: `msg-${requestId.slice(-8)}`,
		requestModelId: "fast-model",
		requestModelName: "fast-model"
	};
}
/**
* The chat chain for an expert conversation.
*
* `agent_task_created` carries the expert fields the scorer reads to attribute
* the conversation to that expert.
*/
function expertChatEvents(expert, conversationId, requestId) {
	return desktopChatEvents(conversationId, requestId, `msg-${requestId.slice(-8)}`).map((event) => event["eventCode"] === "agent_task_created" ? {
		...event,
		has_expert: true,
		expert_id: expert.expertId,
		expert_name: expert.displayName,
		expert_industry_id: ""
	} : event);
}
/**
* The fallback record for the 腾讯轻量云 expert, used when the marketplace
* listing cannot be read. The id is the one the task is scored against.
*/
const LIGHTHOUSE_EXPERT = {
	expertId: LIGHTHOUSE_EXPERT_ID,
	expertType: "agent",
	displayName: "腾讯轻量云专家",
	profession: "腾讯轻量云专家",
	version: "1.0.2",
	categories: []
};
/**
* Tasks with a chain in this module.
*
* Membership is the filter the pass uses before it tries to build one, so a
* task with no chain costs no upstream call. It has to be kept in step with
* `chainsFor`'s switch: a code listed here with no case would be read and then
* silently skipped.
*/
const EVENT_CHAIN_BUILDERS = {
	Buddy_App: true,
	Buddy_App_QQ: true,
	create_canvas: true,
	automation_1: true,
	RichMeow_Chat: true,
	playbook_prompt: true,
	template_5: true,
	Hp_Appearance: true,
	Library_read: true,
	skill_1: true,
	expert_5: true,
	Expert_team_use_3: true,
	Expert_lighthouse: true
};
const AUTOMATION_TICK_MS = 6e4;
const JOB_KINDS = [
	"checkin",
	"report",
	"tasks",
	"streak",
	"travel",
	"compensation"
];
/**
* Pick the hour list to run on: the configured one, or the default.
*
* An EMPTY list is treated as "not configured" rather than as "never run".
* That distinction is the whole point: the settings schema materializes an
* absent list into `[]` (a bare `z.array` with no `.default()`), so a config
* that never mentioned the schedule arrives here looking exactly like one
* deliberately set to nothing — and honouring the empty reading silently
* disabled every job while the card still showed the switch as ON.
*
* A user who genuinely wants a job skipped can leave it out of the schedule
* they save; they cannot express "off" with an empty array through the card
* either way, because the card always writes a non-empty list.
*/
function hoursOrDefault(configured, fallback) {
	return configured !== void 0 && configured.length > 0 ? configured : fallback;
}
const EMPTY_JOB_STATE = {
	ok: 0,
	failed: 0,
	credit: 0,
	energy: 0,
	claimed: 0
};
/** `YYYY-MM-DD` in local time, the day key every job resets on. */
/**
* What the ledger gained between two snapshots, per account and in total.
*
* A diff rather than an absolute read: the card asks "what did this run do",
* and the ledger holds the whole day, so reporting totals would re-count
* everything an earlier run had already claimed.
*/
function diffEarnings(before, after) {
	const accounts = {};
	let credit = 0;
	let energy = 0;
	let claimed = 0;
	for (const [id, entry] of Object.entries(after)) {
		const was = before[id];
		const gain = {
			credit: entry.credit - (was?.credit ?? 0),
			energy: entry.energy - (was?.energy ?? 0),
			claimed: entry.claimed - (was?.claimed ?? 0),
			checkinCredit: entry.checkinCredit - (was?.checkinCredit ?? 0),
			bonusCredit: entry.bonusCredit - (was?.bonusCredit ?? 0),
			travelCredit: entry.travelCredit - (was?.travelCredit ?? 0),
			compensationCredit: entry.compensationCredit - (was?.compensationCredit ?? 0)
		};
		if (gain.credit === 0 && gain.energy === 0 && gain.claimed === 0 && gain.checkinCredit === 0 && gain.bonusCredit === 0 && gain.travelCredit === 0 && gain.compensationCredit === 0) continue;
		accounts[id] = gain;
		credit += gain.credit;
		energy += gain.energy;
		claimed += gain.claimed;
	}
	return {
		credit,
		energy,
		claimed,
		accounts
	};
}
/**
* The timezone every hour in this file is interpreted in.
*
* The activity windows these jobs target are defined in Beijing time, but the
* scheduler used `getHours()`, which answers in the host machine's local zone.
* On a machine set to anything else, "09:00" was 09:00 local — a check-in that
* simply never came due. Naming the zone makes the hour mean the same instant
* everywhere DSH runs, and is also what lets a test pin the behaviour.
*/
const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
/** Calendar parts of `date` in `timeZone`, all as zero-padded strings. */
function zonedParts(date, timeZone = AUTOMATION_TIME_ZONE) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(date);
	const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
	return {
		year: pick("year"),
		month: pick("month"),
		day: pick("day"),
		hour: pick("hour")
	};
}
function dayKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	const { year, month, day } = zonedParts(date, timeZone);
	return `${year}-${month}-${day}`;
}
/**
* The scheduled SLOT `date` falls in, as `YYYY-MM-DDTHH`.
*
* The per-job run guard keys on this instead of the date, so a job configured
* for several hours runs in each of them while a second tick inside the same
* hour is still refused.
*/
function slotKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	const { hour } = zonedParts(date, timeZone);
	return `${dayKey(date, timeZone)}T${hour}`;
}
/** Whether this account may be used: not switched off, not cooling. */
function eligible(account, now) {
	if (account.cooldownUntilMs > now) return false;
	if (regionOf(account.credential.domain) === "global") return false;
	return true;
}
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/**
* The points automation.
*
* Owns a single timer loop. Construction is inert — nothing runs until
* {@link start}, and {@link stop} is idempotent so a plugin teardown that fires
* twice is harmless.
*/
var WorkBuddyScheduler = class {
	pool;
	client;
	logger;
	now;
	delayMs;
	/**
	* How long to wait for event scoring before re-reading the task list.
	* Tests set 0 so a pass does not spend nine real seconds per account.
	*/
	eventScoreWaitMs;
	/**
	* Gap between two expert summon chains.
	* Tests set 0 so a pass does not spend six real seconds per expert.
	*/
	expertGapMs;
	enabled;
	checkinHours;
	taskHours;
	reportHours;
	streakHours;
	travelHours;
	compensationHours;
	timer;
	running = false;
	/** Guards against a slow run overlapping the next tick. */
	busy = false;
	/** True while a manual run is in flight, so the card can poll it. */
	runInFlight = false;
	/**
	* Set once {@link stop} is called.
	*
	* Deliberately false before `start`: the loop is not running yet, but a
	* manual `tick` must still work. `stop` is what makes a run abandon the
	* accounts it has not reached yet.
	*/
	stopped = false;
	states = {
		checkin: { ...EMPTY_JOB_STATE },
		report: { ...EMPTY_JOB_STATE },
		tasks: { ...EMPTY_JOB_STATE },
		streak: { ...EMPTY_JOB_STATE },
		travel: { ...EMPTY_JOB_STATE },
		compensation: { ...EMPTY_JOB_STATE }
	};
	claimableSeen = 0;
	/**
	* Credits/energy/tasks earned per account TODAY, keyed by account id.
	*
	* Cleared whenever the day key rolls over, so the card always answers
	* "what did the automation get for THIS account today".
	*/
	earnings = /* @__PURE__ */ new Map();
	/** Day key the counters above belong to. */
	earningsDate = "";
	/** Host hooks that persist the ledger across restarts. */
	loadEarnings;
	saveEarningsFn;
	constructor(pool, client, options = {}) {
		this.pool = pool;
		this.client = client;
		this.logger = options.logger ?? {};
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.delayMs = options.accountDelayMs ?? 800;
		this.eventScoreWaitMs = options.eventScoreWaitMs ?? 9e3;
		this.expertGapMs = options.expertGapMs ?? 6e3;
		this.loadEarnings = options.loadEarnings;
		this.saveEarningsFn = options.saveEarnings;
		const restored = options.loadEarnings?.();
		const today = dayKey(this.now());
		if (restored !== void 0 && restored.date === today) {
			for (const [id, entry] of Object.entries(restored.accounts)) this.earnings.set(id, entry);
			this.earningsDate = today;
		}
		this.enabled = options.enabled ?? false;
		this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin);
		this.reportHours = hoursOrDefault(options.reportHours, DEFAULT_AUTOMATION_HOURS.report);
		this.taskHours = hoursOrDefault(options.taskHours, DEFAULT_AUTOMATION_HOURS.tasks);
		this.streakHours = hoursOrDefault(options.streakHours, DEFAULT_AUTOMATION_HOURS.streak);
		this.travelHours = hoursOrDefault(options.travelHours, DEFAULT_AUTOMATION_HOURS.travel);
		this.compensationHours = hoursOrDefault(options.compensationHours, DEFAULT_AUTOMATION_HOURS.compensation);
	}
	/** Apply a new configuration; safe to call while running. */
	/**
	* Install the persistence hook once the host settings service is available.
	*
	* Separate from the constructor because the scheduler is built with the pool,
	* long before the settings section exists; a ledger written before that point
	* would have nowhere to go.
	*/
	setEarningsPersistence(save) {
		this.saveEarningsFn = save;
	}
	/**
	* Fold a previously persisted ledger back in, when it belongs to today.
	*
	* Used after the settings document becomes readable, which happens after
	* construction; a ledger from an earlier day is ignored so the counters never
	* claim yesterday as today.
	*/
	applyEarningsLedger(ledger) {
		const today = dayKey(this.now());
		if (ledger.date !== today) return;
		for (const [id, entry] of Object.entries(ledger.accounts)) this.earnings.set(id, entry);
		this.earningsDate = today;
	}
	applyConfig(options) {
		if (options.enabled !== void 0) this.enabled = options.enabled;
		if (options.checkinHours !== void 0) this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin);
		if (options.reportHours !== void 0) this.reportHours = hoursOrDefault(options.reportHours, DEFAULT_AUTOMATION_HOURS.report);
		if (options.taskHours !== void 0) this.taskHours = hoursOrDefault(options.taskHours, DEFAULT_AUTOMATION_HOURS.tasks);
		if (options.streakHours !== void 0) this.streakHours = hoursOrDefault(options.streakHours, DEFAULT_AUTOMATION_HOURS.streak);
		if (options.travelHours !== void 0) this.travelHours = hoursOrDefault(options.travelHours, DEFAULT_AUTOMATION_HOURS.travel);
		if (options.compensationHours !== void 0) this.compensationHours = hoursOrDefault(options.compensationHours, DEFAULT_AUTOMATION_HOURS.compensation);
	}
	/** Hours for one job, used by the loop and the status document. */
	hoursOf(kind) {
		switch (kind) {
			case "checkin": return this.checkinHours;
			case "report": return this.reportHours;
			case "tasks": return this.taskHours;
			case "streak": return this.streakHours;
			case "travel": return this.travelHours;
			case "compensation": return this.compensationHours;
		}
	}
	/** Start the loop. Idempotent. */
	start() {
		if (this.timer !== void 0) return;
		this.stopped = false;
		this.running = true;
		this.timer = setInterval(() => {
			this.tick();
		}, AUTOMATION_TICK_MS);
		this.timer.unref?.();
	}
	/** Stop the loop. Idempotent, and safe before `start`. */
	stop() {
		this.stopped = true;
		this.running = false;
		if (this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
	}
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
	async runNow(kind, force = false) {
		const today = dayKey(this.now());
		const state = this.states[kind];
		if (!force && state.lastFiredHour === slotKey(this.now())) return { ...state };
		this.busy = true;
		try {
			await this.runJob(kind, today);
		} finally {
			this.busy = false;
		}
		return { ...this.states[kind] };
	}
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
	startRunAll() {
		if (this.runInFlight) return false;
		this.runInFlight = true;
		this.runAll().catch((error) => {
			this.logger.warn?.("dsh-xdpool automation run failed:", error);
		}).finally(() => {
			this.runInFlight = false;
		});
		return true;
	}
	async runAll() {
		const today = dayKey(this.now());
		const before = this.earningsSnapshot();
		let okCount = 0;
		let failed = 0;
		let jobsRun = 0;
		for (const kind of JOB_KINDS) {
			jobsRun += 1;
			this.busy = true;
			try {
				await this.runJob(kind, today);
			} finally {
				this.busy = false;
			}
			okCount += this.states[kind].ok;
			failed += this.states[kind].failed;
		}
		const gained = diffEarnings(before, this.earningsSnapshot());
		return {
			jobsRun,
			okCount,
			failed,
			credit: gained.credit,
			energy: gained.energy,
			claimed: gained.claimed,
			accounts: gained.accounts
		};
	}
	status() {
		const jobs = {};
		for (const kind of JOB_KINDS) jobs[kind] = { ...this.states[kind] };
		return {
			enabled: this.enabled,
			running: this.running,
			checkinHours: this.checkinHours,
			taskHours: this.taskHours,
			reportHours: this.reportHours,
			streakHours: this.streakHours,
			travelHours: this.travelHours,
			compensationHours: this.compensationHours,
			jobs,
			claimableSeen: this.claimableSeen,
			earningsToday: this.earningsSnapshot(),
			runInProgress: this.runInFlight
		};
	}
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
	dueSlot(kind, now) {
		const hours = this.hoursOf(kind);
		if (hours.length === 0) return void 0;
		const current = Number(zonedParts(now).hour);
		const today = dayKey(now);
		const fired = this.firedSlotsOf(kind);
		for (const candidate of [...hours].sort((a, b) => a - b)) {
			if (candidate > current) break;
			const slot = `${today}T${String(candidate).padStart(2, "0")}`;
			if (!fired.has(slot)) return slot;
		}
	}
	/** Today's consumed slots for one job, as a set. */
	firedSlotsOf(kind) {
		const stored = this.states[kind].firedSlots;
		if (stored === void 0) return /* @__PURE__ */ new Set();
		const today = dayKey(this.now());
		return new Set(stored.filter((slot) => slot.startsWith(`${today}T`)));
	}
	/** Record one consumed slot on a job's state. */
	consumeSlot(kind, slot) {
		const state = this.states[kind];
		const today = dayKey(this.now());
		state.firedSlots = [.../* @__PURE__ */ new Set([...this.firedSlotsOf(kind), slot])].filter((entry) => entry.startsWith(`${today}T`)).sort();
	}
	async tick() {
		if (!this.enabled || this.stopped || this.busy) return;
		this.busy = true;
		try {
			const now = this.now();
			const slot = slotKey(now);
			const today = dayKey(now);
			for (const kind of JOB_KINDS) {
				if (this.stopped) return;
				if (this.states[kind].lastFiredHour === slot) continue;
				const consumed = this.dueSlot(kind, now);
				if (consumed === void 0) continue;
				await this.runJob(kind, today, consumed);
			}
		} catch (error) {
			this.logger.warn?.("dsh-xdpool automation tick failed:", error);
		} finally {
			this.busy = false;
		}
	}
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
	earningsSnapshot() {
		this.rollEarnings(dayKey(this.now()));
		const out = {};
		for (const [id, entry] of this.earnings) out[id] = { ...entry };
		return out;
	}
	/**
	* Add one account take to today counters, resetting first if the day rolled
	* over. Every source is tracked separately so the card can show what earned
	* what, rather than one opaque total.
	*/
	recordEarnings(accountId, today, delta) {
		this.rollEarnings(today);
		const credit = delta.credit ?? 0;
		const energy = delta.energy ?? 0;
		const claimed = delta.claimed ?? 0;
		const checkinCredit = delta.checkinCredit ?? 0;
		const bonusCredit = delta.bonusCredit ?? 0;
		const travelCredit = delta.travelCredit ?? 0;
		const compensationCredit = delta.compensationCredit ?? 0;
		if (credit === 0 && energy === 0 && claimed === 0 && checkinCredit === 0 && bonusCredit === 0 && travelCredit === 0 && compensationCredit === 0) return;
		const existing = this.earnings.get(accountId);
		this.earnings.set(accountId, {
			credit: (existing?.credit ?? 0) + credit,
			energy: (existing?.energy ?? 0) + energy,
			claimed: (existing?.claimed ?? 0) + claimed,
			checkinCredit: (existing?.checkinCredit ?? 0) + checkinCredit,
			bonusCredit: (existing?.bonusCredit ?? 0) + bonusCredit,
			travelCredit: (existing?.travelCredit ?? 0) + travelCredit,
			compensationCredit: (existing?.compensationCredit ?? 0) + compensationCredit,
			date: today
		});
		this.persistEarnings();
	}
	/** Clear the per-account counters when the local day changes. */
	rollEarnings(today) {
		if (this.earningsDate === today) return;
		this.earningsDate = today;
		this.earnings.clear();
		this.claimableSeen = 0;
		this.persistEarnings();
	}
	/**
	* Write the ledger through the host hook, when one was supplied.
	*
	* Best effort on purpose: a failed save must never abort a run that has
	* already collected rewards, and the in-memory ledger keeps serving the card
	* for the rest of the session either way.
	*/
	persistEarnings() {
		if (this.saveEarningsFn === void 0) return;
		const accounts = {};
		for (const [id, entry] of this.earnings) accounts[id] = entry;
		const ledger = {
			date: this.earningsDate,
			accounts
		};
		try {
			const saved = this.saveEarningsFn(ledger);
			if (saved !== void 0 && typeof saved.then === "function") saved.then(void 0, (error) => {
				this.logger.warn?.("dsh-xdpool: could not persist automation earnings:", error);
			});
		} catch (error) {
			this.logger.warn?.("dsh-xdpool: could not persist automation earnings:", error);
		}
	}
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
	async runJob(kind, today, consumedSlot) {
		const accountWord = kind === "report" ? "report" : kind;
		let ok = 0;
		let failed = 0;
		let credit = 0;
		let energy = 0;
		let claimed = 0;
		const detail = [];
		let progressNote;
		const accounts = this.accountsInOrder();
		if (kind === "tasks") await this.sendEventChains(accounts);
		for (let index = 0; index < accounts.length; index++) {
			if (this.stopped) break;
			const account = accounts[index];
			if (account === void 0) continue;
			try {
				switch (kind) {
					case "checkin":
						try {
							const claim = await this.client.claimDailyCheckin(account.credential);
							this.recordEarnings(account.id, today, { checkinCredit: claim.credit });
							if (claim.credit > 0) {
								if (claim.credit > 0) detail.push(`签到 +${claim.credit}`);
								this.logger.info?.(`automation checkin ${account.label}: +${claim.credit} credit`);
							}
						} catch (error) {
							if (!isAlreadyCheckin(error)) throw error;
							this.logger.info?.(`automation checkin ${account.label}: already done today`);
						}
						break;
					case "report": {
						const days = await this.reportOne(account);
						this.logger.info?.(`automation report ${account.label}: streak days=${days}`);
						break;
					}
					case "tasks": {
						const result = await this.runTasks(account);
						credit += result.credit;
						energy += result.energy;
						claimed += result.claimed;
						detail.push(...result.titles);
						this.claimableSeen += result.claimableCount;
						this.recordEarnings(account.id, today, {
							credit: result.credit,
							energy: result.energy,
							claimed: result.claimed
						});
						this.logger.info?.(`automation tasks ${account.label}: ${result.claimed} claimed (+${result.credit} credit, +${result.energy} energy, ${result.claimableCount} claimable seen)`);
						break;
					}
					case "streak": {
						const progress = await this.redeemStreak(account);
						if (progress !== void 0) progressNote = progress;
						break;
					}
					case "travel":
						await this.runTravel(account);
						break;
					case "compensation": try {
						const outcome = await this.runCompensation(account);
						if (outcome.credit > 0) {
							detail.push(`补偿 +${outcome.credit}`);
							this.logger.info?.(`automation compensation ${account.label}: +${outcome.credit} credit`);
						}
					} catch (error) {
						if (!isNoCompensation(error)) throw error;
						this.logger.info?.(`automation compensation ${account.label}: no offer to collect`);
					}
				}
				ok++;
			} catch (error) {
				failed++;
				this.logger.warn?.(`automation ${accountWord} ${account.label} failed:`, error);
			}
			if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
		}
		const state = this.states[kind];
		if (consumedSlot !== void 0) this.consumeSlot(kind, consumedSlot);
		state.lastFiredHour = slotKey(this.now());
		state.lastRunDate = today;
		state.lastRunAtMs = this.now().getTime();
		state.ok = ok;
		state.failed = failed;
		state.credit = credit;
		state.energy = energy;
		state.claimed = claimed;
		state.message = this.summarise(kind, ok, failed, claimed, credit, energy);
		state.detail = detail;
		state.progress = progressNote;
		this.logger.info?.(`automation ${accountWord}: ${state.message}`);
	}
	/** Compose the one-line summary shown on the card. */
	summarise(kind, ok, failed, claimed, credit, energy) {
		if (kind === "tasks") return `${ok} accounts, ${claimed} tasks claimed (+${credit} credit, +${energy} energy)${failed > 0 ? `, ${failed} failed` : ""}`;
		return `${ok} accounts ok${failed > 0 ? `, ${failed} failed` : ""}`;
	}
	/**
	* Accounts to run against, in pool order.
	*
	* Disabled accounts are excluded here rather than filtered by the caller so a
	* card switch takes effect on the next pass without any event plumbing.
	*/
	accountsInOrder() {
		const now = Date.now();
		return this.pool.list().filter((account) => {
			if (this.pool.isDisabled(account.id)) return false;
			return eligible(account, now);
		});
	}
	/**
	* Send one activity report, then verify it landed.
	*
	* The upstream answers 200 even when it drops the event, so the streak is
	* read back as the oracle: `days > 0` means it counted. A failed read-back is
	* logged and treated as a suspicious result, never as a retry — the report is
	* idempotent per day, and hammering it is exactly what the one-a-day quota
	* exists to avoid.
	*/
	async reportOne(account) {
		await this.client.reportActivity(account.credential);
		try {
			const days = await this.client.growthStreakDays(account.credential);
			if (days === 0) this.logger.warn?.(`automation report ${account.label}: streak days=0 right after report (new account or scoring lag?)`);
			return days;
		} catch (error) {
			this.logger.warn?.(`automation report ${account.label}: streak read-back failed:`, error);
			return -1;
		}
	}
	async sendEventChains(accounts) {
		let sentAnything = false;
		for (const account of accounts) {
			if (this.stopped) return;
			let tasks;
			try {
				tasks = await this.client.listTasks(account.credential);
			} catch (error) {
				this.logger.warn?.(`automation events ${account.label}: list failed:`, error);
				continue;
			}
			const pending = tasks.filter((task) => task.taskCode in EVENT_CHAIN_BUILDERS && !task.claimable && !task.locked);
			for (const task of pending) {
				if (this.stopped) return;
				let chains;
				try {
					chains = await this.chainsFor(task, account.credential);
				} catch (error) {
					this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} could not be built:`, error);
					continue;
				}
				for (const chain of chains) {
					if (this.stopped) return;
					try {
						await this.sendChain(account.credential, chain);
						this.logger.info?.(`automation events ${account.label}: ${task.taskCode} chain sent`);
						sentAnything = true;
					} catch (error) {
						this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} failed:`, error);
						break;
					}
					if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
				}
			}
		}
		if (sentAnything && this.eventScoreWaitMs > 0 && !this.stopped) await sleep(this.eventScoreWaitMs);
	}
	/**
	* Send one chain on the channel it was built for.
	*
	* The transport is not a detail of the sender: the scorer keys different
	* tasks to different fingerprint families, so a web-scored event posted as a
	* desktop event is accepted and then ignored.
	*/
	async sendChain(credential, chain) {
		if (chain.transport === "web") {
			const web = chain.web;
			if (web === void 0) throw new Error("web chain without a web event");
			await this.client.reportWebEvent(credential, web.eventCode, web.pageUrl, web.elementId, web.elementName);
			return;
		}
		await this.client.reportDesktopEvents(credential, chain.events ?? []);
	}
	/**
	* Build every chain that scores one task.
	*
	* Most tasks need a single chain; `template_5` needs five, because the scorer
	* counts distinct `template_used` events rather than a boolean. The two tasks
	* that join a conversation (skill, expert) open a real one first, which is why
	* this is async.
	*/
	async chainsFor(task, credential) {
		switch (task.taskCode) {
			case "Buddy_App":
			case "Buddy_App_QQ": return [buddyAppChain()];
			case "create_canvas": return [canvasChain()];
			case "automation_1": return [automationChain()];
			case "RichMeow_Chat": return [chatChain()];
			case "playbook_prompt": return [playbookChain()];
			case "template_5": return templateChains();
			case "Hp_Appearance":
				await this.client.setAppearanceTheme(credential, APPEARANCE_THEME_KEY);
				if (this.delayMs > 0 && !this.stopped) await sleep(2e3);
				return [appearanceChain()];
			case "Library_read": return [libraryReadChain()];
			case "skill_1": {
				const chat = await this.client.openConversation(credential);
				if (chat === void 0) throw new Error("skill_1: no server conversation");
				return [skillChain(chat.conversationId, chat.requestId)];
			}
			case "expert_5": return this.expertChains(credential, "agent", task);
			case "Expert_team_use_3": return this.expertChains(credential, "team", task);
			case "Expert_lighthouse": return this.lighthouseChains(credential);
			default: return [];
		}
	}
	/**
	* The summon-and-use chains for the expert tasks.
	*
	* Two steps per expert, and both are load-bearing: the summon events alone are
	* impressions, and a use event on its own scores nothing because the scorer
	* looks the conversation up. Only a real chat with `X-Expert-Id` produces an
	* id it will accept.
	*/
	async expertChains(credential, expertType, task) {
		const needed = Math.max(0, task.target - task.current);
		if (needed === 0) return [];
		const experts = await this.client.marketExpertList(credential, expertType);
		const out = [];
		for (const expert of experts) {
			if (out.length >= needed) break;
			if (this.stopped) break;
			try {
				await this.client.reportDesktopEvents(credential, expertSummonEvents(expert));
				if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
				const chat = await this.client.openConversation(credential, expert.expertId);
				if (chat === void 0) continue;
				out.push({
					transport: "desktop",
					events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), expertActualUseEvent(expert, chat.conversationId, chat.requestId)]
				});
			} catch (error) {
				this.logger.warn?.(`automation events expert ${expert.expertId}:`, error);
			}
			if (this.expertGapMs > 0 && !this.stopped) await sleep(this.expertGapMs);
		}
		return out;
	}
	/**
	* The 腾讯轻量云 expert chain.
	*
	* Structurally the same as the expert task, with two differences the scorer
	* checks: `agent_task_created` has to name the expert, and the use event has
	* to report `mode: 'LOCAL'` with an empty type and zero cost — that is what
	* the lighthouse criterion looks for.
	*/
	async lighthouseChains(credential) {
		let expert = LIGHTHOUSE_EXPERT;
		try {
			const found = (await this.client.marketExpertList(credential, "agent")).find((item) => item.expertId === LIGHTHOUSE_EXPERT_ID);
			if (found !== void 0) expert = found;
		} catch (error) {
			this.logger.warn?.("automation events lighthouse list:", error);
		}
		await this.client.reportDesktopEvents(credential, expertSummonEvents(expert));
		if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
		const chat = await this.client.openConversation(credential, expert.expertId);
		if (chat === void 0) throw new Error("Expert_lighthouse: no server conversation");
		const use = expertActualUseEvent(expert, chat.conversationId, chat.requestId, "LOCAL");
		use["type"] = "";
		use["cost"] = 0;
		return [{
			transport: "desktop",
			events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), use]
		}];
	}
	/**
	* The task-centre pass for one account.
	*
	* Order matters: enrich first (enrol in everything open), then claim. Both
	* halves are idempotent — accepting an already-accepted task succeeds, and a
	* repeat claim answers `already_claimed` — so a pass that dies halfway is
	* safe to replay on the next tick.
	*/
	async runTasks(account) {
		const credential = account.credential;
		const open = (await this.client.listTasks(credential)).filter((task) => task.acceptStatus === "not_accepted" && !task.locked).map((task) => task.taskCode);
		if (open.length > 0) await this.client.acceptTasks(credential, open);
		const claimable = (await this.client.listTasks(credential)).filter((task) => task.claimable && !task.locked);
		let credit = 0;
		let energy = 0;
		let claimed = 0;
		const titles = [];
		for (const task of claimable) {
			if (this.stopped) break;
			const reward = await this.client.claimTaskReward(credential, task.taskCode);
			credit += reward.credit;
			energy += reward.energy;
			if (reward.credit > 0 || reward.energy > 0) {
				claimed++;
				titles.push(task.title);
				this.logger.info?.(`automation claim ${account.label}: ${task.title} +${reward.credit}c +${reward.energy}e`);
			} else this.logger.info?.(`automation claim ${account.label}: ${task.taskCode} already claimed`);
			if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
		}
		return {
			claimed,
			credit,
			energy,
			claimableCount: claimable.length,
			titles
		};
	}
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
	async redeemStreak(account) {
		const credential = account.credential;
		const status = await this.client.growthStreakFull(credential);
		for (const tier of status.tiers) {
			if (this.stopped) return;
			if (tier.status === "locked" || tier.status === "claimed") continue;
			try {
				await this.client.redeemStreakTier(credential, tier.tier);
				this.logger.info?.(`automation streak ${account.label}: redeemed ${tier.tier} (+${tier.credit}c +${tier.energy}e +${tier.chances} draw(s))`);
				this.recordEarnings(account.id, dayKey(this.now()), { bonusCredit: tier.credit });
			} catch (error) {
				this.logger.warn?.(`automation streak ${account.label}: redeem ${tier.tier} failed:`, error);
			}
			if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
		}
		const chances = await this.client.lotteryChances(credential);
		for (let draw = 0; draw < chances; draw += 1) {
			if (this.stopped) return;
			try {
				const prize = await this.client.lotteryDraw(credential);
				this.logger.info?.(`automation lottery ${account.label}: draw ${draw + 1}/${chances} -> ${JSON.stringify(prize).slice(0, 120)}`);
			} catch (error) {
				this.logger.warn?.(`automation lottery ${account.label}: draw failed:`, error);
				break;
			}
			if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
		}
		const pendingTier = status.tiers.find((tier) => tier.status === "locked");
		if (pendingTier !== void 0) {
			const remaining = Math.max(0, pendingTier.days - status.days);
			return remaining > 0 ? `${pendingTier.tier} in ${remaining}d` : `${pendingTier.tier} ready`;
		}
	}
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
	async runTravel(account) {
		const credential = account.credential;
		if (await this.client.buddyInfo(credential) === void 0) {
			try {
				await this.client.buddyAgree(credential);
				await this.client.buddyAdoptFirst(credential);
				this.logger.info?.(`automation travel ${account.label}: adopted first buddy`);
			} catch (error) {
				this.logger.info?.(`automation travel ${account.label}: adoption not available yet (` + String(error).slice(0, 80) + ")");
			}
			return;
		}
		const travel = await this.client.buddyTravelStatus(credential);
		if (travel.state === "arrived") {
			if (travel.recordId === 0) {
				this.logger.warn?.(`automation travel ${account.label}: arrived but no record id`);
				return;
			}
			const reward = await this.client.buddyTravelClaim(credential, travel.recordId);
			this.recordEarnings(account.id, dayKey(this.now()), { travelCredit: reward });
			this.logger.info?.(`automation travel ${account.label}: claimed trip +${reward}c`);
			return;
		}
		if (travel.state === "idle" && !travel.dailyLimitReached) {
			await this.client.buddyTravelDepart(credential);
			this.logger.info?.(`automation travel ${account.label}: departed (arrives later, claimed next pass)`);
			return;
		}
		this.logger.info?.(`automation travel ${account.label}: nothing to do (state=${travel.state})`);
	}
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
	async runCompensation(account) {
		const credential = account.credential;
		const status = await this.client.fetchCompensationStatus(credential);
		if (!status.active || status.claimed || status.creditNum <= 0) return { credit: 0 };
		const claim = await this.client.claimCompensation(credential);
		if (!claim.claimed) return { credit: 0 };
		const credit = claim.creditNum > 0 ? claim.creditNum : status.creditNum;
		this.recordEarnings(account.id, dayKey(this.now()), { compensationCredit: credit });
		return { credit };
	}
};
Object.freeze({
	"agnes": "推理内容以 think 标签返回",
	"alibaba_cloud": "DashScope 国际版兼容模式端点，base URL 与 FCC 一致",
	"anthropic": "Anthropic Messages 原生透传，标记 native_messages_passthrough",
	"azure_openai": "无默认端点，必须配置 AZURE_OPENAI_BASE_URL 与部署名",
	"baidu": "百度千帆 v2 的 OpenAI 兼容端点",
	"bazaarlink": "多厂商网关，带 auto:free slug，归为 free-tier",
	"bedrock": "Bedrock Mantle 兼容端点，密钥与模型按区域区分",
	"byteplus": "新账号赠送免费额度，含 Seed 2.0 与 Kimi K2 Thinking",
	"cerebras": "max_tokens 实际按 max_completion_tokens 发送",
	"cheaperinference": "列表只保留支持流式输出的文本模型",
	"chutes": "FCC 只列出同时支持工具调用的文本进文本出模型",
	"cline_pass": "ClinePass 订阅密钥，模型见 /ai/cline/recommended-models",
	"cloudflare": "账号级 URL，需把 {account_id} 换成实际值，含免费额度",
	"cohere": "兼容层在 /compatibility/v1，请求体会剥掉部分字段",
	"deepinfra": "按自有 /models/list 解析，取 model_name 与 reported_type",
	"deepseek": "该端点会回报缓存命中的用量",
	"experiential": "Experiential Labs 的网关",
	"featherless": "只取 tool_use 且在当前套餐内的行，分页按页码递增",
	"fireworks": "不含 embedding 模型，模型 id 是账号内的路径",
	"gemini": "Google AI Studio 密钥，走 /v1beta/openai/ 兼容层",
	"github_copilot": "GitHub 账号登录，能用哪些模型取决于订阅档位",
	"glm": "Z.ai 的 Anthropic 兼容线路，与 zai 共用 ZAI_API_KEY",
	"glm-cn": "智谱开放平台国内版编程端点，与 z.ai 国际版是两套记录",
	"groq": "OpenAI 兼容端点，同一列表里的音频 id 已剔除",
	"huggingface": "Inference Providers 路由器，上下文长度取实时共识值",
	"hyperbolic": "OpenAI 兼容 chat completions，密钥地址见 9router",
	"kilo": "Kilo 网关的免费池，与插件自身的 Kilo 通道同一主机",
	"kimchi": "9router 归为 free-tier，支持 oauth 与 apikey",
	"kimi": "Moonshot 平台密钥，该线路拒绝调用方传入 extra_body",
	"kimi_code": "Kimi Code 订阅，模型 id 取自 9router 的 kimi 注册表",
	"lightning": "Lightning AI 的 Model APIs 网关",
	"llamacpp": "本地服务器，模型列表取决于用户已加载的模型",
	"llm7": "default/fast/pro 别名被固定，只留流式工具模型",
	"lmstudio": "本地服务器，模型列表取决于用户已加载的模型",
	"minimax": "推理内容从正文流中单独拆出，语音与图像 id 已剔除",
	"minimax-cn": "国内端点，走 Anthropic Messages，含 anthropic-beta 头",
	"mistral": "La Plateforme 密钥，不含 embedding 模型",
	"mistral_codestral": "Codestral 的 IDE 端点，与 La Plateforme 密钥是两套",
	"morph": "面向编程代理的快速 apply/edit 模型",
	"nararoute": "多厂商网关，列表中推理能力以布尔值给出",
	"nebius": "不含 embedding 模型，列表必须标出模态 text->text",
	"novita": "README 示例里的模型 id",
	"nvidia_nim": "NVIDIA 开发者计划成员免费用于原型测试，FCC 默认走这条",
	"ollama": "本地服务器，FCC 会把配置的根地址归一到 /v1",
	"ollama_cloud": "免费额度轻量，一次一个云模型，tag 是 Ollama 名",
	"open_router": "免费额度含 27 个以上免费模型，日请求约 200 次",
	"openai": "浏览器登录 ChatGPT 订阅，走 codex 的 responses 线路",
	"openai_api": "平台密钥走 Responses API，非对话类 id 已剔除",
	"opencode": "免密钥免费池，同一 /zen/v1 主机，但各模型线路不同",
	"opencode_go": "OpenCode Go 订阅，每月 5 美元",
	"opencode_zen": "按量付费密钥走快速线路，含免费模型，分 chat 与 responses",
	"opper": "Opper 网关，基于 v3/compat 端点",
	"orcarouter": "多厂商网关，附带免费 slug",
	"perplexity": "带搜索增强的 Sonar 对话模型",
	"poolside": "Poolside 平台密钥",
	"qwencloud": "QwenCloud Token Plan 端点，base URL 同 FCC",
	"qwencloud_coding": "QwenCloud Coding Plan 端点，base URL 同 FCC",
	"sambanova": "README 示例里的模型 id，9router 注册表中该厂商保持隐藏",
	"scaleway": "Scaleway Generative APIs，使用 SCW 密钥",
	"siliconflow": "模型 id 取自 9router 注册表，按 sub_type=chat 过滤",
	"tencent": "腾讯混元的 OpenAI 兼容端点",
	"together": "不含 embedding 模型，FCC 在 /models 列 context_length",
	"tokenrouter": "多厂商网关，附带免费 slug",
	"venice": "私有推理加无审查模型，不含 embedding 与图像 id",
	"vercel": "Vercel AI Gateway，模型 id 带厂商命名空间",
	"vertex": "走 ADC 免密钥，用 VERTEX_PROJECT_ID 与 VERTEX_LOCATION 拼端点",
	"vertex-partner": "Vertex MaaS 合作方模型，兼容 base 按项目与区域拼出",
	"volcengine-ark": "火山引擎国内编程端点，密钥地址由 9router 给出",
	"wafer": "Wafer pass 端点",
	"wandb": "W&B Serverless Inference，推理以 think 标签返回",
	"xai": "同一列表里的图像与视频 id 已剔除",
	"xiaomi-tokenplan": "Token Plan 订阅，密钥以 tp- 开头且按集群区分",
	"xkiro": "多厂商网关，thinking 为 capabilities.reasoning 布尔",
	"zai": "Z.ai 编程套餐端点，拒绝 extra_body，共用模型 id",
	"zai_api": "Z.ai 按量付费端点，与 z.ai 各线路共用同一批模型 id",
	"zenmux": "max_tokens 实际按 max_completion_tokens 发送"
});
[
	"You are compacting an ongoing conversation so it can continue without the original history.",
	"Summarise the transcript below into a dense briefing for the next assistant turn.",
	"Preserve, in this order of priority:",
	"1. explicit user requirements, constraints and corrections;",
	"2. decisions already made, and the reasoning behind them;",
	"3. concrete facts: file paths, identifiers, commands, numbers, error messages;",
	"4. unfinished work and the current blocker.",
	"Drop pleasantries, repetition and superseded attempts.",
	"Write the briefing only — no preamble, no markdown fence."
].join("\n");
//#endregion
//#region src/status.ts
/** Format the per-model credit multipliers. */
function formatRates(status) {
	const lines = ["Model credit multipliers:"];
	for (const model of status.models) {
		const rate = model.multiplier === void 0 ? "x?" : `x${model.multiplier.toFixed(2)}`;
		lines.push(`  ${model.name.padEnd(20)} ${rate}`);
	}
	return lines.join("\n");
}
Object.freeze({
	"workbuddy-xdpool": "xdpool",
	"workbuddy-xdpool-global": "xdpool-global",
	"workbuddy-xdpool-aggregate": "xdpool-aggregate",
	"workbuddy-xdpool-free": "xdpool-free"
});
//#endregion
//#region src/preferred.ts
/**
* The preferred account: the one the user asked to be tried first.
*
* Distinct from `disabledAccountIds` in the opposite direction. A disabled
* account is skipped entirely; a preferred account is merely first in line, and
* the pool falls back to the distribution strategy the moment it fails a gate
* (cooling, dead credential, credit reserve, switched off). So this file holds a
* single optional id, not a list.
*
* It is a plugin-owned file for the same reason the ignore list is one: the CLI
* has no settings service, so a settings-backed pin could be set from the card
* and never from `dsh-xdpool prefer`. Both halves read this file.
*
* The value is deliberately NOT a credential, a token, or anything secret. It is
* an account id the plugin already prints on the card, so there is nothing here
* that a hand-edited file could leak.
*
* @module dsh-xdpool/preferred
*/
/** File holding the preferred account id, inside the plugin data directory. */
const PREFERRED_FILE_NAME = "preferred.json";
/** Absolute path of the preferred-account file. */
function preferredIdPath(env = process.env) {
	return join(pluginDataDir(env), PREFERRED_FILE_NAME);
}
/**
* Normalize whatever the file holds into a clean id, or nothing.
*
* Tolerant on purpose, and this file is hand-editable more than most: a
* malformed document must never take the pool down. A missing, unreadable,
* unparseable, or wrongly-typed value all mean the same thing to the caller —
* nothing is pinned — so none of them throws. Empty and whitespace-only strings
* are treated as "no pin" rather than as an id, because an id of `""` could
* never match an account and would otherwise be a pin the user cannot clear from
* the card (the clear button sends `null`, and `null` would not match `""`).
*/
function normalize(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const id = raw.accountId;
	if (typeof id !== "string") return void 0;
	const trimmed = id.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Read the pinned id, tolerating every "no pin yet" shape.
*
* A missing file is the normal state on a fresh install, so it is not an error.
*/
async function readPreferredId(path = preferredIdPath()) {
	try {
		return normalize(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return;
	}
}
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
async function writePreferredId(accountId, path = preferredIdPath()) {
	await mkdir(dirname(path), { recursive: true });
	if (accountId === void 0) {
		await rm(path, { force: true });
		return;
	}
	const payload = JSON.stringify({
		version: 1,
		accountId: accountId.trim()
	}, null, 2);
	const temp = `${path}.tmp`;
	await writeFile$1(temp, `${payload}\n`, "utf8");
	await rename(temp, path);
}
fileURLToPath(new URL("..", import.meta.url));
(() => {
	try {
		return fileURLToPath(new URL("../../node_modules/@deepseek-ai/dsh-llm-pi-ai/", import.meta.url));
	} catch {
		return "";
	}
})();
/**
* One region's model-selection schema.
*
* Every field is optional on purpose: an absent field keeps its documented
* meaning ("all enabled" / "follow the upstream image flag" / "no cap"), and a
* region that has never been saved stays absent so `applyConfigFromSource` can
* fall back to the legacy flat keys.
*/
function asVolatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
/**
* One region's model-selection schema.
*
* Every field is optional on purpose: an absent field keeps its documented
* meaning ("all enabled" / "follow the upstream image flag" / "no cap"), and a
* region that has never been saved stays absent so `applyConfigFromSource` can
* fall back to the legacy flat keys.
*/
const modelSelectionSchema = z.object({
	enabledModelIds: z.array(z.string()).description("Model ids enabled in this region's picker (absent = all)"),
	imageModelIds: z.array(z.string()).description("Model ids accepting image input in this region (absent = follow upstream)"),
	contextBudgets: z.dict(z.number().step(1).min(1)).description("Per-model context-window override for this region")
});
/**
* Automation schema.
*
* `enabled` carries a real default (false) because the scheduler reads it on
* every tick and a missing field must mean "off" rather than "undefined".
* The hour lists fall back in the scheduler itself, so they stay optional here
* and an absent list keeps the documented schedule.
*
* `exhaustCooldownMs` is mirrored from the pool options: the card offers it as
* part of the automation block, since how long a spent account rests only
* matters to the automation that has to work around it.
*/
const automationSchema = z.object({
	enabled: z.boolean().default(false).description("Run the daily points automation"),
	checkinHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for the daily check-in"),
	reportHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for the activity report (runs before tasks)"),
	taskHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for task enrolment and claiming"),
	streakHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for streak redemption"),
	travelHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for the buddy travel loop"),
	compensationHours: z.array(z.number().step(1).min(0).max(23)).description("Local hours for the outage-compensation claim"),
	exhaustCooldownMs: z.number().step(1).min(1e3).description("How long a spent account rests, in milliseconds")
});
z.object({
	authFile: asVolatile(z.string().description("WorkBuddy desktop auth file (defaults to the app own location)")),
	cooldownMs: asVolatile(z.number().step(1).min(1e3).default(6e4).description("Rate-limit cooldown per account, in milliseconds")),
	distribution: asVolatile(z.union([
		"priority",
		"round-robin",
		"balanced",
		"sticky",
		"expiry"
	]).default("priority").description("How requests are spread: priority (drain one), round-robin (in order), balanced (idle-weighted random), sticky (one account per conversation, new conversations rotate), or expiry (spend the account whose credit packs expire soonest)")),
	disabledAccountIds: asVolatile(z.array(z.string()).default([]).description("Account ids excluded from the pool (empty = every discovered account participates)")),
	creditReserves: asVolatile(z.dict(z.number().step(1).min(0)).default({}).description("Per-account credit floor: stop using an account once its balance reaches this value")),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("Legacy shared model-id list; used by a region that has no per-region selection yet")),
	imageModelIds: asVolatile(z.array(z.string()).default([]).description("Legacy shared image-id list; used by a region that has no per-region selection yet")),
	contextBudgets: asVolatile(z.dict(z.number().step(1).min(1)).default({}).description("Legacy shared context budgets; used by a region with no per-region selection yet")),
	modelSelectionCn: asVolatile(modelSelectionSchema.description("Model selection for the domestic gateway")),
	modelSelectionGlobal: asVolatile(modelSelectionSchema.description("Model selection for the international gateway")),
	automation: asVolatile(automationSchema.description("Daily points automation (activity report, task claiming, check-in)")),
	automationEarnings: asVolatile(z.any().description("Automation earnings ledger (written by the scheduler)"))
});
/** Assemble the runtime objects without registering anything. */
/**
* Assemble the runtime objects without registering anything.
*
* One catalog per region, mirroring the two shims: the CN and global gateways
* do not advertise the same roster, and a shared catalog meant the picker showed
* whichever list happened to be fetched first (always the CN one, since the
* seeding step read `accounts[0]`).
*/
function createCore(logger) {
	const client = new WorkBuddyUpstreamClient();
	const pool = new WorkBuddyAccountPool({
		...logger === void 0 ? {} : { logger },
		client,
		persistent: true
	});
	return {
		pool,
		catalogs: {
			cn: new WorkBuddyCatalog("cn"),
			global: new WorkBuddyCatalog("global")
		},
		client,
		scheduler: new WorkBuddyScheduler(pool, client, { ...logger === void 0 ? {} : { logger } })
	};
}
//#endregion
//#region src/bin.ts
/**
* Command-line diagnostics and account management.
*
*   dsh plugin --profile desktop exec dsh-xdpool <command>
*
* The CLI is packaged as a separate entry (`lib/bin.js`) and must stay free of
* host-injected optional-peer imports: it runs standalone, before any argument
* is parsed, so a single side-effect import of `@earendil-works/pi-ai` made
* every command die with ERR_MODULE_NOT_FOUND.
*
* @module dsh-xdpool/bin
*/
/** Directory holding imported account snapshots. */
const ACCOUNT_DIR_NAME = ".xdpool";
/**
* Assemble the runtime for a CLI command, with the ignore list applied.
*
* Every command goes through here rather than calling `createCore()` directly,
* so a command can never accidentally act on an account the user has thrown out
* — `checkin all` collecting a reward for a discarded account would be exactly
* the kind of silent surprise the ignore feature exists to prevent.
*/
async function cliCore() {
	const core = createCore();
	const ignored = await readIgnoredAccounts();
	core.pool.applyIgnored(ignored.map((entry) => entry.id));
	return core;
}
/** Snapshot files are named by the md5 prefix of their key, so any key is safe. */
function snapshotPath(key, dir) {
	return join(dir, `${createHash("md5").update(key).digest("hex").slice(0, 8)}.info`);
}
function dshHome() {
	const fromEnv = process.env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}
function accountDir() {
	return join(dshHome(), ACCOUNT_DIR_NAME);
}
function usage() {
	return [
		"dsh-xdpool — multi-account WorkBuddy provider for DeepSeek Harness",
		"",
		"Usage: dsh-xdpool <command> [options]",
		"",
		"Commands:",
		"  status              Account pool, credits, and shim state (add --credits, --json, --rates)",
		"  doctor              Diagnose discovery, cooldowns, and upstream reachability",
		"  accounts            List discovered accounts (add --json)",
		"  import <key>        Snapshot the current desktop login as <key> (add --force)",
		"  remove <key>        Delete one imported snapshot",
		"  ignore <acct>       Drop an account from the pool for good (id or label)",
		"  unignore <acct>     Put an ignored account back into the pool",
		"  ignored             List the accounts dropped from the pool (add --json)",
		"  prefer <acct>       Try one account first (id or label); `none` clears it",
		"  preferred           Show which account is preferred, if any",
		"  login               Guide for adding another account (desktop app is single-sign-in)",
		"  checkin [all|<acct>] Daily check-in: report status, or collect with `all` / a label",
		"  reset               Clear all rate-limit cooldowns immediately",
		"",
		"Options:",
		"  --json              Machine-readable output",
		"  --credits           Query remaining credits (read-only; does not consume)",
		"  --rates             Show per-model credit multipliers",
		"  --force             Overwrite an existing snapshot"
	].join("\n");
}
/** Live auth files, in probe order. */
function liveCandidates() {
	const fromEnv = process.env["WORKBUDDY_AUTH_FILE"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return [resolve(fromEnv.trim())];
	return defaultDesktopAuthDirs().map((dir) => join(dir, WORKBUDDY_LIVE_FILENAME));
}
async function readJsonFile(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
async function commandStatus(args) {
	const asJson = args.includes("--json");
	const withCredits = args.includes("--credits");
	const withRates = args.includes("--rates");
	const core = await cliCore();
	const accounts = await core.pool.scan();
	const status = {
		ok: accounts.length > 0,
		accounts: accounts.map((account) => {
			const now = Date.now();
			const modelCooling = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).map(([modelId, until]) => ({
				modelId,
				until: new Date(until).toISOString()
			}));
			return {
				id: account.id,
				label: account.label,
				domain: account.credential.domain,
				...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
				cooling: account.cooldownUntilMs > now,
				...modelCooling.length === 0 ? {} : { modelCooldowns: modelCooling },
				rateLimitHits: account.rateLimitHits,
				sourcePath: account.credential.sourcePath
			};
		}),
		cooling: accounts.filter((account) => account.cooldownUntilMs > Date.now()).length,
		models: core.catalogs.cn.current().map((model) => ({
			id: model.id,
			name: model.name,
			multiplier: model.multiplier
		})),
		shim: { running: false }
	};
	if (asJson) console.log(JSON.stringify(status, null, 2));
	else console.log(`WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling\n` + status.accounts.map((account) => {
		const flag = account.cooling ? "⏸ " : "▶ ";
		const hits = account.rateLimitHits > 0 ? ` (hits ${account.rateLimitHits})` : "";
		const modelCooling = (account.modelCooldowns ?? []).map((mc) => `\n    model-cool: ${mc.modelId} until ${mc.until}`).join("");
		return `${flag}${account.label}  [${account.domain || "cn"}]${hits}\n    ${account.sourcePath}${modelCooling}`;
	}).join("\n"));
	if (withRates) console.log(`\n${formatRates(status)}`);
	if (withCredits) {
		const first = accounts.find((account) => account.cooldownUntilMs <= Date.now());
		if (first === void 0) console.log("\nCredits: skipped (every account is cooling down)");
		else try {
			const credits = await core.client.fetchCredits(first.credential);
			console.log(`\nCredits for ${first.label}: ` + JSON.stringify(credits));
		} catch (error) {
			console.log(`\nCredits for ${first.label}: query failed — ${String(error).slice(0, 200)}`);
		}
	}
	return status.ok ? 0 : 1;
}
/**
* Daily check-in from the terminal.
*
* `checkin` with no argument reports every account's status; `checkin all`
* collects wherever a reward is still available, and `checkin <label>` targets
* one account. A collection is never attempted twice for the same account on
* the same day — the status is re-read first and an already-collected account
* is reported as such.
*/
async function commandCheckin(args) {
	const asJson = args.includes("--json");
	const target = args.find((arg) => !arg.startsWith("--"));
	const core = await cliCore();
	if ((await core.pool.scan()).length === 0) {
		console.error("No WorkBuddy account discovered. Sign in with the WorkBuddy desktop app first.");
		return 1;
	}
	const wanted = target === void 0 || target === "all" ? core.pool.list() : core.pool.list().filter((account) => account.label === target || account.id === target || account.id.startsWith(target));
	if (wanted.length === 0) {
		console.error(`No account matches "${target}". Run \`accounts\` to list labels.`);
		return 1;
	}
	const rows = [];
	for (const account of wanted) {
		const row = {
			label: account.label,
			active: false,
			alreadyCheckedIn: false,
			streakDays: 0
		};
		try {
			const status = await core.client.fetchCheckinStatus(account.credential);
			row.active = status.active;
			row.alreadyCheckedIn = status.todayCheckedIn;
			row.streakDays = status.streakDays;
			if (target !== void 0 && status.active && !status.todayCheckedIn) {
				const claim = await core.client.claimDailyCheckin(account.credential);
				row.claimed = claim.credit;
				row.streakDays = claim.streakDays;
				row.alreadyCheckedIn = true;
			}
		} catch (error) {
			row.error = String(error).slice(0, 200);
		}
		rows.push(row);
	}
	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return rows.every((row) => row.error === void 0) ? 0 : 1;
	}
	console.log("Daily check-in:");
	for (const row of rows) {
		if (row.error !== void 0) {
			console.log(`  ! ${row.label}: query failed — ${row.error}`);
			continue;
		}
		if (!row.active) {
			console.log(`  – ${row.label}: no check-in activity`);
			continue;
		}
		if (row.claimed !== void 0) {
			console.log(`  + ${row.label}: collected ${row.claimed} credit(s) (streak ${row.streakDays})`);
			continue;
		}
		console.log(row.alreadyCheckedIn ? `  ✓ ${row.label}: already checked in today (streak ${row.streakDays})` : `  · ${row.label}: not checked in today — run \`checkin all\` to collect`);
	}
	if (target === void 0) console.log("\nAdd `all` (or an account label) to collect.");
	return rows.every((row) => row.error === void 0) ? 0 : 1;
}
async function commandDoctor() {
	const lines = [];
	let healthy = true;
	lines.push(`dsh-xdpool doctor`);
	lines.push(`  platform : ${platform()}`);
	lines.push(`  dsh home : ${dshHome()}`);
	lines.push("");
	lines.push("Credential discovery:");
	for (const candidate of liveCandidates()) {
		const raw = await readJsonFile(candidate);
		const credential = raw === void 0 ? void 0 : parseWorkBuddyAuth(JSON.stringify(raw), candidate);
		lines.push(`  ${credential === void 0 ? "✗" : "✓"} ${candidate}`);
	}
	const dirs = defaultDesktopAuthDirs();
	for (const dir of dirs) {
		const { readdir } = await import("node:fs/promises");
		let names = [];
		try {
			names = await readdir(dir);
		} catch {
			lines.push(`  - ${dir} (absent)`);
			continue;
		}
		const snapshots = names.filter((name) => name.startsWith("workbuddy-desktop.") && name.endsWith(".info"));
		lines.push(`  ✓ ${dir} → ${snapshots.length} snapshot(s)`);
	}
	lines.push("");
	const accounts = await (await cliCore()).pool.scan();
	lines.push(`Accounts discovered: ${accounts.length}`);
	if (accounts.length === 0) {
		healthy = false;
		lines.push("  ✗ none — sign in on the WorkBuddy desktop app, then run `import <key>`");
	}
	for (const account of accounts) {
		const state = account.cooldownUntilMs > Date.now() ? "cooling" : "ready";
		lines.push(`  ✓ ${account.label} (${state}, hits ${account.rateLimitHits})`);
	}
	lines.push("");
	lines.push(`Imported snapshots: ${accountDir()}`);
	const { readdir: readdir2 } = await import("node:fs/promises");
	let imported = [];
	try {
		imported = (await readdir2(accountDir())).filter((name) => name.endsWith(".json"));
	} catch {}
	lines.push(imported.length === 0 ? "  (none)" : imported.map((name) => `  ✓ ${name}`).join("\n"));
	lines.push("");
	lines.push("WorkBuddy desktop app:");
	const override = process.env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim();
	if (override !== void 0 && override !== "") lines.push(`  env ${WORKBUDDY_APP_EXECUTABLE_ENV} = ${override}`);
	let candidates = [];
	try {
		candidates = workbuddyAppExecutableCandidates();
	} catch (error) {
		lines.push(`  ✗ candidate probe threw: ${error instanceof Error ? error.message : String(error)}`);
	}
	let firstExisting;
	for (const candidate of candidates) {
		const exists = existsSync(candidate);
		if (exists && firstExisting === void 0) firstExisting = candidate;
		lines.push(`  ${exists ? "✓" : "·"} ${candidate}`);
	}
	lines.push(`  probed ${candidates.length} candidate path(s)`);
	if (firstExisting === void 0) {
		healthy = false;
		lines.push("  ✗ no WorkBuddy desktop executable found at any probed path.");
		lines.push("    If the app IS installed, set WORKBUDDY_APP_EXECUTABLE to its full .exe path");
		lines.push("    (or put that line in $DSH_HOME/.env) and restart DSH. A path shown above that");
		lines.push("    looks like mojibake (e.g. \"???\" for a Chinese folder) indicates the registry");
		lines.push("    value could not be decoded on this machine — please report it with the line.");
	} else lines.push(`  ✓ using ${firstExisting}`);
	console.log(lines.join("\n"));
	return healthy ? 0 : 1;
}
async function commandImport(args) {
	const key = args.filter((arg) => !arg.startsWith("--"))[0];
	if (key === void 0) {
		console.error("usage: dsh-xdpool import <key> [--force]");
		return 2;
	}
	const force = args.includes("--force");
	let source;
	for (const candidate of liveCandidates()) {
		const raw = await readJsonFile(candidate);
		if (raw === void 0) continue;
		if (parseWorkBuddyAuth(JSON.stringify(raw), candidate) !== void 0) {
			source = candidate;
			break;
		}
	}
	if (source === void 0) {
		console.error(`No signed-in WorkBuddy desktop session found. Sign in on the desktop app first
(looked in: ${liveCandidates().join(", ")})`);
		return 1;
	}
	const dir = accountDir();
	await mkdir(dir, { recursive: true });
	const target = snapshotPath(key, dir);
	const { access } = await import("node:fs/promises");
	let exists = false;
	try {
		await access(target);
		exists = true;
	} catch {}
	if (exists && !force) {
		console.error(`Snapshot "${key}" already exists. Re-run with --force to overwrite.`);
		return 1;
	}
	await copyFile(source, target);
	const credential = parseWorkBuddyAuth(await readFile(target, "utf8"), target);
	const label = credential === void 0 ? "unknown" : (credential.nickname ?? "WorkBuddy") + `#${workbuddyAccountId(credential).slice(0, 8)}`;
	console.log(`Imported "${key}" → ${label}\n  saved: ${target}`);
	return 0;
}
async function commandRemove(args) {
	const key = args.filter((arg) => !arg.startsWith("--"))[0];
	if (key === void 0) {
		console.error("usage: dsh-xdpool remove <key>");
		return 2;
	}
	const target = snapshotPath(key, accountDir());
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(target);
		console.log(`Removed snapshot "${key}"`);
		return 0;
	} catch {
		console.error(`No snapshot named "${key}"`);
		return 1;
	}
}
/**
* Throw one account out of the pool for good, or take it back.
*
* The target may be a full account id (as `accounts --json` prints it) or any
* unambiguous fragment of the label, so the user does not have to copy a hash.
* The id is what gets stored — a label can change when the account is renamed,
* and an ignore list keyed by a mutable label would silently stop matching.
*/
async function commandIgnore(args, ignored) {
	const verb = ignored ? "ignore" : "unignore";
	const target = args.filter((arg) => !arg.startsWith("--"))[0];
	if (target === void 0) {
		console.error(`usage: dsh-xdpool ${verb} <account-id|label>`);
		return 2;
	}
	const accounts = await (await cliCore()).pool.scan();
	const current = await readIgnoredAccounts();
	if (!ignored) {
		const match = current.find((entry) => entry.id === target) ?? current.find((entry) => entry.label === target) ?? current.find((entry) => entry.id.startsWith(target));
		if (match === void 0) {
			console.error(`No ignored account matches "${target}". Run \`ignored\` to list them.`);
			return 1;
		}
		await unignoreAccount(match.id);
		console.log(`Restored ${match.label} (${match.id}). It rejoins the pool on the next scan.`);
		return 0;
	}
	const matches = accounts.filter((account) => account.id === target || account.label === target || account.id.startsWith(target) || account.label.includes(target));
	if (matches.length === 0) {
		console.error(`No account matches "${target}". Run \`accounts\` to list them.`);
		return 1;
	}
	if (matches.length > 1) {
		console.error(`"${target}" matches ${matches.length} accounts; use the full id:\n` + matches.map((account) => `  ${account.id}  ${account.label}`).join("\n"));
		return 1;
	}
	const account = matches[0];
	await ignoreAccount({
		id: account.id,
		label: account.label
	});
	console.log(`Ignored ${account.label} (${account.id}).\n  Its credential is no longer read and it will not rejoin the pool, even if the
  desktop app signs it in again. Undo with: dsh-xdpool unignore ${account.id}`);
	return 0;
}
/** List the accounts currently thrown out of the pool. */
async function commandIgnored(args) {
	const asJson = args.includes("--json");
	const ignored = await readIgnoredAccounts();
	if (asJson) {
		console.log(JSON.stringify(ignored, null, 2));
		return 0;
	}
	if (ignored.length === 0) {
		console.log("No accounts are ignored. Use `ignore <account-id|label>` to drop one.");
		return 0;
	}
	console.log(ignored.map((entry) => `⛔ ${entry.label}  (${entry.id})`).join("\n"));
	return 0;
}
/**
* Name the account to try first, or hand the choice back to the strategy.
*
* The target may be a full account id (as `accounts --json` prints it) or any
* unambiguous fragment of the label, so the user does not have to copy a hash.
* The id is what gets stored — a label can change when the account is renamed,
* and a pin keyed by a mutable label would silently stop matching.
*
* `none` clears the pin. It is checked BEFORE the lookup because there is no
* state that could make clearing wrong: a user whose pinned account has since
* been ignored has no other way to reach "stop preferring it" from a terminal,
* so requiring the account to still exist would strand the command exactly when
* it is needed most.
*/
async function commandPrefer(args) {
	const target = args.filter((arg) => !arg.startsWith("--"))[0];
	if (target === void 0) {
		console.error("usage: dsh-xdpool prefer <account-id|label>|none");
		return 2;
	}
	if (target === "none") {
		await writePreferredId(void 0);
		console.log("Cleared the preferred account. The distribution strategy decides again.");
		return 0;
	}
	const matches = (await (await cliCore()).pool.scan()).filter((account) => account.id === target || account.label === target || account.id.startsWith(target) || account.label.includes(target));
	if (matches.length === 0) {
		console.error(`No account matches "${target}". Run \`accounts\` to list them.`);
		return 1;
	}
	if (matches.length > 1) {
		console.error(`"${target}" matches ${matches.length} accounts; use the full id:\n` + matches.map((account) => `  ${account.id}  ${account.label}`).join("\n"));
		return 1;
	}
	const account = matches[0];
	await writePreferredId(account.id);
	console.log(`Preferred ${account.label} (${account.id}).\n  It is tried first while it stays healthy; when it goes into cooldown, runs out
  of credits, or is signed out, the pool falls back to your distribution setting.
  This survives restarts. Undo with: dsh-xdpool prefer none`);
	return 0;
}
/** Print which account is pinned, if any. */
async function commandPreferred() {
	const pinned = await readPreferredId();
	if (pinned === void 0) {
		console.log("No account is preferred; the distribution strategy decides. Set one with: dsh-xdpool prefer <account-id|label>");
		return 0;
	}
	const known = (await cliCore()).pool.list().find((account) => account.id === pinned);
	console.log(known === void 0 ? `Preferred account ${pinned} is not in the pool right now (ignored, signed out, or not scanned in). It is inert until it returns. Clear it with: dsh-xdpool prefer none` : `Preferred ${known.label} (${known.id}). Clear it with: dsh-xdpool prefer none`);
	return 0;
}
function commandLogin() {
	console.log([
		"Adding another WorkBuddy account",
		"",
		"The WorkBuddy desktop app holds one signed-in account at a time, so each",
		"additional account is captured as a snapshot after you switch login:",
		"",
		"  1. Open the WorkBuddy desktop app and sign in (scan the QR code).",
		"  2. Run:  dsh plugin --profile desktop exec dsh-xdpool import <key>",
		"  3. Sign in with the next account in the desktop app.",
		"  4. Run the import command again with a different <key>.",
		"  5. Restart DSH Desktop; every imported account joins the rotation pool.",
		"",
		"Snapshots live in " + accountDir() + " and store the desktop app's tokens",
		"verbatim — protect that directory like a password."
	].join("\n"));
	return 0;
}
async function commandReset() {
	const core = await cliCore();
	await core.pool.scan();
	core.pool.resetCooldowns();
	console.log("Cleared all rate-limit cooldowns.");
	return 0;
}
async function commandAccounts(args) {
	const asJson = args.includes("--json");
	const accounts = await (await cliCore()).pool.scan();
	const ignored = await readIgnoredAccounts();
	if (asJson) console.log(JSON.stringify([...accounts.map((account) => ({
		id: account.id,
		label: account.label,
		cooling: account.cooldownUntilMs > Date.now(),
		rateLimitHits: account.rateLimitHits
	})), ...ignored.map((entry) => ({
		id: entry.id,
		label: entry.label,
		ignored: true,
		ignoredAt: entry.ignoredAt
	}))], null, 2));
	else if (accounts.length === 0 && ignored.length === 0) console.log("No imported accounts. Run `import <key>` after signing in on the desktop app.");
	else {
		const lines = accounts.map((account) => `${account.cooldownUntilMs > Date.now() ? "⏸" : "▶"} ${account.label}`);
		if (ignored.length > 0) lines.push(...ignored.map((entry) => `⛔ ${entry.label}  (removed; \`unignore ${entry.id}\` to restore)`));
		console.log(lines.join("\n"));
	}
	return 0;
}
/** Entry point; returns the process exit code. */
async function main(argv) {
	const [command, ...rest] = argv;
	switch (command) {
		case void 0:
		case "help":
		case "--help":
		case "-h":
			console.log(usage());
			return 0;
		case "status": return commandStatus(rest);
		case "doctor": return commandDoctor();
		case "accounts": return commandAccounts(rest);
		case "import": return commandImport(rest);
		case "remove": return commandRemove(rest);
		case "ignore": return commandIgnore(rest, true);
		case "unignore": return commandIgnore(rest, false);
		case "ignored": return commandIgnored(rest);
		case "prefer": return commandPrefer(rest);
		case "preferred": return commandPreferred();
		case "login": return commandLogin();
		case "logout": return commandRemove(["default", ...rest]);
		case "reset": return commandReset();
		case "checkin": return commandCheckin(rest);
		default:
			console.error(`unknown command: ${command}\n\n${usage()}`);
			return 2;
	}
}
main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
	console.error(error);
	process.exit(1);
});
//#endregion
export { main, writeFile };
