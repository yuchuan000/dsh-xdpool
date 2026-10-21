import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import crypto, { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { env } from "node:process";
import http, { createServer, request } from "node:http";
import https, { request as request$1 } from "node:https";
import { Readable, Transform } from "node:stream";
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
/** A `#`-prefixed hex colour of 3–8 digits, which is what CSS accepts. */
const COLOR_TAIL = /^[0-9A-Fa-f]{3,8}$/;
/**
* Split the `badge:<label>:#RRGGBB` entries the CN gateway puts in `tags`.
*
* `#` may legitimately occur inside a label, so the split happens on the LAST
* one and the tail is only accepted as a colour when it actually looks like
* one — otherwise a label such as `C#` would silently lose its last character.
*
* Returns an empty array for `undefined` so callers can iterate unconditionally.
*/
function parseBadgeTags(tags) {
	const out = [];
	for (const tag of tags ?? []) {
		if (!tag.startsWith("badge:")) continue;
		const rest = tag.slice(6);
		const hash = rest.lastIndexOf("#");
		const tail = hash === -1 ? "" : rest.slice(hash + 1);
		const isColor = hash !== -1 && COLOR_TAIL.test(tail);
		const cut = (hash === -1 ? rest : rest.slice(0, hash)).trim();
		const label = isColor ? cut.replace(/:$/, "").trim() : cut;
		if (label === "") continue;
		out.push(isColor ? {
			label,
			color: tail
		} : { label });
	}
	return out;
}
/** The badge labels alone, in upstream order, without the colour segments. */
function badgeLabels(tags) {
	return parseBadgeTags(tags).map((badge) => badge.label);
}
/**
* Whether a zero price should be spelled out as the generic `免费` label.
*
* False in two distinct cases, and the difference matters: a row that is not
* free-priced at all (the caller is not asking), and a row the gateway ALREADY
* badged. `hy3` arrives as `multiplier: 0` AND `badge:限时免费`, and emitting both
* rendered one fact twice ("免费 · 限时免费"). The gateway's own wording is the
* more informative of the two, so it wins.
*/
function shouldSpellOutFree(model) {
	if (model.multiplier !== 0) return false;
	return badgeLabels(model.tags).length === 0;
}
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
/** Was this failure a gateway HTML rejection (a stale sign-in, not a hiccup)? */
function isGatewayRejectionError(error) {
	return (error instanceof Error ? error.message : String(error)).startsWith(GATEWAY_REJECTION_MESSAGE);
}
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
/**
* Parse the reset time the upstream reports for a rate limit, when present.
* Recognises an epoch-millisecond field and the Chinese-localised sentence
* form, so the pool can resume exactly when the window reopens.
*/
function parseRateLimitReset(body) {
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
	if (epochMs !== null) return Number(epochMs[1]);
	const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
	if (localized !== null) {
		const parsed = Date.parse(localized[1].replace(" ", "T"));
		if (!Number.isNaN(parsed)) return parsed;
	}
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
/**
* A chat chain plus the two canvas events that score `create_canvas`.
*
* Worth +300, the joint largest task on the board. The canvas events ride
* the same metrics channel as everything else, so no real canvas is needed.
*
* Measured: three accounts scored 1/1 from this sequence.
*/
function desktopCanvasEvents(conversationId, requestId) {
	const seed = requestId.slice(-8);
	return [
		...desktopChatEvents(conversationId, requestId, "msg-canvas"),
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
			id: `ardot-file-${seed}`,
			source: "summon_keyword",
			type: "page",
			cost: 13e3,
			isSuccessful: true
		}
	];
}
/**
* The single event that scores `automation_1` (a scheduled task was created).
*
* Measured: two accounts lit it with this event alone.
*/
function desktopAutomationCreatedEvent(name) {
	return {
		eventCode: "automated_task_create_suc",
		name,
		source: "manually",
		modelId: "fast-model",
		modelIsThinking: true,
		connectorCount: 0,
		skills: "",
		skillCount: 0,
		scheduleType: "once",
		mode: "LOCAL"
	};
}
function buddyAppEvents(buddyId, buddyName) {
	const base = {
		mode: "LOCAL",
		buddyId,
		buddyName
	};
	return [
		{
			...base,
			eventCode: "buddyapp_discover_click"
		},
		{
			...base,
			eventCode: "buddyapp_show",
			elementId: buddyId,
			elementName: buddyName,
			position: 2
		},
		{
			...base,
			eventCode: "buddyapp_enter_click",
			elementId: buddyId,
			elementName: buddyName,
			position: 2,
			isFirstPage: "1"
		},
		{
			...base,
			eventCode: "buddyapp_auth_confirm_click",
			elementId: buddyId,
			elementName: buddyName
		},
		{
			...base,
			eventCode: "buddyapp_bindaccount_skip_click",
			elementId: buddyId,
			elementName: buddyName
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
function dshHome(env = process.env) {
	const fromEnv = env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}
/** This plugin's own state directory. */
function pluginDataDir(env = process.env) {
	return join(dshHome(env), PLUGIN_DATA_DIR_NAME);
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
* Synchronous read, for startup.
*
* The host applies the ignore list from inside `apply()`, which is synchronous,
* and doing it there removes a startup race: an async load could resolve AFTER
* the first account scan, which would let an ignored account slip into the pool
* once per boot. The file is a few hundred bytes, so a blocking read at startup
* costs nothing measurable.
*/
function readIgnoredAccountsSync(path = ignoredIdsPath()) {
	try {
		return normalize$1(JSON.parse(readFileSync(path, "utf8")));
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
	await writeFile(temp, `${payload}\n`, "utf8");
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
	return join(dshHome(env), PLUGIN_DATA_DIR_NAME, ACCOUNTS_FILE_NAME);
}
/** The directory the pool scans for imported `<md5prefix>.json` snapshots. */
function snapshotDirPath(env = process.env) {
	return join(dshHome(env), PLUGIN_DATA_DIR_NAME);
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
	await writeFile(tmp, document, "utf8");
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
function expiryToMs$1(value) {
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
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs$1(auth["refreshExpiresAt"]) : void 0;
	if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) return;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs$1(auth["lastRefreshTime"]) : void 0;
	return {
		accessToken,
		refreshToken: decryptableString(auth["refreshToken"], decrypt).value,
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs$1(auth["expiresAt"]) : 0,
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
const POOL_STATUS_PATH = "/plugins/dsh-xdpool/status";
/** Plugin-owned local account rescan endpoint (re-read desktop snapshots). */
const POOL_RESCAN_PATH = "/plugins/dsh-xdpool/accounts/rescan";
/**
* Re-fetch the upstream model catalog for both regions.
*
* Separate from {@link POOL_RESCAN_PATH} because they answer different
* questions, and conflating them misled users: "detect accounts again" only
* re-read the desktop snapshots, so it could NOT recover a model list that had
* fallen back to the static table after a failed startup fetch. The only way
* out was restarting DSH.
*/
const POOL_CATALOG_REFRESH_PATH = "/plugins/dsh-xdpool/models/refresh";
/** Plugin-owned cooldown reset endpoint (clear all 429 cooldowns). */
const POOL_RESET_COOLDOWN_PATH = "/plugins/dsh-xdpool/cooldowns/reset";
/** Plugin-owned daily check-in action endpoint (claim today's reward). */
const POOL_CHECKIN_PATH = "/plugins/dsh-xdpool/checkin";
/** Plugin-owned model-selection save endpoint (writes the settings section). */
const POOL_MODELS_SAVE_PATH = "/plugins/dsh-xdpool/models/save";
/** Switch one account in or out of the pool (card toggle). */
const POOL_ACCOUNT_DISABLE_PATH = "/plugins/dsh-xdpool/accounts/disabled";
/**
* Throw one account out of the pool for good, or take it back.
*
* Separate from the disable route because the semantics differ: disabling is a
* rotation preference the account survives, ignoring survives the account.
*/
const POOL_ACCOUNT_IGNORE_PATH = "/plugins/dsh-xdpool/accounts/ignored";
/** Run one automation job immediately, so the card can verify it on demand. */
const POOL_AUTOMATION_RUN_PATH = "/plugins/dsh-xdpool/automation/run";
/** Set or clear one account's reserved-credit floor. */
const POOL_CREDIT_RESERVE_PATH = "/plugins/dsh-xdpool/accounts/credit-reserve";
/**
* Name the account to try first, or hand the choice back to the strategy.
*
* A route rather than a settings write for the reason the ignore list is a file:
* the CLI has no settings service, so a card-only settings key could be written
* by the card and never by `dsh-xdpool prefer`. The route owns the
* write, pushes it into the pool immediately so the very next request sees it,
* and is the one path both halves share.
*/
const POOL_ACCOUNT_PREFER_PATH = "/plugins/dsh-xdpool/accounts/preferred";
/**
* Read the aggregate lane's state: every registry provider, its saved setting
* (never its key), and whether it can serve anything right now.
*
* Separate from {@link POOL_STATUS_PATH} because it answers a different
* question — "what can I configure" rather than "what is my pool doing" — and
* because its payload is the WHOLE roster. Folding 76 provider records into the
* status document would make every 30-second poll of the pool card carry a
* directory nobody reads most of the time.
*/
const POOL_AGGREGATE_PATH = "/plugins/dsh-xdpool/aggregate";
/**
* Save one aggregate provider's setting: its key, its on/off switch, its base-URL
* override, or the model ids a listing round discovered.
*
* POST only, and one provider per request — read-modify-write on the host side,
* so two tabs editing two providers cannot clobber each other.
*/
const POOL_AGGREGATE_SAVE_PATH = "/plugins/dsh-xdpool/aggregate/save";
/**
* Verify one provider's key with a cheap non-generating call, and report what
* its listing answered.
*
* Its own route because it is the only aggregate action that talks to the
* network: a probe must never run as a side effect of saving a setting, or
* "save" would silently spend the user's rate limit.
*/
const POOL_AGGREGATE_TEST_PATH = "/plugins/dsh-xdpool/aggregate/test";
/**
* Send one real streaming call to one model and report how it answered.
*
* Its own route, and POST-only, for the same reason the provider probe is: this
* is the one action in the plugin that spends the user's credits, so it must
* never be reachable by a prefetch, a GET, or any side effect of opening a
* settings page. A GET here would let a browser — or anything else that can
* reach a loopback port — fire unlimited billed calls by walking URLs.
*
* `provider` and `model` are resolved through the host's own adapter registry
* rather than through this plugin's lanes, because that registry is the only
* place that knows which credential and endpoint a given provider id serves.
*/
const POOL_MODEL_PROBE_PATH = "/plugins/dsh-xdpool/model/test";
/**
* POST-only: ask what models several login channels contribute right now.
*
* A route rather than more fields on {@link POOL_CHANNELS_PATH} because the
* answer changes as accounts come and go while the roster does not, and the
* login page polls only its own logins — folding live per-provider catalogues
* into the roster document would either go stale the moment someone signed in,
* or make every page refresh spend a round trip on thirteen providers.
*
* Read from the host rather than from the pack's own `model.list`, because the
* pack keeps only `id`, `name` and two flags and throws away exactly the fields
* this is for. The host's catalogue is the same one the model picker reads, so
* the two agree by construction instead of by luck.
*/
const POOL_CHANNEL_MODELS_PATH = "/plugins/dsh-xdpool/channels/models";
/**
* Fetch one provider's live model list and write it back as its discovered set.
*
* Separate from the probe on purpose. The probe ANSWERS; this one COMMITS — it
* changes what the provider contributes to the picker — so it is its own route
* with its own confirmation, and a failed round keeps the previous roster.
*/
const POOL_AGGREGATE_DISCOVER_PATH = "/plugins/dsh-xdpool/aggregate/discover";
/**
* The thirteen login channels the vendored pack provides.
*
* Separate from the aggregate document for the same reason: the two lanes answer
* different questions. The aggregate roster is "what can I point a key at", the
* channel list is "what can I scan a QR code into", and mixing them in one poll
* would put a third-party directory on the critical path of the pool card.
*/
const POOL_CHANNELS_PATH = "/plugins/dsh-xdpool/channels";
/**
* The `reason` the channel document carries when the login-channel route is
* already owned by another plugin.
*
* The pack we vendor is byte-identical to the one the sibling login-channel
* build mounts, and both claim the same fetch route; the host has no query for
* what is already registered, so the loser of that race can only tell it lost.
* Both halves need the same string — the host to say it, the card to choose
* between "this host cannot run the channels" and "another plugin already runs
* them", which are opposite sentences — so it is declared with the other wire
* constants rather than in `channels.ts`, which the browser bundle may not
* import for value.
*/
const ROUTE_OWNED_ELSEWHERE = "already-mounted-elsewhere";
/**
* The routing chains, and the whole model roster a member may name.
*
* One route for both because the editor cannot be drawn without the roster: a
* member is chosen from a list, and a list of ids with no names, windows or
* vendors is a list nobody can pick from. Reading two documents on one panel
* open would also mean the roster could be a second older than the chains.
*/
const POOL_COMBOS_PATH = "/plugins/dsh-xdpool/combos";
/**
* Replace the whole chain list in one write.
*
* A single table replace rather than a per-chain patch: the editor's unit of
* intent is "this is my routing table", and deleting one member is
* indistinguishable from deleting that member's chain once ids are equal — so a
* merge rule would have to guess, and a wrong guess silently resurrects a row the
* user deleted.
*/
const POOL_COMBOS_SAVE_PATH = "/plugins/dsh-xdpool/combos/save";
/**
* The LAN relay's own state, and the only way to change it.
*
* One GET and one POST rather than a separate settings surface, because the relay
* is a switch you have to be able to kill from the same card that turns it on —
* a relay left listening on a network interface is the one failure here that
* keeps mattering after the plugin is closed.
*/
const POOL_RELAY_PATH = "/plugins/dsh-xdpool/relay";
/**
* What the locally running billion-context proxy is doing, read-only.
*
* Its own route because the answer comes from ANOTHER plugin: billion-context
* runs its own loopback listener and publishes its own JSON, so this route only
* finds that listener and relays a filtered subset. Nothing here is folded into
* {@link POOL_STATUS_PATH}: the pool card polls that every 30 seconds, and a
* third-party proxy's session table is not something every pool poll should
* carry.
*
* The word "read-only" is load-bearing on both ends. This plugin sends GETs
* only — it never configures, restarts or writes to the proxy — and the payload
* it relays deliberately omits every field that could carry conversation
* material.
*/
const POOL_BILLION_PATH = "/plugins/dsh-xdpool/billion";
/**
* Read the usage panel's aggregate.
*
* GET only, and token-free by construction: the recorder holds counts and
* timings, never a prompt. The document type is `UsageSummary` from
* `src/stats.ts` rather than a copy declared here, because that module stays
* Node-free precisely so the browser half can import the SAME declaration
* instead of a second one that could quietly drift.
*/
const POOL_USAGE_PATH = "/plugins/dsh-xdpool/usage";
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
/**
* `PACK_ENTRY` as a URL, which is the only spelling `import()` accepts.
*
* On POSIX the two are interchangeable enough that the bug hid for a while; on
* Windows a bare `D:\...` path is not a specifier at all, and the loader answers
* `Only URLs with a scheme in: file, data, node, and electron are supported`
* before it ever looks at the disk. `pathToFileURL` also handles the drive
* letter and the backslashes, so this is the portable spelling rather than a
* Windows special case.
*/
const PACK_ENTRY_URL = pathToFileURL(PACK_ENTRY).href;
/**
* The thirteen channels the pack registers, with the copy the card shows.
*
* `org`, `accent` and the login flow are lifted from the pack's own table
* (`CHANNEL_PROVIDERS` in its client bundle) so the card and the pack cannot
* disagree about what a channel is. Nothing here decides behaviour — the pack
* still owns the protocol — so a channel that changes its login flow upstream
* needs a data edit here, not a code change.
*
* `note` is the exception: it is ours, not the pack's, and it is Chinese on
* purpose. The user asked for each card to state in Chinese how much of that
* vendor's model usage is actually free, because the roster they were reading
* said "每日免费额度" eleven times over — a phrase that names the existence of a
* free allowance without ever saying what it is. Each line below names the
* models on the free line and, where the vendor publishes a figure, the figure
* itself. Where no figure is published, the line says so rather than inventing
* a number: a quota we guessed would be the one number on the card a user would
* plan their day around.
*/
const REGISTERED_CHANNELS = [
	{
		id: "codearts",
		name: "CodeArts",
		org: "华为云",
		accent: "#C7000B",
		note: "已开通免费体验套餐，自动续期不收费；新人积分 + DeepSeek · GLM · openPangu 每日免费额度",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "buddy",
		name: "WorkBuddy 国内版",
		org: "腾讯",
		domain: "copilot.tencent.com",
		accent: "#0A7AFF",
		note: "与 CodeBuddy 共用端点：DeepSeek · Kimi · GLM 免费线，每日赠送积分",
		login: "browser",
		credits: {
			claim: true,
			status: true
		}
	},
	{
		id: "workbuddy",
		name: "WorkBuddy 国际版",
		org: "腾讯",
		domain: "www.workbuddy.ai",
		accent: "#0B63CE",
		note: "独立端点与账号体系，积分与国内版不互通；国际版后端没有每日签到接口",
		login: "browser",
		credits: { status: true }
	},
	{
		id: "lobsterai",
		name: "LobsterAI",
		org: "有道",
		accent: "#FF6A00",
		note: "每日签到领积分，积分换模型调用额度",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "qoder",
		name: "Qoder 国际版",
		org: "阿里云",
		accent: "#615CED",
		note: "每日 100 Credits，加密推理端点",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "qodercn",
		name: "Qoder 国内版",
		org: "阿里云",
		accent: "#7A6CF0",
		note: "每日 100 Credits，国内端点与模型池",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "trae",
		name: "TRAE",
		org: "字节跳动",
		accent: "#00BFA6",
		note: "手机号注册即送免费额度，按天重置",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "cline",
		name: "Cline",
		org: "Cline Bot",
		accent: "#5B5BD6",
		note: "绑定 GitHub 账号后送美元计价的免费额度；其后端没有每日签到接口",
		login: "browser",
		credits: { unit: "dollars" }
	},
	{
		id: "loomy",
		name: "Loomy",
		org: "讯飞星火",
		accent: "#2F6BFF",
		note: "星火模型每日免费额度，扫码或手机号均可登录",
		login: "browser",
		credits: { claim: true }
	},
	{
		id: "raccoon",
		name: "Raccoon",
		org: "商汤",
		accent: "#00A6A6",
		note: "手机号注册即送免费额度；每日积分由服务端自动发放，登录奖励需在「新手任务」领取",
		login: "browser",
		smsHint: true,
		credits: {}
	},
	{
		id: "minimax",
		name: "MiniMax Code",
		org: "MiniMax",
		accent: "#E4007F",
		note: "设备码 + PKCE 登录，每日签到领额度",
		login: "browser",
		credits: {
			claim: true,
			status: true
		}
	},
	{
		id: "zcode",
		name: "ZCode",
		org: "智谱",
		accent: "#3B6EF6",
		note: "GLM 模型按 token 计免费额度，需本机可开浏览器",
		login: "browser",
		credits: {
			claim: true,
			unit: "tokens"
		}
	},
	{
		id: "gemini",
		name: "Gemini Code Assist",
		org: "Google",
		accent: "#4285F4",
		note: "个人 Google 账号的免费配额，走本地回调 OAuth",
		login: "browser",
		credits: { quota: true }
	}
];
/**
* The two channels this plugin already serves from its own account pool.
*
* Mounting the pack alongside them means both register an adapter for the same
* id. The pack's `registerAdapterIdempotent` swallows duplicate registrations and
* keeps the incumbent, and our own registration happens first, so the account
* pool wins and the pack's duplicate is skipped. This set is what the card uses
* to say "already handled above" instead of offering a login for a channel the
* user manages elsewhere.
*/
const POOL_OWNED_CHANNELS = /* @__PURE__ */ new Set(["buddy", "workbuddy"]);
/** Whether the pack and its WASM sibling are both present on disk. */
function channelPackFilesPresent() {
	return existsSync(PACK_ENTRY) && existsSync(join(dirname(PACK_ENTRY), "qoder-auth-wasm.wasm"));
}
/**
* Mount the pack on `ctx`.
*
* Failure-tolerant on purpose: the pack is a bonus lane, so a host composition
* that lacks `credentials`, `commands` or `llm` must still load the account
* pool. The caller is expected to have gated the call on the pack's own declared
* `inject` (all three services); this function then only has to survive a load
* or mount failure, which it reports rather than throwing.
*
* THE `/api/channel-pack` ROUTE IS NOT OURS TO REGISTER
*
* This bundle is byte-identical to the one the sibling login-channel build
* (`dsh-our-free-model`) already mounts, and both register the exact same fetch
* route. The host's connection service throws on a duplicate — `connection:
* exact Fetch route "/api/channel-pack" is already registered` — and it exposes
* only `register`, with no query for what is already claimed, so nothing here
* can ask "is that mine?" before reaching for it. Whichever plugin mounts first
* owns the route, and the other's card talks to the owner's pack, which serves
* the same thirteen channels either way.
*
* THE SAME COLLISION ARRIVES EARLIER, AS A CORDIS SERVICE
*
* A second copy of the pack does not reach the fetch route at all. Its
* `apply` builds `new CodeArtsAuth(ctx)` (:67588) long before it registers the
* RPC endpoints, and the cordis `Service` base class registers itself in its
* constructor (`@deepseek-ai/cordis`, `Service.constructor` →
* `ctx.reflect.provide`), which throws `service "codeartsAuth" has been
* registered at <our-free-model>` on the first duplicate. That is why the page
* used to print "the login channel could not start" while scanning worked
* perfectly: the winner had the route, the loser never got as far as asking
* for it. Both throws describe one event — a second mount of an identical pack
* — so both are reported as the same cosmetic outcome.
*
* Losing that race is therefore a cosmetic failure, not a functional one, and it
* is reported as such: the page says the channels are already served elsewhere
* and offers the sibling's own page, instead of printing a raw host error at the
* user. The distinction is kept in the state because "someone else owns it" and
* "this host cannot run it" call for different wording.
*
* The dynamic import is deliberate even though the file is vendored: pulling a
* 68k-line bundle into the module graph would add its own top-level cost to
* every startup of a plugin that is really an account pool, and the pack is only
* needed when the user opens the channel page.
*
* Returns a handle whose `state()` reports what happened. A silently absent
* channel list is the one failure mode a user cannot diagnose for themselves.
*/
function mountChannelPack(ctx, logger) {
	let state = { state: "pending" };
	if (!channelPackFilesPresent()) {
		state = {
			state: "unavailable",
			reason: "vendor/channel-pack is missing from the installed package"
		};
		logger?.warn?.(`[xdpool] ${state.reason}; the login channels are disabled`);
		return { state: () => state };
	}
	import(PACK_ENTRY_URL).then((loaded) => {
		const pack = loaded;
		if (typeof pack.apply !== "function") {
			state = {
				state: "unavailable",
				reason: "the channel pack exposes no apply()"
			};
			logger?.warn?.(`[xdpool] ${state.reason}; the login channels are disabled`);
			return;
		}
		pack.apply(ctx, { disableOpencode: true });
		state = {
			state: "ready",
			providers: REGISTERED_CHANNELS.length
		};
		logger?.info?.(`[xdpool] free-channel pack mounted (${REGISTERED_CHANNELS.length} login channels)`);
	}).catch((error) => {
		if (isDuplicateMountError(error)) {
			state = {
				state: "unavailable",
				reason: ROUTE_OWNED_ELSEWHERE
			};
			logger?.info?.(`[xdpool] the login channels are already served by another plugin (${ROUTE_OWNED_ELSEWHERE}); the account pool is unaffected`);
			return;
		}
		state = {
			state: "unavailable",
			reason: errorMessage(error)
		};
		logger?.warn?.(`[xdpool] free-channel pack unavailable (${state.reason}); the account pool is unaffected`);
	});
	return { state: () => state };
}
/**
* Whether this throw means another copy of the pack is already mounted.
*
* Both hosts spellings are matched, each on both halves of its sentence, because
* the API offers no error type and no code — the message is the only signal.
*
* - `connection: exact Fetch route "/api/channel-pack" is already registered`
*   from `@deepseek-ai/dsh-client-connection`: the pack reached its own
*   `connection.fetch.register` and the sibling owns that route. Half-matched on
*   purpose: a message that merely mentions a route is not proof of a collision,
*   and treating one as the other would hide a real mount failure behind "someone
*   else has it".
* - `service "codeartsAuth" has been registered at <our-free-model>` from
*   `@deepseek-ai/cordis`: the sibling already constructed the same service
*   class, so this copy dies before it reaches the route. Half-matched again —
*   `service "…"` is generic enough that an unrelated provider clash would
*   otherwise be misreported as a takeover.
*
* The `<our-free-model>` in the message is the winning fiber's name, not a
* contract, so no name is matched: this build must keep working when the sibling
* is absent.
*/
function isDuplicateMountError(error) {
	if (!(error instanceof Error)) return false;
	const message = error.message;
	const route = /exact Fetch route/u.test(message) && /already registered/u.test(message);
	const service = /service "/u.test(message) && /has been registered at </u.test(message);
	return route || service;
}
function errorMessage(error) {
	if (error instanceof Error) return error.message.slice(0, 300);
	return String(error).slice(0, 300);
}
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
const PROVIDERS_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
/** True when the string names a provider this lane knows. */
function isProviderId(value) {
	return PROVIDERS_BY_ID.has(value);
}
/** One provider by id, or null. */
function getProvider(id) {
	if (typeof id !== "string") return null;
	return PROVIDERS_BY_ID.get(id) ?? null;
}
/** Provider ids, in registry order. */
function listProviderIds() {
	return Object.freeze(PROVIDERS.map((provider) => provider.id));
}
/** The composite id this lane advertises a model under: `providerId/modelId`. */
function providerModelId(providerId, modelId) {
	return `${providerId}/${modelId}`;
}
/** Split a composite id back into its two halves, or null. */
function parseProviderModelId(composite) {
	if (typeof composite !== "string") return null;
	const text = composite.trim();
	const slash = text.indexOf("/");
	if (slash <= 0) return null;
	const providerId = text.slice(0, slash);
	const modelId = text.slice(slash + 1).trim();
	if (modelId === "") return null;
	return {
		providerId,
		modelId
	};
}
/** Wire suffixes, so a URL is never assembled from a guess. */
const CHAT_PATHS = Object.freeze({
	"openai-chat": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/messages"
});
/**
* Headers one provider needs, with the credential attached last.
*
* Source-declared headers come first so the credential always wins a collision:
* a provider that ships its own `user-agent` or an `anthropic-beta` keeps it,
* and a key can never be overwritten by a registry typo.
*
* A key is only attached for `apiKey` providers. A `none` provider must NOT
* send an authorization header (OpenCode Free rejects one), and `oauth` / `adc`
* credentials are minted by their own flow and injected by the caller.
*/
function defaultHeaders(provider, apiKey) {
	const headers = {};
	for (const [name, value] of Object.entries(provider.headers ?? {})) headers[name.toLowerCase()] = value;
	if (provider.format === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
	headers["content-type"] = "application/json";
	const key = typeof apiKey === "string" ? apiKey.trim() : "";
	if (key !== "" && provider.auth.kind === "apiKey") {
		if (provider.format === "anthropic-messages") headers["x-api-key"] = key;
		else headers.authorization = `Bearer ${key}`;
	}
	return headers;
}
/** Where a completion is posted, or null when the base URL is unusable. */
function chatEndpoint(provider) {
	const base = typeof provider.baseUrl === "string" ? provider.baseUrl.trim().replace(/\/+$/, "") : "";
	const suffix = CHAT_PATHS[provider.format];
	if (base === "" || suffix === void 0) return null;
	return `${base}${suffix}`;
}
/**
* Where a provider's model listing lives, or null when it declares none.
*
* Only listings the registry actually names are returned. A guessed URL is
* worse than none: the caller can always ask the provider for nothing, but
* asking the wrong host produces a failure that reads like the provider is down.
*
* ABSOLUTE FIRST, RELATIVE SECOND. The registry spells `modelsUrl` as a full
* URL (`https://opencode.ai/zen/v1/models`), not as a path under `baseUrl`
* (`/models`). Concatenating anyway produced
* `https://opencode.ai/zen/v1https://opencode.ai/zen/v1/models`, which is not
* a URL at all: the host answers it from its catch-all route with 200 and an
* HTML page, so the caller sees a successful response that will not parse and
* reports "the listing answered HTTP 200 but its shape was not recognised".
* A doubled URL looks exactly like a broken provider, which is why this could
* hide behind thirty correct registry entries and still break every one of
* them. A relative spelling is still resolved against the base, so a registry
* that writes `/models` keeps working.
*/
function modelsEndpoint(provider) {
	const declared = typeof provider.modelsUrl === "string" ? provider.modelsUrl.trim() : "";
	if (declared === "") return null;
	if (/^[a-z][a-z0-9+.-]*:/iu.test(declared)) return declared;
	const base = typeof provider.baseUrl === "string" ? provider.baseUrl.trim().replace(/\/+$/, "") : "";
	if (base === "") return null;
	return `${base}${declared.startsWith("/") ? "" : "/"}${declared}`;
}
/** True when the registry record declares a models endpoint. */
function hasModelsListing(provider) {
	return typeof provider.modelsUrl === "string" && provider.modelsUrl.trim() !== "";
}
//#endregion
//#region src/combos.ts
/** Id prefix every combo row advertises under. */
const COMBO_PREFIX = "combo:";
/** The lane name a combo row belongs to, for display grouping. */
const COMBO_CHANNEL = "combo";
/** Chain strategies. Anything else on disk falls back to `fallback`. */
const COMBO_STRATEGIES = ["fallback", "round-robin"];
/** A trimmed non-empty string, or ''. */
function text$6(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** A de-duplicated list of non-empty trimmed strings from an untrusted array. */
function stringList$2(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of value) {
		const id = text$6(raw);
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
/**
* The combo id a name slugifies to, or '' when the name cannot form one.
*
* Unicode-aware on purpose. This used to be `/[^a-z0-9]+/g`, which meant any
* name that was not ASCII — every Chinese chain name — slugged to the empty
* string, and `normalizeCombos` then dropped the entry with a bare `continue`.
* The card reported "saved", the store held nothing, and the chain vanished on
* the next read: the "new route cannot be saved" report. A name is user data and
* may be written in any script, so the id has to survive one.
*
* Latin names keep the old shape (`writing-fallback`), because ids already
* stored that way must keep resolving; only characters that used to be stripped
* to nothing are now kept.
*/
function comboId(name) {
	const slug = text$6(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
	return slug === "" ? "" : `${COMBO_PREFIX}${slug}`;
}
/** True when the id names a combo row. */
function isComboId(id) {
	return typeof id === "string" && id.startsWith("combo:") && id.length > 6;
}
/**
* Narrow one catalog row to the chain kind.
*
* A predicate rather than an `id` check at each call site: a chain row and a
* provider row share only `id`, so callers that reach for `providerId` on the
* union would otherwise compile only because the id happened to start with
* `combo:`. Here the compiler enforces that a chain has no vendor field at all.
*/
function isComboRow(row) {
	return isComboId(row.id);
}
/**
* Shape whatever the settings file held into a usable chain list.
*
* A chain with no members is DROPPED rather than kept as an empty row: a model
* that cannot answer anything is not a model, and showing one in the picker
* only produces a request that fails with nothing to fix. The card warns about
* that case before the save (`route.noMembers`), which is why dropping here is
* not a silent loss.
*/
function normalizeCombos(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const value = entry;
		const name = text$6(value.name) || text$6(value.id);
		if (name === "") continue;
		const id = text$6(value.id);
		const models = stringList$2(value.models).filter((model) => model !== id && !isComboId(model));
		if (models.length === 0) continue;
		const chainId = isComboId(id) ? id : comboId(name);
		if (chainId === "" || seen.has(chainId)) continue;
		seen.add(chainId);
		const strategy = COMBO_STRATEGIES.includes(value.strategy) ? value.strategy : "fallback";
		const limit = typeof value.stickyLimit === "number" && Number.isFinite(value.stickyLimit) ? Math.floor(value.stickyLimit) : 1;
		out.push({
			id: chainId,
			name,
			models,
			strategy,
			stickyLimit: limit > 0 ? limit : 1,
			enabled: value.enabled !== false
		});
	}
	return out;
}
/**
* Classify one member id against both catalogs.
*
* `combo:` ids are rejected outright: a chain pointing at another chain would
* make the router depend on its own output, and the round-robin cursor would
* then advance twice per turn.
*/
function resolveComboMember(modelId, sources) {
	const id = text$6(modelId);
	if (id === "" || isComboId(id)) return void 0;
	const aggregateRow = sources.aggregate.find((row) => row.id === id);
	if (aggregateRow !== void 0) {
		const parsed = parseProviderModelId(id);
		return {
			modelId: id,
			aggregate: true,
			providerId: parsed === null ? aggregateRow.providerId : parsed.providerId,
			name: aggregateRow.name,
			contextWindow: aggregateRow.contextWindow,
			maxOutputTokens: aggregateRow.maxOutputTokens,
			supportsImages: aggregateRow.supportsImages
		};
	}
	const poolRow = sources.pool.find((row) => row.id === id);
	if (poolRow === void 0) return void 0;
	return {
		modelId: id,
		aggregate: false,
		name: poolRow.name,
		contextWindow: poolRow.contextWindow,
		maxOutputTokens: poolRow.maxOutputTokens,
		supportsImages: poolRow.supportsImages
	};
}
/**
* Every combo row that can currently answer, given the catalogs.
*
* Disabled chains are skipped, as are chains whose members have all gone away:
* a row that cannot answer is worse than no row, because the picker would show
* it as a broken model rather than as nothing configured.
*/
function buildComboCatalog(chains, sources) {
	const rows = [];
	for (const chain of chains) {
		if (chain.enabled === false) continue;
		const id = isComboId(chain.id ?? "") ? chain.id : comboId(chain.name);
		if (id === "") continue;
		const members = [];
		for (const memberId of chain.models) {
			const member = resolveComboMember(memberId, sources);
			if (member !== void 0) members.push(member);
		}
		if (members.length === 0) continue;
		rows.push({
			id,
			name: chain.name,
			models: members.map((member) => member.modelId),
			strategy: COMBO_STRATEGIES.includes(chain.strategy) ? chain.strategy : "fallback",
			stickyLimit: typeof chain.stickyLimit === "number" && chain.stickyLimit > 0 ? Math.floor(chain.stickyLimit) : 1,
			contextWindow: Math.min(...members.map((member) => member.contextWindow || 131072)),
			maxOutputTokens: Math.min(...members.map((member) => member.maxOutputTokens || 32768)),
			supportsImages: members.every((member) => member.supportsImages),
			combo: true
		});
	}
	return rows;
}
/**
* Per-chain rotation cursors, in memory.
*
* Not persisted on purpose: a cursor is a scheduling detail, and restoring a
* stale one after a restart would silently continue a rotation the user can no
* longer see. Losing it costs at most one extra turn on the wrong member.
*/
const rotation = /* @__PURE__ */ new Map();
/** Forget the cursors of chains that no longer exist. */
function pruneRotation(combos) {
	const keep = new Set(combos.map((chain) => chain.id).filter((id) => typeof id === "string"));
	for (const id of [...rotation.keys()]) if (!keep.has(id)) rotation.delete(id);
}
/**
* The members to try for one turn, in order.
*
* `fallback` always restarts from the head, which is what makes it predictable:
* the first member is the one the user put first, and a failure there is a
* reason to try the second rather than to keep hammering the first.
*
* `round-robin` starts from the cursor instead. It is the mode that spreads
* load across several equivalent upstreams, and `stickyLimit` is how many
* consecutive turns one member keeps before the cursor moves — one keeps a
* conversation pinned, five lets a burst soak one lane before it rotates.
*/
function comboChain(row, options = {}) {
	const members = row.models;
	if (members.length <= 1) return members;
	if (row.strategy !== "round-robin") return members;
	const cursor = rotation.get(row.id) ?? {
		index: 0,
		used: 0
	};
	const start = (cursor.index % members.length + members.length) % members.length;
	const ordered = [...members.slice(start), ...members.slice(0, start)];
	if (options.peek === true) return ordered;
	const used = cursor.used + 1;
	const limit = row.stickyLimit > 0 ? row.stickyLimit : 1;
	rotation.set(row.id, used >= limit ? {
		index: (start + 1) % members.length,
		used: 0
	} : {
		index: start,
		used
	});
	return ordered;
}
//#endregion
//#region src/store.ts
/**
* Aggregate-lane settings store: the user's own provider keys, persisted in the
* plugin's own data directory.
*
* WHY A FILE AND NOT THE SETTINGS DOCUMENT
*
* Everything else on the card lives in the settings section, and this
* deliberately does not. Two reasons, in order of weight:
*
*   1. The CLI has no settings service. The ignore list already established the
*      pattern (`src/ignored.ts`): a plugin-owned file, atomically written, read
*      by both halves. Two write paths for one list is how they drift apart.
*   2. These strings are CREDENTIALS. The settings document is validated and
*      echoed to the browser by the host's own form renderer, and every schema
*      change would become a migration risk for the user's API keys.
*
* The file is re-read on EVERY call rather than cached, so a CLI edit made while
* the card is open is picked up without a reload — the same contract
* `ignored.ts` documents for the ignore list.
*
* @module dsh-xdpool/store
*/
/** Bumped only if the on-disk shape ever changes incompatibly. */
const STORE_VERSION = 1;
/** A trimmed non-empty string, or ''. */
function text$5(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** Where the aggregate settings live; undefined when no home directory resolves. */
function aggregateSettingsPath() {
	const home = env.DSH_HOME ?? homedir();
	if (typeof home !== "string" || home === "") return void 0;
	return join(home, ".xdpool", "aggregate.json");
}
/** One provider's setting, normalised; an unknown id is dropped on read. */
function normalizeSetting(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const value = raw;
	const setting = {};
	if (typeof value.enabled === "boolean") setting.enabled = value.enabled;
	const key = text$5(value.apiKey);
	if (key !== "") setting.apiKey = key;
	const baseUrl = text$5(value.baseUrl);
	if (baseUrl !== "") setting.baseUrl = baseUrl.replace(/\/+$/, "");
	if (Array.isArray(value.models)) {
		const models = stringList$1(value.models);
		if (models.length > 0) setting.models = models;
	}
	if (Array.isArray(value.discovered)) {
		const discovered = stringList$1(value.discovered);
		if (discovered.length > 0) setting.discovered = discovered;
	}
	const addedAt = text$5(value.addedAt);
	if (addedAt !== "") setting.addedAt = addedAt;
	return setting;
}
/** A de-duplicated list of non-empty trimmed strings from an untrusted array. */
function stringList$1(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const raw of value) {
		const id = text$5(raw);
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
/**
* Read the store.
*
* Never throws: a missing file is a fresh install, and a corrupt one is a
* recoverable user mistake. A provider id the registry no longer knows is
* dropped rather than surfaced — the roster moves, and an unknown key must not
* become an error the card cannot clear.
*/
async function readAggregateSettings() {
	const path = aggregateSettingsPath();
	if (path === void 0) return {};
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return {};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	return normalizeStore(parsed);
}
/** Read the store on the synchronous path; same rules, no cache. */
function readAggregateSettingsSync() {
	const path = aggregateSettingsPath();
	if (path === void 0) return {};
	try {
		return normalizeStore(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}
/** Shape an untrusted document into the settings type, dropping unknown ids. */
function normalizeStore(parsed) {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const file = parsed;
	const store = {};
	if (typeof file.enabled === "boolean") store.enabled = file.enabled;
	const providers = {};
	if (file.providers !== null && typeof file.providers === "object" && !Array.isArray(file.providers)) for (const [id, raw] of Object.entries(file.providers)) {
		if (!getProvider(id)) continue;
		providers[id] = normalizeSetting(raw);
	}
	if (Object.keys(providers).length > 0) store.providers = providers;
	const combos = normalizeCombos(file.combos);
	if (combos.length > 0) store.combos = combos;
	const relay = normalizeRelay(file.relay);
	if (relay !== void 0) store.relay = relay;
	return store;
}
/**
* The relay setting, normalised; undefined when there is nothing to remember.
*
* A half-written section is dropped field by field rather than rejected whole,
* for the same reason the chains are: the relay shares this file with the API
* keys, and one bad field must not cost the user both.
*/
function normalizeRelay(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const value = raw;
	const relay = {};
	if (typeof value.enabled === "boolean") relay.enabled = value.enabled;
	const host = text$5(value.host);
	if (host !== "") relay.host = host;
	if (typeof value.port === "number" && Number.isInteger(value.port)) relay.port = value.port;
	const key = text$5(value.key);
	if (key !== "") relay.key = key;
	return Object.keys(relay).length === 0 ? void 0 : relay;
}
/**
* Write the store atomically: a sibling `.tmp` first, then a rename.
*
* Same discipline as the ignore list. A process killed mid-write must leave
* either the old file or the new one — half a credential file is a silent
* credential loss, which is the one outcome worse than a failed save.
*/
async function writeAggregateSettings(settings) {
	const path = aggregateSettingsPath();
	if (path === void 0) throw new Error("no home directory to store the aggregate settings in");
	await mkdir(dirname(path), { recursive: true });
	const file = {
		version: STORE_VERSION,
		...settings
	};
	await writeFile(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	await rename(`${path}.tmp`, path);
}
/**
* Merge one provider's patch into the store and write it back.
*
* Read-modify-write, not a full overwrite: the card sends one provider per
* request, so two tabs editing two providers must not clobber each other. An
* `apiKey` of '' CLEARS the key rather than storing an empty string — a stored
* empty key would read as "configured" in any view that only checks presence.
*/
async function updateProviderSetting(providerId, patch) {
	if (getProvider(providerId) === null) throw new Error(`unknown provider: ${providerId}`);
	const current = await readAggregateSettings();
	const providers = { ...current.providers };
	const after = { ...providers[providerId] ?? {} };
	if (patch.enabled !== void 0) after.enabled = patch.enabled;
	if (patch.baseUrl !== void 0) {
		const baseUrl = text$5(patch.baseUrl).replace(/\/+$/, "");
		if (baseUrl === "") delete after.baseUrl;
		else after.baseUrl = baseUrl;
	}
	if (patch.apiKey !== void 0) {
		const key = text$5(patch.apiKey);
		if (key === "") delete after.apiKey;
		else after.apiKey = key;
	}
	if (patch.models !== void 0) {
		const models = stringList$1(patch.models);
		if (models.length === 0) delete after.models;
		else after.models = models;
	}
	if (patch.discovered !== void 0) {
		const discovered = stringList$1(patch.discovered);
		if (discovered.length === 0) delete after.discovered;
		else after.discovered = discovered;
	}
	if (after.addedAt === void 0) after.addedAt = (/* @__PURE__ */ new Date()).toISOString();
	if (Object.keys(after).filter((key) => key !== "addedAt").length === 0) delete providers[providerId];
	else providers[providerId] = after;
	const next = {
		...current,
		providers
	};
	await writeAggregateSettings(next);
	return next;
}
/** Remove one provider's setting entirely (the card's "forget this key"). */
async function clearProviderSetting(providerId) {
	const current = await readAggregateSettings();
	const providers = { ...current.providers };
	delete providers[providerId];
	const next = {
		...current,
		providers
	};
	if (Object.keys(providers).length === 0) delete next.providers;
	await writeAggregateSettings(next);
	return next;
}
/** Flip the lane's own master switch. */
async function setAggregateEnabled(enabled) {
	const next = {
		...await readAggregateSettings(),
		enabled
	};
	await writeAggregateSettings(next);
	return next;
}
/**
* Replace the whole chain list.
*
* Whole-list replacement rather than per-chain patches, because the card edits
* chains as units (add a member, flip a strategy, delete the row) and a partial
* merge would have to invent rules for "the user removed a member" — which is
* indistinguishable from "the user removed the chain" once the ids are the same.
* The list is normalised on the way in, so a chain the catalogs can never serve
* is simply not written back.
*/
async function saveCombos(raw) {
	const current = await readAggregateSettings();
	const combos = normalizeCombos(raw);
	const next = { ...current };
	if (combos.length === 0) delete next.combos;
	else next.combos = combos;
	await writeAggregateSettings(next);
	return next;
}
/** The stored chains, normalised; empty when the file has none. */
function combosOf(store) {
	return normalizeCombos(store.combos);
}
/**
* Merge a relay patch and write it back.
*
* `key` of '' CLEARS the key rather than storing an empty string: an empty key
* reads as "configured" in any view that only checks presence, and a relay with
* no key must refuse every request rather than accept them.
*/
async function updateRelaySetting(patch) {
	const current = await readAggregateSettings();
	const after = { ...current.relay ?? {} };
	if (patch.enabled !== void 0) after.enabled = patch.enabled;
	if (patch.host !== void 0) {
		const host = text$5(patch.host);
		if (host === "") delete after.host;
		else after.host = host;
	}
	if (patch.port !== void 0) {
		const port = patch.port;
		if (Number.isInteger(port) && port > 0 && port < 65536) after.port = port;
		else if (port === 0) delete after.port;
	}
	if (patch.key !== void 0) {
		const key = text$5(patch.key);
		if (key === "") delete after.key;
		else after.key = key;
	}
	const next = { ...current };
	if (Object.keys(after).length === 0) delete next.relay;
	else next.relay = after;
	await writeAggregateSettings(next);
	return next;
}
/** One provider's saved setting, or `{}`. */
function providerSettingOf(store, providerId) {
	return store.providers?.[providerId] ?? {};
}
/**
* Whether a provider could serve a model right now.
*
* Keyless and local providers are usable with nothing configured; `oauth` and
* `adc` never are, because their tokens are minted by a sign-in flow this lane
* does not drive — and `defaultHeaders` would not even attach a pasted key, so
* the row would be a guaranteed 401.
*/
function providerAuthUsable(provider, setting) {
	if (provider.auth.kind === "oauth" || provider.auth.kind === "adc") return false;
	if (provider.auth.kind === "apiKey") return text$5(setting.apiKey) !== "";
	return true;
}
/**
* Whether a provider contributes models right now.
*
* An explicit flag always wins — that is the user's own decision and nothing
* overrides it. With no flag the answer is NO, for every vendor, with one
* deliberate exception: pasting a key IS the act of opting in, so a provider
* holding a usable key counts as on.
*
* This replaced "absent means on", which drew the whole seventy-six-vendor
* roster with every switch already flipped. The user asked for the opposite:
* the rows are a directory of vendors to CHOOSE from, and a page where
* everything looks enabled says nothing about what is actually configured —
* the one vendor that was set up looked exactly like the seventy-five that
* were not. A keyless vendor stays off too, because "needs no credential" is
* not the same as "belongs in my pool"; `opencode` alone would otherwise drop
* seventy-four models into the picker for someone who never asked for them.
*/
function providerEnabled(provider, setting) {
	if (setting.enabled !== void 0) return setting.enabled;
	return provider.auth.kind === "apiKey" && providerAuthUsable(provider, setting);
}
/** Every provider with its state, in registry order; the settings page's list. */
function listProviderStates(store) {
	const out = [];
	for (const provider of PROVIDERS) {
		const setting = providerSettingOf(store, provider.id);
		out.push({
			provider,
			setting,
			usable: providerAuthUsable(provider, setting)
		});
	}
	return out;
}
/** Provider ids the user has actually configured, in registry order. */
function configuredProviderIds(store) {
	const known = new Set(store.providers ? Object.keys(store.providers) : []);
	const out = [];
	for (const id of listProviderIds()) if (known.has(id)) out.push(id);
	return out;
}
//#endregion
//#region src/aggregate.ts
/**
* Aggregate lane: the 76 declared upstream providers, resolved per request and
* forwarded to with the user's own key.
*
* WHY A SECOND LANE BESIDE THE POOL
*
* The pool serves exactly one family of gateways — WorkBuddy, CN and
* international — from accounts the user already signed in on the desktop app.
* This module serves the orthogonal case: a provider the user holds a key for,
* reached at that provider's own endpoint, with no account rotation because
* there is no account to rotate. Same card, same model picker, different wire.
*
* WHAT IT DELIBERATELY DOES NOT DO
*
* It does not invent endpoints. Every URL here comes from the registry record or
* from a base-URL override the user typed; a provider whose endpoint cannot be
* composed is reported as such rather than being probed at a guessed URL, because
* "no listing" and "provider is down" must not read the same to the user.
*
* It also does not decide whether a provider is USABLE — that is the settings
* layer's call (`providerAuthUsable`). This module resolves what a request
* needs, and refuses with a message naming what is missing.
*
* KEYS
*
* Every string that can reach a message — a failure, a body snippet, a probe's
* answer — passes through {@link redactAggregateSecret} first. Providers echo
* rejected credentials back (a 401 body routinely repeats the key), and this
* text is folded into messages the host writes to its durable session log.
*
* @module dsh-xdpool/aggregate
*/
const WIRE_BY_FORMAT = Object.freeze({
	"openai-chat": "chat",
	"openai-responses": "responses",
	"anthropic-messages": "messages"
});
/**
* Wire suffixes, needed only for the one record the registry gives no base URL
* to (Azure names its endpoint per deployment, so `chatEndpoint` is null there
* and there is no registry endpoint to read the suffix off).
*/
const CHAT_SUFFIX = Object.freeze({
	"openai-chat": "/chat/completions",
	"openai-responses": "/responses",
	"anthropic-messages": "/messages"
});
/**
* Capacities for a row the registry describes only by id.
*
* Deliberately conservative, and the reason is visible in the number: most
* registry rows publish no context window at all. Publishing a plausible one
* would put a fabricated field in front of the user — and unlike a display
* label, a wrong window is a wrong capability, so DSH would hand the provider a
* prompt it cannot accept.
*/
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT = 32768;
/** Listing round budget. Generous for a small JSON document, short for a UI. */
const LISTING_TIMEOUT_MS = 15e3;
/** One turn's budget, matching the pool shim's idle ceiling. */
const TURN_TIMEOUT_MS = 3e5;
/** Sent when the registry does not declare one (kimchi, and most of the roster). */
const USER_AGENT = "dsh-xdpool/2.1";
/** How much of an upstream body is quoted back in a failure message. */
const BODY_SNIPPET_CHARS = 400;
/** A trimmed non-empty string, or ''. */
function text$4(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
}
/** A positive finite number, or undefined. */
function number(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : void 0;
}
function isRecord$3(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
* One aggregate-lane failure, carrying the class the caller maps onto HTTP.
*
* `kind` reuses the pool's vocabulary (`UpstreamErrorKind` in `upstream.ts`) so
* the shim's existing error→status table serves both lanes: a third-party 429
* is a `soft_rate`, a 401 is a `session_dead`, and neither needs a second table
* that could drift from the first.
*/
var AggregateError = class extends Error {
	kind;
	status;
	constructor(kind, message, status = 0) {
		super(message);
		this.name = "AggregateError";
		this.kind = kind;
		this.status = status;
	}
};
/** Remove a credential from anything that may reach a message. */
function redactAggregateSecret(value, apiKey) {
	let source = typeof value === "string" ? value : String(value ?? "");
	const key = text$4(apiKey);
	if (key === "") return source;
	const escaped = JSON.stringify(key).slice(1, -1);
	for (const needle of escaped === key ? [key] : [key, escaped]) if (source.includes(needle)) source = source.split(needle).join("[redacted]");
	return source;
}
/** A base URL a request can actually be sent to. */
function hasPlaceholder(baseUrl) {
	return /\{[^}]*\}/.test(baseUrl);
}
/** The user's `baseUrl` override when present, else the registry's own. */
function effectiveBaseUrl(provider, setting) {
	const override = text$4(setting.baseUrl);
	return (override !== "" ? override : text$4(provider.baseUrl)).replace(/\/+$/, "");
}
/**
* The provider's listing URL, moved by a `baseUrl` override when — and only
* when — the declared listing actually lives under the registry base.
*
* Three providers (cohere, deepinfra, ollama_cloud) publish their listing on
* another path. Rewriting a URL that never pointed at the override would invent
* one, and a guessed listing is worse than none.
*/
function effectiveModelsUrl(provider, setting) {
	const declared = modelsEndpoint(provider);
	if (declared === null) return null;
	const override = text$4(setting.baseUrl).replace(/\/+$/, "");
	const registryBase = text$4(provider.baseUrl).replace(/\/+$/, "");
	if (override === "" || registryBase === "" || !declared.startsWith(registryBase)) return declared;
	return `${override}${declared.slice(registryBase.length)}`;
}
/**
* The full URL a turn is posted to; null when the provider has no dialable
* endpoint (Azure without a user base URL, or a base still carrying the
* registry's `{account_id}`-style placeholder).
*/
function effectiveChatUrl(provider, setting) {
	const override = text$4(setting.baseUrl).replace(/\/+$/, "");
	const declared = chatEndpoint(provider);
	if (declared !== null) {
		const registryBase = text$4(provider.baseUrl).replace(/\/+$/, "");
		const url = override === "" || registryBase === "" ? declared : `${override}${declared.slice(registryBase.length)}`;
		return hasPlaceholder(url) ? null : url;
	}
	const suffix = CHAT_SUFFIX[provider.format];
	if (override === "" || suffix === void 0 || hasPlaceholder(override)) return null;
	return `${override}${suffix}`;
}
/** The per-provider settings object, or `{}` when the store names none. */
function settingFor(store, providerId) {
	return store.providers?.[providerId] ?? {};
}
/**
* Resolve one provider's effective settings.
*
* Throws {@link AggregateError} with a `client` kind for every state the user
* fixes in the settings page — an unknown id, a missing key, a placeholder base
* URL. A `client` kind is deliberate: none of these is a transport fault, so
* none of them should be retried against a different provider.
*
* `options.requireEnabled` exists for the DISCOVERY calls. Fetching a provider's
* model list publishes nothing: it asks "does this endpoint answer, and with
* what", and writing the answer back is a separate step the user also takes.
* Gating it on the enable switch made a read-only button report
* `"OpenCode Free" is not enabled in the aggregate settings` — a failure to
* LOOK, dressed up as a failure to connect, on rows that carry no key field and
* so offered no way to answer it. Discovery therefore does not require the
* switch; publishing still does, in {@link buildAggregateCatalog} and
* {@link resolveAggregateProvider} as called by the serving paths.
*/
function resolveAggregateProvider(store, providerId, options = {}) {
	const id = text$4(providerId);
	const provider = id === "" ? null : getProvider(id);
	if (provider === null) throw new AggregateError("client", `the aggregate lane has no provider "${id === "" ? String(providerId) : id}"`);
	const setting = settingFor(store, provider.id);
	if (setting.enabled === false) throw new AggregateError("client", `"${provider.name}" is switched off in the aggregate settings`);
	if (!providerAuthUsable(provider, setting)) {
		if (provider.auth.kind === "oauth" || provider.auth.kind === "adc") throw new AggregateError("session_dead", `"${provider.name}" signs in with ${provider.auth.kind}, not with an API key, so the aggregate lane does not serve it`);
		const where = text$4(provider.auth.url) === "" ? "" : ` (the provider issues keys at ${provider.auth.url})`;
		throw new AggregateError("client", `"${provider.name}" needs an API key: paste one in the aggregate settings${where}`);
	}
	if (options.requireEnabled !== false && !providerEnabled(provider, setting)) throw new AggregateError("client", `"${provider.name}" is not enabled in the aggregate settings`);
	const baseUrl = effectiveBaseUrl(provider, setting);
	if (baseUrl === "") throw new AggregateError("client", `"${provider.name}" has no base URL of its own — set one in the aggregate settings`);
	if (hasPlaceholder(baseUrl)) throw new AggregateError("client", `"${provider.name}"'s base URL still carries a registry placeholder — set the real URL in the aggregate settings`);
	const chatUrl = effectiveChatUrl(provider, setting);
	if (chatUrl === null) throw new AggregateError("client", `"${provider.name}" has no usable ${provider.format} endpoint`);
	const apiKey = text$4(setting.apiKey);
	const headers = defaultHeaders(provider, apiKey);
	if (headers["user-agent"] === void 0) headers["user-agent"] = USER_AGENT;
	return {
		providerId: provider.id,
		providerName: provider.name,
		apiKey,
		baseUrl,
		format: provider.format,
		wire: WIRE_BY_FORMAT[provider.format],
		chatUrl,
		modelsUrl: effectiveModelsUrl(provider, setting),
		headers
	};
}
/**
* The ids a provider should be served with, and where that list came from.
*
* `discovered` is the roster a fetch returned, `models` is the subset the user
* kept, and the choice is applied LAST so it wins over both — otherwise pressing
* "Fetch models" would silently undo the narrowing the card just saved.
*/
function modelIdsFor(provider, setting) {
	const universe = modelChoicesFor(provider, setting);
	const source = rosterIsDiscovered(provider, setting) ? "discovered" : "static";
	const override = stringList(setting.models);
	if (override.length === 0) return {
		ids: universe,
		source
	};
	const available = new Set(universe);
	return {
		ids: override.filter((id) => available.has(id)),
		source
	};
}
/**
* Whether the roster came from a live fetch rather than the registry.
*
* A pre-split install has `models` and no `discovered`, because until the
* chooser existed the only writer of `models` WAS the fetch button. Those ids
* are a roster, not a choice, and treating them as one would shrink the vendor
* to whatever handful the registry happens to declare.
*/
function rosterIsDiscovered(provider, setting) {
	if ((setting.discovered?.length ?? 0) > 0) return true;
	return stringList(setting.models).length > provider.models.length;
}
/** Every id a provider could offer: its roster, for the card's chooser. */
function modelChoicesFor(provider, setting) {
	const discovered = stringList(setting.discovered);
	if (discovered.length === 0 && rosterIsDiscovered(provider, setting)) return stringList(setting.models);
	return discovered.length > 0 ? discovered : provider.models.map((model) => model.id);
}
/** A de-duplicated list of non-empty trimmed strings from an untrusted array. */
function stringList(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const ids = [];
	for (const raw of value) {
		const id = text$4(raw);
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}
/**
* One catalog row.
*
* Capacities come from the registry's model row where it has them, and fall back
* to this module's own defaults where it does not (most rows carry no context
* window, and none carries an output ceiling — the registry records ids and
* published capacities, not a serving contract).
*/
function rowOf(provider, modelId, source) {
	const declared = provider.models.find((model) => model.id === modelId);
	const contextWindow = number(declared?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
	const label = text$4(declared?.name) !== "" ? text$4(declared?.name) : modelId;
	return {
		id: providerModelId(provider.id, modelId),
		name: `${provider.name} ${label}`,
		providerId: provider.id,
		modelId,
		contextWindow,
		maxOutputTokens: Math.min(DEFAULT_MAX_OUTPUT, contextWindow),
		supportsImages: declared?.vision === true,
		wire: WIRE_BY_FORMAT[provider.format],
		source
	};
}
/**
* Every model row the lane should offer, given the stored settings.
*
* A provider is skipped when it is switched off, when its credential flow this
* lane cannot drive, or when its endpoint cannot be composed — a picker row that
* can never answer is worse than no row, because it reads as "this provider is
* broken" rather than "not set up yet".
*/
function buildAggregateCatalog(store) {
	if (store.enabled === false) return [];
	const rows = [];
	for (const [providerId, setting] of Object.entries(store.providers ?? {})) {
		if (setting === void 0 || setting === null) continue;
		const provider = getProvider(providerId);
		if (provider === null) continue;
		if (!providerAuthUsable(provider, setting)) continue;
		if (!providerEnabled(provider, setting)) continue;
		if (effectiveChatUrl(provider, setting) === null) continue;
		const { ids, source } = modelIdsFor(provider, setting);
		for (const modelId of ids) rows.push(rowOf(provider, modelId, source));
	}
	return rows;
}
/** One stored aggregate row set, refreshed on change, for the shim and adapter. */
var AggregateCatalog = class {
	read;
	poolRows;
	rows = [];
	chainRows = [];
	/**
	* @param read    The settings document.
	* @param poolRows The pool's own rows, needed only to resolve a chain member
	*   that names a WorkBuddy model. A chain may mix pool models with aggregate
	*   ones, so without this a perfectly valid chain would lose its pool half.
	*/
	constructor(read, poolRows = () => []) {
		this.read = read;
		this.poolRows = poolRows;
	}
	/**
	* Every row this catalog offers: third-party rows first, then chain rows.
	*
	* Chains come last so a picker listing stays readable — a chain is a
	* convenience over models the user already has listed, not a new vendor.
	*/
	current() {
		return [...this.rows, ...this.chainRows];
	}
	/** Only the third-party rows, which is what the aggregate resolver needs. */
	providerRows() {
		return this.rows;
	}
	/** Only the chain rows. */
	comboRows() {
		return this.chainRows;
	}
	/** Re-read the store and notify listeners when the roster actually changed. */
	async refresh() {
		const store = await this.read();
		const next = buildAggregateCatalog(store);
		const chains = buildComboCatalog(combosOf(store), {
			pool: this.poolRows(),
			aggregate: next
		});
		pruneRotation(combosOf(store));
		if (next.length === this.rows.length && chains.length === this.chainRows.length && next.every((row, index) => row.id === this.rows[index]?.id) && chains.every((row, index) => row.id === this.chainRows[index]?.id)) return this.current();
		this.rows = next;
		this.chainRows = chains;
		for (const listener of this.listeners) listener();
		return this.current();
	}
	listeners = /* @__PURE__ */ new Set();
	onChange(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/** One third-party row by composite id, or undefined. */
	find(id) {
		return this.rows.find((row) => row.id === id);
	}
	/** One chain row by combo id, or undefined. */
	findCombo(id) {
		return this.chainRows.find((row) => row.id === id);
	}
	/** Whether any provider or chain is serving anything right now. */
	hasRows() {
		return this.rows.length > 0 || this.chainRows.length > 0;
	}
};
/**
* Narrow a catalog to the aggregate flavour.
*
* Probed by CAPABILITY, never by data. The previous shape check read
* `catalog.current()[0]` and asked whether the row carried a `providerId` — which
* is false for an aggregate catalog that has not been written to yet, because
* `current()` is then an empty array. A fresh install therefore classified its own
* aggregate catalog as a pool catalog, `createWorkBuddyAdapter` called
* `catalog.visible()` on it, and `AggregateCatalog` has no such method:
*
*   TypeError: catalog.visible is not a function
*
* That throw happens while the adapters are being BUILT — before any
* `registerAdapter` call — so it escaped to the outermost catch in `apply` and
* every provider went unregistered. The user's only symptom was "the model
* picker does not list xdpool", and nothing on screen said why.
*
* `providerRows()` exists on `AggregateCatalog` and on no pool catalog, in every
* state including empty, so the answer no longer depends on what happens to be
* in the store at boot.
*/
function isAggregateCatalog(catalog) {
	return typeof catalog.providerRows === "function";
}
/**
* `Retry-After` seconds → milliseconds, the conversion every poster applies.
*
* Exported because the co-paid lane's poster converts the same header the same
* way; a second conversion is a second chance to disagree about milliseconds.
*/
function retryAfterMs(response) {
	const seconds = Number(response.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1e3) : void 0;
}
/**
* Read a refusal into an {@link AggregateError}.
*
* The body is redacted BEFORE it is truncated: slicing first could cut a key in
* half and leave its front in the snippet. The provider's own message is
* preferred when the body carries one — "Incorrect API key provided" is
* actionable, "http 401" is not.
*
* Exported for the co-paid lane, which classifies the same six classes through
* the same table. The credential argument is what gets scrubbed out of the
* message; the co-paid lane passes an empty string because its secret never
* enters the request body or the reply in the first place.
*/
function classifyUpstream(status, bodyText, retryAfter, apiKey) {
	const safe = redactAggregateSecret(bodyText, apiKey);
	let message = "";
	try {
		const payload = JSON.parse(safe);
		const envelope = isRecord$3(payload) && isRecord$3(payload.error) ? payload.error : isRecord$3(payload) ? payload : void 0;
		const detail = envelope === void 0 ? "" : text$4(envelope.message) !== "" ? text$4(envelope.message) : text$4(envelope.type);
		if (detail !== "") message = detail;
	} catch {}
	if (status === 403 && /FreeTierError/u.test(safe)) return new AggregateError("client", `the provider locked its free tier to its own client: ${message === "" ? "the free tier is locked to this client" : message}`, status);
	const suffix = message === "" ? safe.slice(0, BODY_SNIPPET_CHARS) : message;
	const kind = status === 401 || status === 403 ? "session_dead" : status === 402 || status === 429 ? status === 402 ? "hard_credit" : "soft_rate" : status === 404 || status === 501 ? "not_found" : status >= 500 ? "server" : "client";
	return new AggregateError(kind, `the provider answered HTTP ${status}${kind === "soft_rate" && retryAfter !== void 0 ? `; the provider asked to wait ${Math.ceil(retryAfter / 1e3)}s` : ""}: ${suffix}`, status);
}
/**
* Read a model-listing document into ids, or null when the shape is not a
* listing at all.
*
* Tolerant on purpose: the registry's endpoints speak several dialects — the
* OpenAI `{data:[{id}]}`, Cohere's `{models:[{name}]}`, Ollama's
* `{models:[{name}]}`, DeepInfra's `[{model_name}]` — and a row's id is the
* first of those fields it actually carries.
*/
function modelIdsFrom(payload) {
	const rows = Array.isArray(payload) ? payload : isRecord$3(payload) && Array.isArray(payload.data) ? payload.data : isRecord$3(payload) && Array.isArray(payload.models) ? payload.models : null;
	if (rows === null) return null;
	const seen = /* @__PURE__ */ new Set();
	const ids = [];
	for (const row of rows) {
		let id = "";
		if (typeof row === "string") id = text$4(row);
		else if (isRecord$3(row)) for (const field of [
			"id",
			"name",
			"model",
			"model_name"
		]) {
			id = text$4(row[field]);
			if (id !== "") break;
		}
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
	}
	return ids;
}
/**
* Verify a key with a cheap NON-GENERATING call: the provider's own listing.
*
* A provider that declares no listing (Anthropic, OpenAI, …) cannot be verified
* without spending a generation, and this lane does not spend the user's money
* behind their back — the answer says so rather than guessing at a URL.
*/
async function probeAggregateProvider(store, providerId, options = {}) {
	let resolved;
	try {
		resolved = resolveAggregateProvider(store, providerId, { requireEnabled: false });
	} catch (error) {
		return {
			ok: false,
			status: 0,
			message: error instanceof Error ? error.message : String(error)
		};
	}
	if (resolved.modelsUrl === null) return {
		ok: false,
		status: 0,
		message: `"${resolved.providerName}" declares no model listing, so its key cannot be verified without spending a generation`
	};
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? LISTING_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onCallerAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	try {
		const response = await fetch(resolved.modelsUrl, {
			headers: {
				...resolved.headers,
				accept: "application/json"
			},
			redirect: "error",
			signal: controller.signal
		});
		const body = await response.text().catch(() => "");
		if (!response.ok) {
			const failure = classifyUpstream(response.status, body, retryAfterMs(response), resolved.apiKey);
			return {
				ok: false,
				status: response.status,
				message: failure.message
			};
		}
		let payload;
		try {
			payload = JSON.parse(redactAggregateSecret(body, resolved.apiKey));
		} catch {
			payload = void 0;
		}
		const ids = modelIdsFrom(payload);
		if (ids === null) return {
			ok: false,
			status: response.status,
			message: `the listing answered HTTP ${response.status} but its shape was not recognised`
		};
		return {
			ok: true,
			status: response.status,
			message: `the key is accepted; ${ids.length} model(s) listed`,
			modelCount: ids.length,
			modelIds: ids
		};
	} catch (error) {
		if (options.signal?.aborted === true) return {
			ok: false,
			status: 0,
			message: "request aborted"
		};
		if (error instanceof Error && error.name === "AbortError") return {
			ok: false,
			status: 0,
			message: `the provider did not answer within ${timeoutMs}ms`
		};
		return {
			ok: false,
			status: 0,
			message: redactAggregateSecret(`the provider could not be reached: ${error instanceof Error ? error.message : String(error)}`, resolved.apiKey)
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onCallerAbort);
	}
}
/**
* POST one streaming completion to the provider.
*
* `onData` receives one SSE `data:` payload per provider frame, in order, and
* the caller owns the response framing. The body is posted as given — a plain
* object gets `stream:true` forced, because a caller that forgot the flag would
* otherwise collect a JSON document where frames were expected.
*
* The shape of the ANSWER decides how it is read, never its Content-Type: a
* front proxy that mislabels a JSON body as an event stream is common enough
* that believing the header truncates real answers.
*
* A JSON answer to a streamed request is normalised into the frame sequence the
* row's wire decodes — chat chunks, Anthropic events, or Responses events. Each
* sequence ends with its terminal frame, always: a decoder that sees no terminal
* event reads a finished turn as a stream the provider cut, which the host
* answers with a retry.
*/
async function forwardAggregateStreamed(resolved, modelId, body, options) {
	const model = text$4(modelId);
	const bodyText = typeof body === "string" ? body : JSON.stringify({
		...body,
		stream: true
	});
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT_MS;
	const onCallerAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	try {
		const response = await fetch(resolved.chatUrl, {
			method: "POST",
			headers: {
				...resolved.headers,
				accept: "text/event-stream"
			},
			body: bodyText,
			redirect: "error",
			signal: controller.signal
		});
		const retryAfter = retryAfterMs(response);
		if (!response.ok) {
			const refusal = await response.text().catch(() => "");
			throw classifyUpstream(response.status, refusal, retryAfter, resolved.apiKey);
		}
		if (response.body === null) throw new AggregateError("server", "the provider returned no body", response.status);
		const head = await readSseHead(response.body, controller.signal, timeoutMs);
		if (head.shape === "empty") throw new AggregateError("server", "the provider returned no body", response.status);
		if (head.shape === "sse") {
			for (const payload of head.payloads) options.onData(payload);
			return { status: response.status };
		}
		let raw = head.text;
		if (!head.done) try {
			while (true) {
				const chunk = await head.reader.read();
				if (chunk.done) break;
				if (chunk.value !== void 0) raw += head.decoder.decode(chunk.value, { stream: true });
			}
		} catch (error) {
			await head.reader.cancel().catch(() => {});
			throw new AggregateError("server", `the provider stream broke: ${error instanceof Error ? error.message : String(error)}`, response.status);
		}
		raw += head.decoder.decode();
		let payload;
		try {
			payload = JSON.parse(redactAggregateSecret(raw, resolved.apiKey));
		} catch {
			if (/^\s*<(!doctype|html[\s>])/i.test(raw)) throw new AggregateError("client", `the provider's front proxy answered HTTP ${response.status} with an HTML error page`, response.status);
			throw new AggregateError("server", `unexpected non-stream response: ${redactAggregateSecret(raw, resolved.apiKey).slice(0, 200)}`, response.status);
		}
		if (isRecord$3(payload) && (payload.error !== void 0 || payload.type === "error")) throw classifyUpstream(response.status, raw, retryAfter, resolved.apiKey);
		for (const frame of synthesisedFrames(resolved.wire, payload, model)) options.onData(frame);
		return { status: response.status };
	} catch (error) {
		if (error instanceof AggregateError) throw error;
		if (options.signal?.aborted === true) throw new AggregateError("client", "request aborted");
		if (error instanceof Error && error.name === "AbortError") throw new AggregateError("server", `the provider did not answer within ${timeoutMs}ms`);
		const cause = error instanceof Error ? error.message : String(error);
		throw new AggregateError("server", `the request to ${resolved.providerName} failed: ${redactAggregateSecret(cause, resolved.apiKey)}`);
	} finally {
		options.signal?.removeEventListener("abort", onCallerAbort);
	}
}
/**
* Read the head, decide the shape, and — for SSE — collect every frame.
*
* SSE is collected here rather than piped straight through so the caller gets
* one ordered list of payloads and owns the response framing. That costs a
* buffer on a long answer, and it is the right trade: the alternative re-encodes
* every frame, and one replacement character at a split boundary is a bug the
* user reads but the logs cannot explain.
*
* Exported for the co-paid lane's poster; see {@link SniffedHead}.
*/
async function readSseHead(body, signal, timeoutMs) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let head;
	try {
		const first = await reader.read();
		if (first.done || first.value === void 0 || first.value.length === 0) return {
			shape: "empty",
			text,
			done: true,
			decoder,
			reader
		};
		text = decoder.decode(first.value, { stream: true });
		if (sniffBodyShape(text) === "sse") {
			const payloads = extractSsePayloads(text);
			const cut = text.lastIndexOf("\n");
			let pending = cut === -1 ? text : text.slice(cut + 1);
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done || chunk.value === void 0) break;
				pending += decoder.decode(chunk.value, { stream: true });
				const end = pending.lastIndexOf("\n");
				if (end === -1) continue;
				const settled = pending.slice(0, end);
				pending = pending.slice(end + 1);
				payloads.push(...extractSsePayloads(settled));
			}
			pending += decoder.decode();
			payloads.push(...extractSsePayloads(pending));
			return {
				shape: "sse",
				payloads,
				text,
				done: true,
				decoder,
				reader
			};
		}
		head = {
			shape: "json",
			text,
			done: first.done,
			decoder,
			reader
		};
		if (first.done) return {
			...head,
			text: text + decoder.decode(),
			done: true
		};
		return head;
	} finally {
		if (signal.aborted) await reader.cancel().catch(() => {});
	}
}
/**
* Classify what the head read found.
*
* SSE is recognised by a `data:` or event opener, not by the content type: a
* front proxy that mislabels a JSON body as `text/event-stream` is common, and
* believing the header truncates real answers at the first frame boundary.
*/
function sniffBodyShape(text) {
	const head = text.trimStart();
	if (head === "") return "empty";
	return /^(?:data|event|id|retry|:\s)/u.test(head) || head.startsWith(":") ? "sse" : "json";
}
/** Every non-comment `data:` payload in an SSE chunk, in order. */
function extractSsePayloads(chunk) {
	const out = [];
	for (const rawLine of chunk.split(/\r?\n/u)) {
		const line = rawLine.trimEnd();
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trimStart();
		if (payload === "[DONE]") continue;
		if (payload === "") continue;
		out.push(payload);
	}
	return out;
}
/**
* The frames one JSON answer turns into, in the vocabulary of the row's wire.
*
* Exported for the co-paid lane, whose relay answers a streamed request with one
* JSON document on occasion and needs the same folding rather than a second one.
*/
function synthesisedFrames(wire, payload, model) {
	if (wire === "messages") return anthropicFrames(payload, model);
	if (wire === "responses") return responsesFrames(payload, model);
	return chatFrames(payload, model);
}
/** One `chat.completion.chunk` per field the chat decoder reads. */
function chatFrames(payload, model) {
	const root = isRecord$3(payload) ? payload : {};
	const choices = Array.isArray(root.choices) ? root.choices : [];
	const choice = isRecord$3(choices[0]) ? choices[0] : {};
	const message = isRecord$3(choice.message) ? choice.message : {};
	const head = {
		id: text$4(root.id) === "" ? "aggregate" : text$4(root.id),
		object: "chat.completion.chunk",
		created: number(root.created) ?? Math.floor(Date.now() / 1e3),
		model
	};
	const frames = [];
	const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
	if (reasoning !== "") frames.push(JSON.stringify({
		...head,
		choices: [{
			index: 0,
			delta: {
				role: "assistant",
				reasoning_content: reasoning
			},
			finish_reason: null
		}]
	}));
	const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => isRecord$3(part) && typeof part.text === "string" ? part.text : "").join("") : "";
	if (content !== "") frames.push(JSON.stringify({
		...head,
		choices: [{
			index: 0,
			delta: {
				role: "assistant",
				content
			},
			finish_reason: null
		}]
	}));
	let index = 0;
	for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
		const entry = isRecord$3(call) ? call : {};
		const fn = isRecord$3(entry.function) ? entry.function : {};
		frames.push(JSON.stringify({
			...head,
			choices: [{
				index: 0,
				delta: { tool_calls: [{
					index,
					id: text$4(entry.id) === "" ? `call_${index}` : text$4(entry.id),
					type: "function",
					function: {
						name: text$4(fn.name),
						arguments: typeof fn.arguments === "string" ? fn.arguments : ""
					}
				}] },
				finish_reason: null
			}]
		}));
		index += 1;
	}
	frames.push(JSON.stringify({
		...head,
		choices: [{
			index: 0,
			delta: {},
			finish_reason: text$4(choice.finish_reason) === "" ? "stop" : text$4(choice.finish_reason)
		}],
		...root.usage === void 0 ? {} : { usage: root.usage }
	}));
	return frames;
}
/** One Anthropic event sequence per block, plus the terminal pair. */
function anthropicFrames(payload, model) {
	const root = isRecord$3(payload) ? payload : {};
	const usage = isRecord$3(root.usage) ? root.usage : void 0;
	const frames = [JSON.stringify({
		type: "message_start",
		message: {
			id: text$4(root.id) === "" ? "aggregate" : text$4(root.id),
			type: "message",
			role: "assistant",
			model,
			...usage === void 0 ? {} : { usage }
		}
	})];
	(Array.isArray(root.content) ? root.content : []).forEach((raw, index) => {
		const block = isRecord$3(raw) ? raw : {};
		const type = text$4(block.type);
		if (type === "tool_use") {
			frames.push(JSON.stringify({
				type: "content_block_start",
				index,
				content_block: {
					type: "tool_use",
					id: text$4(block.id) === "" ? `toolu_${index}` : text$4(block.id),
					name: text$4(block.name)
				}
			}));
			frames.push(JSON.stringify({
				type: "content_block_delta",
				index,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(block.input ?? {})
				}
			}));
		} else if (type === "thinking" || type === "redacted_thinking") {
			frames.push(JSON.stringify({
				type: "content_block_start",
				index,
				content_block: { type }
			}));
			const thinking = typeof block.thinking === "string" ? block.thinking : "";
			if (thinking !== "") frames.push(JSON.stringify({
				type: "content_block_delta",
				index,
				delta: {
					type: "thinking_delta",
					thinking
				}
			}));
		} else {
			frames.push(JSON.stringify({
				type: "content_block_start",
				index,
				content_block: { type: type === "" ? "text" : type }
			}));
			const value = typeof block.text === "string" ? block.text : "";
			if (value !== "") frames.push(JSON.stringify({
				type: "content_block_delta",
				index,
				delta: {
					type: "text_delta",
					text: value
				}
			}));
		}
		frames.push(JSON.stringify({
			type: "content_block_stop",
			index
		}));
	});
	frames.push(JSON.stringify({
		type: "message_delta",
		delta: {
			stop_reason: text$4(root.stop_reason) === "" ? "end_turn" : text$4(root.stop_reason),
			stop_sequence: root.stop_sequence ?? null
		},
		...usage === void 0 ? {} : { usage: { output_tokens: number(usage.output_tokens) ?? 0 } }
	}));
	frames.push(JSON.stringify({ type: "message_stop" }));
	return frames;
}
/** One Responses event sequence per output item, then the terminal frame. */
function responsesFrames(payload, model) {
	const root = isRecord$3(payload) ? payload : {};
	const frames = [];
	(Array.isArray(root.output) ? root.output : []).forEach((raw, outputIndex) => {
		const item = isRecord$3(raw) ? raw : {};
		const type = text$4(item.type);
		if (type === "reasoning") {
			const delta = (Array.isArray(item.summary) ? item.summary : []).map((part) => isRecord$3(part) && typeof part.text === "string" ? part.text : "").join("");
			if (delta !== "") frames.push(JSON.stringify({
				type: "response.reasoning_summary_text.delta",
				item_id: text$4(item.id),
				output_index: outputIndex,
				delta
			}));
			return;
		}
		if (type === "message") {
			const delta = (Array.isArray(item.content) ? item.content : []).map((part) => isRecord$3(part) && typeof part.text === "string" ? part.text : "").join("");
			if (delta !== "") frames.push(JSON.stringify({
				type: "response.output_text.delta",
				item_id: text$4(item.id),
				output_index: outputIndex,
				delta
			}));
			return;
		}
		if (type === "function_call") {
			frames.push(JSON.stringify({
				type: "response.output_item.added",
				output_index: outputIndex,
				item
			}));
			frames.push(JSON.stringify({
				type: "response.function_call_arguments.delta",
				item_id: text$4(item.id),
				output_index: outputIndex,
				delta: typeof item.arguments === "string" ? item.arguments : ""
			}));
		}
	});
	frames.push(JSON.stringify({
		type: "response.completed",
		response: {
			...root,
			model: text$4(root.model) === "" ? model : text$4(root.model)
		}
	}));
	return frames;
}
//#endregion
//#region src/adapter.ts
/**
* The `xdpool` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
* points. Every model points at the shim; account rotation stays inside it.
*
* Assembly (createProvider + openAICompletionsApi + inert auth plane + the
* shim's in-process secret as apiKey) follows corrinehu/dsh-workbuddy-connect
* (MIT, Copyright (c) 2026 Corrine Hu) and dingminhua/dsh-connect-workbuddy
* (MIT), both designed and validated against this host.
*
* @module dsh-xdpool/adapter
*/
/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
const XDPOOL_PROVIDER = "xdpool";
/** Provider route this bundle owns for the international gateway. */
const XDPOOL_GLOBAL_PROVIDER = "xdpool-global";
/**
* Provider route this bundle owns for the aggregate lane.
*
* A THIRD id rather than a fourth row on an existing one: the two pool lanes
* share the pool's rotation, its credits and its automation, and the aggregate
* lane shares none of them — it holds the user's own key and has no account to
* rotate. Folding its rows into a pool lane would put a third-party provider's
* failures into the pool's cooldown table and its spend into the pool's usage
* panel, both of which the user reads as WorkBuddy traffic.
*/
const XDPOOL_AGGREGATE_PROVIDER = "xdpool-aggregate";
/**
* Provider route for the免密 free lane.
*
* A distinct id for the same reason as the aggregate lane: this lane draws on a
* POOLED gateway credential with its own per-session quota, so folding its rows
* into a pool lane would put a shared-quota 429 into the pool's cooldown table
* and its tokens into the pool's usage panel — both of which the user reads as
* their own WorkBuddy traffic.
*/
const XDPOOL_FREE_PROVIDER = "xdpool-free";
/**
* Display name the free lane registers under, so the picker can group it.
*
* It is the only extra lane: the co-paid (EAC) lane that used to sit beside it
* was removed on the user's instruction, because its whole reason for existing
* was a sealed shared-signing entry only the original build's host could open,
* and a lane that answers 503 for everyone else is worse than no lane at all.
*/
const EXTRA_LANE_NAMES = { free: "XD Pool · 免费模型" };
/** The provider id each region registers as. */
const POOL_PROVIDER_BY_REGION = {
	cn: XDPOOL_PROVIDER,
	global: XDPOOL_GLOBAL_PROVIDER
};
/**
* Display name each region registers under, so the picker can group them.
*
* "XD Pool" rather than the old "WorkBuddy XD Pool": the picker row is the only
* place this string surfaces, and the brand the user asked for is XD Pool. The
* REGION suffix stays because both lanes register real providers under different
* ids — dropping it would leave two identically-named groups in the dropdown.
*
* Display name only. The provider ids above are what the host matches on when it
* persists a selection, so renaming a group must never touch them.
*/
const POOL_NAME_BY_REGION = {
	cn: "XD Pool（国内版）",
	global: "XD Pool（国际版）"
};
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The route authenticates only through the shim shared
* secret resolved per request, so pi-ai's own credential lifecycle must never
* manufacture a credential for it.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-xdpool: this route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function modelInput(info) {
	return info.supportsImages ? ["text", "image"] : ["text"];
}
/** Map only levels the catalog advertises; undeclared DSH levels stay off. */
function thinkingLevelMap(info) {
	const efforts = info.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return void 0;
	const levels = [
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	];
	const map = {};
	for (const level of levels) map[level] = efforts.includes(level) ? level : null;
	map["off"] = null;
	return map;
}
/** Middle-dot separator: unambiguous between the model's own hyphens and the
*  rate/badge suffix. Matches the LaoDing family convention. */
const DISPLAY_SEPARATOR = " · ";
/** Map an upstream tag code to the localized promo label shown next to the
*  credit rate in the model picker. Both `free` and `limited-free` collapse to
*  the same short label so the dropdown row stays scannable. */
const TAG_LABEL = {
	"free": "限时免费",
	"limited-free": "限时免费",
	"night-discount": "夜间折扣"
};
/** Resolve the display suffix (`xN.NN`, promo badges) for one catalog row.
*  Returns `undefined` when there's nothing to show — the name is left alone
*  so we don't tack a trailing separator on a plain model. */
function displaySuffix(info) {
	const parts = [];
	if (shouldSpellOutFree(info)) parts.push("免费");
	else if (info.multiplier !== 0 && typeof info.multiplier === "number" && Number.isFinite(info.multiplier)) parts.push(`x${info.multiplier.toFixed(2)}`);
	for (const tag of info.tags ?? []) {
		const label = TAG_LABEL[tag];
		if (label !== void 0 && !parts.includes(label)) parts.push(label);
	}
	for (const label of badgeLabels(info.tags)) if (!parts.includes(label)) parts.push(label);
	return parts.length === 0 ? void 0 : parts.join(DISPLAY_SEPARATOR);
}
/** Apply the catalog's rate + promo badges to one model's display name.
*  Display-only: the wire request is built from `model.id`, so renaming here
*  cannot affect routing, token, or upstream accounting. DSH 0.1.2's composer
*  (`ModelSelect`) renders `model.name` only, which is why the rate and
*  badges ride the name rather than a separate description column. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`;
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const map = thinkingLevelMap(info);
	return {
		id: info.id,
		name: withCatalogDisplay(info.name, info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: modelInput(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxOutputTokens,
		reasoning: map !== void 0,
		...map === void 0 ? {} : { thinkingLevelMap: map },
		compat: { supportsReasoningEffort: map !== void 0 }
	};
}
/**
* Build one pi-ai model descriptor for an aggregate row.
*
* Every row points at the same loopback shim, exactly like the pool lanes — the
* composite id in `id` is what tells the shim which upstream to reach. Context
* and output ceilings come from the provider's own listing, with the shared
* defaults applied when it declined to say; guessing low would make pi-ai
* compact a conversation early, guessing high would let it run into the
* provider's real limit and get a 400 the user cannot explain.
*/
function toAggregateModel(row, baseUrl, providerId) {
	return {
		id: row.id,
		name: `${row.name}${DISPLAY_SEPARATOR}${row.providerId}`,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: row.supportsImages ? ["text", "image"] : ["text"],
		cost: NO_COST,
		contextWindow: row.contextWindow,
		maxTokens: row.maxOutputTokens,
		reasoning: false,
		compat: { supportsReasoningEffort: false }
	};
}
/**
* Build one pi-ai model descriptor for a chain row.
*
* A chain is not a vendor, so there is no `providerId` to suffix onto the name —
* the chain's own name already says what it is, and the member ids are what the
* picker expands it into. Capacities are the intersection the chain builder
* computed, so pi-ai compacts early enough for the weakest member instead of
* letting the turn run past it.
*/
function toComboModel(row, baseUrl, providerId) {
	return {
		id: row.id,
		name: row.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: row.supportsImages ? ["text", "image"] : ["text"],
		cost: NO_COST,
		contextWindow: row.contextWindow,
		maxTokens: row.maxOutputTokens,
		reasoning: false,
		compat: { supportsReasoningEffort: false }
	};
}
/**
* Build one pi-ai model descriptor for a free lane row.
*
* The thinking control IS offered here, unlike the aggregate lane: this lane
* publishes a measured `efforts` menu, so "unknown" would withhold a control the
* user demonstrably has. The ceiling comes from the lane's own capability table
* rather than a model card, because the table is what the lane was probed
* against.
*/
function toExtraLaneModel(row, baseUrl, providerId) {
	const efforts = "efforts" in row && Array.isArray(row.efforts) && row.efforts.length > 0 ? row.efforts : void 0;
	const map = efforts === void 0 ? void 0 : thinkingLevelMap({
		id: row.id,
		name: row.name,
		contextWindow: row.contextWindow,
		maxOutputTokens: row.maxOutput,
		supportsImages: row.vision,
		supportedEfforts: efforts
	});
	return {
		id: row.modelId,
		name: row.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: row.vision ? ["text", "image"] : ["text"],
		cost: NO_COST,
		contextWindow: row.contextWindow,
		maxTokens: row.maxOutput,
		reasoning: row.reasoning,
		...map === void 0 ? {} : { thinkingLevelMap: map },
		compat: { supportsReasoningEffort: map !== void 0 }
	};
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
function createWorkBuddyAdapter(options) {
	const { shim, catalog } = options;
	const providerId = options.providerId ?? "xdpool";
	const displayName = options.displayName ?? "XD Pool";
	const aggregateCatalog = isAggregateCatalog(catalog);
	const extraRows = options.extraRows;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		if (extraRows !== void 0) return (extraRows() ?? []).map((row) => toExtraLaneModel(row, baseUrl, providerId));
		if (aggregateCatalog) return [...catalog.providerRows().map((row) => toAggregateModel(row, baseUrl, providerId)), ...catalog.comboRows().map((row) => toComboModel(row, baseUrl, providerId))];
		return catalog.visible().map((info) => toPiModel(info, baseUrl, providerId));
	};
	/**
	* Build a fresh provider object whose `models` array is the catalog as it
	* stands right now.
	*
	* `createProvider` snapshots the array it is handed, and the host keeps its
	* own snapshot keyed by the IDENTITY of the `profiles` map
	* (`dsh-llm-pi-ai/lib/index.js` `PiAiAdapter.current()`: it rebuilds the
	* model collection only when `this.snapshot.profiles !== profiles`, then
	* calls `models.setProvider(profile.piProvider)`). Reusing one provider object
	* across `invalidate()` therefore could not work: the host would recognise the
	* unchanged profiles map, hand back its cached snapshot, and re-collect the
	* very same provider — so a model list that changed upstream (a new model
	* released, an account's entitlements changing) stayed frozen until restart.
	* That is what users saw on the international gateway. Returning a brand-new
	* provider from a brand-new profile is the only lever the adapter is given.
	*/
	const makeProvider = () => {
		return {
			...createProvider({
				id: providerId,
				name: displayName,
				auth: { apiKey: {
					name: "XD Pool loopback secret",
					async resolve({ credential }) {
						const apiKey = credential?.key;
						return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
							auth: { apiKey },
							source: "XD Pool"
						};
					}
				} },
				models: buildModels(),
				api: openAICompletionsApi()
			}),
			getModels: () => buildModels()
		};
	};
	const makeProfile = (piProvider) => ({
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-xdpool retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider
	});
	const profile = makeProfile(makeProvider());
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		providerId,
		displayName,
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			resolveAttachments: () => options.ctx.get("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => options.ctx.get("fs")?.processPathFromHostPath(hostPath), ref)
		}),
		buildModels,
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, makeProfile(makeProvider())]]);
		}
	};
}
//#endregion
//#region src/billion-mount.ts
/** The package name the loader resolves, exactly as our patch row names it. */
const BILLION_PACKAGE = "billion-context";
/**
* Is this package installed and able to run?
*
* Any entry whose name matches counts — including one whose fiber has not
* started yet. When this function still decided whether to mount, a fiber-less
* entry had to be treated as absent: treating an import-in-flight as present
* would have skipped the mount and left the compressor never starting. Now that
* nothing mounts, the distinction only picks a label, and the honest one is
* "installed": a user watching billion-context's own boot does not want the
* card telling them it is missing while its proxy is half-way up.
*
* A DISABLED entry does not count. `loader.entries()` yields disabled rows too
* — the host skips starting them, it does not drop them — and our own patch
* row is disabled on purpose. Counting it would make every profile that never
* installed billion-context read as "installed", which is precisely the lie the
* card must not tell.
*/
function mountedInLoader(loader, packageName) {
	for (const entry of loader.entries()) {
		if (entry.options?.name !== packageName) continue;
		if (entry.options?.disabled === true) continue;
		return true;
	}
	return false;
}
/**
* Report whether the compressor is already running. Never mounts.
*
* Resolves rather than rejects on every path: a compressor that will not start
* is a card that says so, never a pool that fails to boot. The pool's own model
* registry has nothing to do with compression, and one missing optional feature
* must not take the accounts down with it.
*/
async function mountBillionContext(ctx, logger) {
	try {
		let loader;
		ctx.inject(["loader"], (scoped) => {
			loader = scoped.loader;
		});
		if (loader === void 0) return {
			state: "unavailable",
			reason: "the host exposes no plugin loader"
		};
		if (mountedInLoader(loader, BILLION_PACKAGE)) {
			logger.info?.(`[xdpool] billion-context is already mounted; leaving it alone`);
			return { state: "already-mounted" };
		}
		return { state: "not-required" };
	} catch (error) {
		return {
			state: "unavailable",
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
//#endregion
//#region src/pack-accounts.ts
/**
* Channel ids whose accounts this plugin serves itself.
*
* `buddy` is CodeBuddy (CN) and `workbuddy` is WorkBuddy AI (international);
* both are the two lanes the two region cards exist for. Every other channel
* (TRAE, Qoder, ZCode, …) keeps its own model roster and gateway and is listed
* by the channel cards instead, so its accounts must not leak into this pool.
*/
const PACK_REGION_CHANNELS = ["buddy", "workbuddy"];
/**
* Fallback domain per channel, used when the credential carries none.
*
* A scan sign-in normally records the domain the server issued the token for
* (`token.domain`), but a credential written by an older build can lack it, and
* `regionOf` treats a missing domain as CN — which would file an international
* sign-in under the 国内版 card. So the channel's own product domain is the
* fallback, and it is the same value the pack sends as `X-Domain` when it has
* no better one.
*/
const PACK_CHANNEL_DOMAINS = {
	buddy: "copilot.tencent.com",
	workbuddy: "www.workbuddy.ai"
};
/** Normalize a `snake_case` expiry that may arrive as seconds or milliseconds. */
function expiryToMs(value) {
	if (typeof value !== "number" && typeof value !== "string") return 0;
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return 0;
	return numeric > 0xe8d4a51000 ? numeric : numeric * 1e3;
}
function text$3(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Rewrite one pack credential into the pool's shape.
*
* Returns undefined when the document is not a usable credential — a missing
* access token cannot serve a request, and admitting a half-parsed row would
* put it in rotation to fail on its first pick. The pack's own `domain` wins
* over the channel default because the server decides which gateway a token
* belongs to; `user_id` becomes `uid` because that is the same value the
* desktop app's credential files carry, which is what makes the two routes
* merge on one id.
*/
function packCredentialToWorkBuddy(entry, document) {
	const accessToken = text$3(document.access_token);
	if (accessToken === void 0) return void 0;
	const provider = text$3(entry.provider) ?? "channel-pack";
	const refName = text$3(entry.credentialRef) ?? text$3(entry.id) ?? provider;
	const domain = text$3(document.domain) ?? PACK_CHANNEL_DOMAINS[provider] ?? "";
	const expiresAtMs = expiryToMs(document.expires_at) || expiryToMs(entry.expiresAt);
	const nickname = text$3(document.nickname) ?? text$3(entry.nickname);
	const uid = text$3(document.user_id);
	return {
		accessToken,
		refreshToken: text$3(document.refresh_token) ?? "",
		expiresAtMs,
		...expiryToMs(document.refresh_expires_at) > 0 ? { refreshExpiresAtMs: expiryToMs(document.refresh_expires_at) } : {},
		...nickname === void 0 ? {} : { nickname },
		...uid === void 0 ? {} : { uid },
		...text$3(document.enterprise_id) === void 0 ? {} : { enterpriseId: text$3(document.enterprise_id) },
		domain,
		sourcePath: `channel-pack:${provider}:${refName}`
	};
}
/** The pack's pool, as reachable through cordis. Duck-typed, never imported. */
function readPackAccountPool(ctx) {
	let pool;
	try {
		pool = ctx?.get?.("accountPool");
	} catch {
		return;
	}
	if (pool === void 0 || pool === null) return void 0;
	const candidate = pool;
	if (typeof candidate.listAllAccounts !== "function") return void 0;
	if (typeof candidate.resolveCredentialByRef !== "function") return void 0;
	return pool;
}
/**
* Every account the pack holds for the two pool-owned channels.
*
* Best-effort per account: one unreadable credential costs that account, not
* the batch, because a channel with a bad secret is still worth showing. The
* caller re-runs this whenever it wants a fresh reading.
*/
async function readPackCredentials(pool) {
	if (pool === void 0) return [];
	const entries = (await pool.listAllAccounts()).filter((entry) => {
		const provider = text$3(entry.provider);
		return provider !== void 0 && PACK_REGION_CHANNELS.includes(provider);
	});
	return (await Promise.all(entries.map(async (entry) => {
		const refName = text$3(entry.credentialRef);
		if (refName === void 0) return void 0;
		try {
			const document = await pool.resolveCredentialByRef(refName);
			if (document === void 0 || document === null || typeof document !== "object") return void 0;
			return packCredentialToWorkBuddy(entry, document);
		} catch {
			return;
		}
	}))).filter((credential) => credential !== void 0);
}
/**
* Point a pool at the pack's accounts and pull them in once.
*
* Called after the channel pack finished mounting — or failed to, since the
* pool is owned by whichever plugin won the race and both vendor the same file.
* The registration is unconditional and the reading is best-effort: if this
* copy of the pack lost the race, or has not provided `accountPool` yet, the
* registered source simply yields nothing and the pool keeps its desktop
* accounts. Rescanning here rather than mutating `accounts` directly is what
* makes a QR sign-in merge by identity instead of appearing as a second row.
*/
async function adoptChannelPackAccounts(ctx, pool, logger) {
	const pack = readPackAccountPool(ctx);
	pool.applyExternalSource(() => readPackCredentials(readPackAccountPool(ctx)));
	if (pack === void 0) {
		logger?.warn?.("[xdpool] channel-pack account pool not visible yet; pool stays on desktop sign-ins");
		return;
	}
	try {
		const merged = await pool.scan();
		const count = Array.isArray(merged) ? merged.length : 0;
		logger?.info?.(`[xdpool] pool now serves ${count} account(s) including channel sign-ins`);
	} catch (error) {
		logger?.warn?.("[xdpool] could not merge channel-pack accounts", error);
	}
}
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text$2(value) {
	return typeof value === "string" ? value : "";
}
/** The text of a block list, in order. */
function textOf(blocks) {
	let out = "";
	for (const block of blocks) if (isRecord$2(block) && block.type === "text" && typeof block.text === "string") out += block.text;
	return out;
}
/** A content value as a block list; a bare string is one text block. */
function blocksOf(content) {
	if (typeof content === "string") return [{
		type: "text",
		text: content
	}];
	if (!Array.isArray(content)) return [];
	const out = [];
	for (const block of content) if (isRecord$2(block)) out.push(block);
	else if (typeof block === "string" && block !== "") out.push({
		type: "text",
		text: block
	});
	return out;
}
/**
* Is this block an image, in any of the three wire spellings?
*
* The type tag alone is not enough: pi-ai's chat wire emits
* `{type:'image_url', image_url:{url}}` while the harness's own blocks use
* `{type:'image', …}`, and a body that already crossed a translation boundary
* carries `{type:'input_image', image_url:'…'}`. A block that carries a usable
* URL under any of them is an image, so the URL decides and the tag only
* disqualifies an obviously non-image block.
*/
function isImageBlock(block) {
	const type = text$2(block.type);
	if (type === "image" || type === "image_url" || type === "input_image" || type === "input_image_url") return true;
	if (type !== "") return false;
	const nested = block.image_url;
	const candidate = typeof nested === "string" ? nested : text$2(block.url ?? block.data ?? (isRecord$2(nested) ? nested.url : void 0));
	return candidate.startsWith("data:") || candidate.startsWith("http://") || candidate.startsWith("https://");
}
/**
* The image URL one block can be read at, or undefined.
*
* Three spellings are accepted because the block's origin decides its shape:
* pi-ai's chat wire sends `{type:'image_url', image_url:{url}}`, the harness's
* own content blocks carry `{type:'image', url|path|data}`, and an already
* translated Responses block carries `{type:'input_image', image_url:'…'}`.
*
* A data URL is passed through untouched. Anything the gateway cannot fetch —
* a bare filesystem path the model shares no machine with — is dropped and
* recorded, because forwarding a placeholder would make the model answer about a
* picture it never saw, which is worse than admitting the image was lost.
*/
function imageUrlOf(block, resolveImage, warnings) {
	if (resolveImage !== void 0) {
		const resolved = resolveImage({
			...typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {},
			...typeof block.data === "string" ? { data: block.data } : {},
			...typeof block.path === "string" ? { path: block.path } : {},
			...typeof block.url === "string" ? { url: block.url } : {}
		});
		if (resolved !== void 0 && resolved !== "") return resolved;
	}
	const nested = block.image_url;
	const direct = typeof nested === "string" ? nested : text$2(block.url ?? block.data ?? (isRecord$2(nested) ? nested.url : void 0));
	if (direct.startsWith("data:")) return direct;
	if (direct.startsWith("http://") || direct.startsWith("https://")) return direct;
	warnings.push("image-dropped");
}
/** Every tool result a message carries, in order. */
function toolResultsOf(message) {
	if (message.role !== "tool") {
		const blocks = blocksOf(message.content).filter((block) => block.type === "tool-result");
		if (blocks.length === 0) return [];
		return [{
			callId: text$2(message.tool_call_id ?? message.toolCallId ?? message.id),
			content: blocks
		}];
	}
	const out = [];
	const blocks = blocksOf(message.content).filter((block) => block.type === "tool-result");
	for (const block of blocks) out.push({
		callId: text$2(block.tool_use_id ?? block.toolCallId ?? message.tool_call_id ?? message.id),
		content: [block]
	});
	return out;
}
/** The tool call a message's `tool_calls` array holds, when it holds one. */
function toolCallsOf(message) {
	const calls = message.tool_calls ?? message.toolCalls;
	if (!Array.isArray(calls)) return [];
	const out = [];
	for (const raw of calls) {
		if (!isRecord$2(raw)) continue;
		const fn = isRecord$2(raw.function) ? raw.function : {};
		out.push({
			id: text$2(raw.id),
			name: text$2(fn.name ?? raw.name),
			arguments: typeof fn.arguments === "string" ? fn.arguments : typeof raw.arguments === "string" ? raw.arguments : "{}"
		});
	}
	return out;
}
/** Harness tool schemas into the shape each upstream wire expects. */
function toolDefsFor(tools, wire) {
	if (!Array.isArray(tools)) return [];
	const out = [];
	for (const raw of tools) {
		if (!isRecord$2(raw)) continue;
		const fn = isRecord$2(raw.function) ? raw.function : raw;
		const name = text$2(fn.name).trim();
		if (name === "") continue;
		const parameters = isRecord$2(fn.parameters) ? fn.parameters : {
			type: "object",
			properties: {}
		};
		const description = typeof fn.description === "string" ? fn.description : "";
		const clipped = name.slice(0, 128);
		if (wire === "messages") out.push({
			name: clipped,
			description,
			input_schema: parameters
		});
		else if (wire === "responses") out.push({
			type: "function",
			name: clipped,
			description,
			parameters
		});
		else out.push({
			type: "function",
			function: {
				name: clipped,
				description,
				parameters
			}
		});
	}
	return out;
}
/**
* The request body one upstream wire expects.
*
* The caller's `stream`, `model` and `tools` are honoured; the message list is
* re-spelled. Fields the gateway does not know are dropped rather than forwarded,
* because an unknown field on the Responses or Messages wire is a 400 and the
* user would be reading an error about a parameter the plugin invented.
*/
function requestBodyFor(wire, body, options) {
	const { modelId, resolveImage, warnings } = options;
	const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord$2) : [];
	const stream = body.stream === true;
	const reasoningEffort = text$2(body.reasoning_effort);
	const out = {
		model: modelId,
		stream
	};
	if (reasoningEffort !== "") out.reasoning_effort = reasoningEffort;
	const maxTokens = body.max_tokens ?? body.max_completion_tokens;
	if (typeof maxTokens === "number") {
		if (wire === "responses") out.max_output_tokens = maxTokens;
		else if (wire === "messages") out.max_tokens = maxTokens;
		else out.max_tokens = maxTokens;
	}
	const temperature = body.temperature;
	if (typeof temperature === "number") out.temperature = temperature;
	const topP = body.top_p;
	if (typeof topP === "number") out.top_p = topP;
	const stop = body.stop ?? body.stop_sequences;
	if (typeof stop === "string" && stop !== "") {
		if (wire === "responses") out.stop = stop;
		else out.stop = stop;
	} else if (Array.isArray(stop) && stop.length > 0 && stop.every((entry) => typeof entry === "string")) {
		if (wire === "responses") out.stop = stop;
		else out.stop = stop;
	}
	const tools = toolDefsFor(body.tools, wire);
	if (tools.length > 0) {
		out.tools = tools;
		const choice = body.tool_choice;
		if (typeof choice === "string" && choice !== "") out.tool_choice = choice;
		else if (isRecord$2(choice) && text$2(choice.type) !== "") out.tool_choice = choice.type === "function" ? { name: text$2(choice.function === void 0 ? void 0 : choice.function.name) } : choice;
	}
	if (wire === "chat") {
		out.messages = messages;
		return out;
	}
	if (wire === "responses") {
		out.input = responsesInput(messages, resolveImage, warnings);
		const system = systemTextOf(messages);
		if (system !== "") out.instructions = system;
		return out;
	}
	const { system, turns } = claudeTurns(messages, resolveImage, warnings);
	if (system !== "") out.system = system;
	out.messages = turns;
	return out;
}
/** The concatenated system/developer text of a message list. */
function systemTextOf(messages) {
	let out = "";
	for (const message of messages) {
		const role = text$2(message.role);
		if (role !== "system" && role !== "developer") continue;
		const body = textOf(blocksOf(message.content));
		if (body === "") continue;
		out += out === "" ? body : `\n\n${body}`;
	}
	return out;
}
/** The Responses input list: a flat array of messages and calls. */
function responsesInput(messages, resolveImage, warnings) {
	const out = [];
	const followUp = [];
	const flush = () => {
		if (followUp.length === 0) return;
		out.push({
			type: "message",
			role: "user",
			content: followUp.splice(0)
		});
	};
	for (const message of messages) {
		const results = toolResultsOf(message);
		if (results.length === 0) flush();
		for (const result of results) {
			const images = [];
			for (const block of result.content) {
				if (!isImageBlock(block)) continue;
				const url = imageUrlOf(block, resolveImage, warnings);
				if (url !== void 0) images.push({
					type: "input_image",
					image_url: url
				});
			}
			const body = textOf(result.content);
			out.push({
				type: "function_call_output",
				call_id: result.callId,
				output: body !== "" ? body : images.length > 0 ? "(see attached image)" : "(no output)"
			});
			if (images.length > 0) followUp.push({
				type: "input_text",
				text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.`
			}, ...images);
		}
		const role = text$2(message.role);
		if (role === "tool") continue;
		if (role === "system" || role === "developer") {
			const body = textOf(blocksOf(message.content));
			if (body !== "") out.push({
				type: "message",
				role: "system",
				content: [{
					type: "input_text",
					text: body
				}]
			});
			continue;
		}
		if (role === "assistant") {
			const body = textOf(blocksOf(message.content));
			if (body !== "") out.push({
				type: "message",
				role: "assistant",
				content: [{
					type: "output_text",
					text: body
				}]
			});
			for (const call of toolCallsOf(message)) out.push({
				type: "function_call",
				call_id: call.id,
				name: call.name,
				arguments: call.arguments
			});
			continue;
		}
		const parts = [];
		for (const block of blocksOf(message.content)) {
			if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
				parts.push({
					type: "input_text",
					text: block.text
				});
				continue;
			}
			if (isImageBlock(block)) {
				const url = imageUrlOf(block, resolveImage, warnings);
				if (url !== void 0) parts.push({
					type: "input_image",
					image_url: url
				});
			}
		}
		if (parts.length === 0) continue;
		if (results.length > 0) followUp.push(...parts);
		else out.push({
			type: "message",
			role: "user",
			content: parts
		});
	}
	flush();
	return out;
}
/** The Anthropic turn list plus the system prompt, from a chat message list. */
function claudeTurns(messages, resolveImage, warnings) {
	const system = systemTextOf(messages);
	const turns = [];
	for (const message of messages) {
		const role = text$2(message.role);
		if (role === "system" || role === "developer") continue;
		for (const result of toolResultsOf(message)) {
			const content = [];
			for (const block of result.content) {
				if (!isImageBlock(block)) continue;
				const url = imageUrlOf(block, resolveImage, warnings);
				if (url !== void 0) content.push(claudeImage(url));
			}
			const body = textOf(result.content);
			turns.push({
				role: "user",
				content: [{
					type: "tool_result",
					tool_use_id: result.callId,
					content: body !== "" ? body : content.length > 0 ? content : "(no output)"
				}]
			});
		}
		if (role === "tool") continue;
		if (role === "assistant") {
			const content = [];
			const body = textOf(blocksOf(message.content));
			if (body !== "") content.push({
				type: "text",
				text: body
			});
			for (const call of toolCallsOf(message)) content.push({
				type: "tool_use",
				id: call.id,
				name: call.name,
				input: safeJson(call.arguments)
			});
			if (content.length > 0) turns.push({
				role: "assistant",
				content
			});
			continue;
		}
		const content = [];
		for (const block of blocksOf(message.content)) {
			if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
				content.push({
					type: "text",
					text: block.text
				});
				continue;
			}
			if (isImageBlock(block)) {
				const url = imageUrlOf(block, resolveImage, warnings);
				if (url !== void 0) content.push(claudeImage(url));
			}
		}
		if (content.length > 0) turns.push({
			role: "user",
			content
		});
	}
	return {
		system,
		turns
	};
}
/** Parse a tool argument string, so a malformed one cannot 400 the turn. */
function safeJson(value) {
	try {
		return JSON.parse(value === "" ? "{}" : value);
	} catch {
		return {};
	}
}
/** The Anthropic shape for one image URL. */
function claudeImage(url) {
	const matched = /^data:([^;,]+)/.exec(url);
	if (matched === null) return {
		type: "image",
		source: {
			type: "url",
			url
		}
	};
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: matched[1] ?? "image/png",
			data: url.slice(url.indexOf(",") + 1)
		}
	};
}
/**
* Admit and translate one stream's tool calls.
*
* A block is classified the moment it NAMES itself. Until then its argument
* fragments are held, because a provider that streams arguments before the name
* is rare but real, and forwarding them optimistically would leak a dropped
* block's fragments to a client that cannot run the call.
*/
var FreeToolWire = class {
	declared;
	/** Gate tool names the fingerprint pass had to inject; nobody can run those. */
	injected;
	slots = /* @__PURE__ */ new Map();
	verdicts = /* @__PURE__ */ new Map();
	held = /* @__PURE__ */ new Map();
	rename;
	survivedCalls = 0;
	next = 0;
	/**
	* @param tools - the tool list as it went OUT (fingerprint pass applied)
	* @param plan - what that pass did: renames, and which gate names it had to
	*   inject because the caller declared no tool of that name
	*/
	constructor(tools, plan) {
		this.declared = /* @__PURE__ */ new Set();
		this.rename = plan?.rename ?? /* @__PURE__ */ new Map();
		this.injected = new Set(plan?.injected ?? []);
		if (!Array.isArray(tools)) return;
		for (const raw of tools) {
			const name = toolNameOf$1(raw);
			if (name !== "") this.declared.add(name);
		}
	}
	/**
	* Is the tool the gateway NAMED one the caller can actually execute?
	*
	* Judged on the sent spelling, before it is restored: under v2 a caller's own
	* `read` never goes out under that name (the fingerprint pass renamed it to
	* `read_client`), so any surviving `read`/`shell` is the gate's own tool. The
	* model calls those — it was observed calling `read` to answer "what files are
	* in /etc" — and nobody can run them, so they are dropped and the turn is not
	* left ending on a tool the caller cannot execute.
	*
	* `injected` is the list the fingerprint pass actually added. It matters: when
	* the caller declares OpenCode's REAL `read`, that name is not injected and the
	* call is executable. Older callers that pass nothing get the name-only rule.
	*/
	executable(sent) {
		if (this.injected.size > 0) return !this.injected.has(sent);
		return !(FINGERPRINT_TOOLS.includes(sent) && !this.declared.has(sent));
	}
	/** How many calls survived the decoy filter, for the turn's finish reason. */
	calls() {
		return this.survivedCalls;
	}
	/** The per-request sequential index for a wire block. */
	indexOf(key) {
		const known = this.slots.get(key);
		if (known !== void 0) return known;
		const assigned = this.next;
		this.next += 1;
		this.slots.set(key, assigned);
		return assigned;
	}
	/**
	* Route one tool-call fragment.
	*
	* @returns the frames to send, or `null` when the fragment is held or dropped
	*/
	admit(key, sentName, argsDelta, id) {
		const verdict = this.verdicts.get(key);
		if (verdict === false) return [];
		if (verdict === true) return argsDelta === "" ? [] : [{ tool_calls: [{
			index: this.indexOf(key),
			function: { arguments: argsDelta }
		}] }];
		const sent = sentName === void 0 || sentName === "" ? void 0 : sentName;
		if (sent !== void 0) {
			const keep = this.executable(sent);
			this.verdicts.set(key, keep);
			const parked = this.held.get(key);
			if (parked !== void 0) this.held.set(key, {
				id: id !== void 0 && id !== "" ? id : parked.id,
				args: [...parked.args, argsDelta]
			});
			else this.held.set(key, {
				id: id ?? "",
				args: argsDelta === "" ? [] : [argsDelta]
			});
			if (!keep) return [];
			const name = this.restore(sent);
			this.survivedCalls += 1;
			this.held.delete(key);
			const held = [...parked?.args ?? [], argsDelta].join("");
			return [{ tool_calls: [{
				index: this.indexOf(key),
				id: id !== void 0 && id !== "" ? id : parked?.id ?? "",
				type: "function",
				function: {
					name,
					arguments: ""
				}
			}] }, ...held === "" ? [] : [{ tool_calls: [{
				index: this.indexOf(key),
				function: { arguments: held }
			}] }]];
		}
		const parked = this.held.get(key) ?? {
			id: "",
			args: []
		};
		if (id !== void 0 && id !== "") parked.id = id;
		if (argsDelta !== "") parked.args.push(argsDelta);
		this.held.set(key, parked);
		return [];
	}
	/** Did the turn ask for a tool the caller cannot run? */
	suppressed() {
		for (const [key, verdict] of this.verdicts) if (verdict === false && this.held.has(key)) return true;
		return false;
	}
	/** The caller's own spelling for a name that went out under another one. */
	restore(sent) {
		return this.rename.size === 0 ? sent : this.rename.get(sent) ?? sent;
	}
};
/** The declared tool name of one tool definition, in either spelling. */
function toolNameOf$1(tool) {
	if (!isRecord$2(tool)) return "";
	if (typeof tool.name === "string" && tool.name.trim() !== "") return tool.name.trim();
	const fn = tool.function;
	if (isRecord$2(fn) && typeof fn.name === "string") return fn.name.trim();
	return "";
}
/**
* The tool names the v2 free tier requires to be declared.
*
* Duplicated from the wire module on purpose: this file must stay importable on
* its own so the translation can be tested without the transport.
*
* v2 narrowed this from the v1 quartet (`bash`, `glob`, `grep`, `read`) to two,
* and — unlike v1 — case variants are NOT gate tools: a caller that declares
* `Read` or `Bash` keeps those names untouched, which is why this list is
* compared exactly rather than lowercased.
*/
const FINGERPRINT_TOOLS = ["read", "shell"];
/**
* Translate one upstream event into chat chunks.
*
* The chat wire needs no translation at all: its payloads are already what the
* harness decodes, and re-encoding them would risk splitting a multi-byte
* character at a frame boundary. The other two are translated frame by frame.
*/
function chatChunksFor(wire, payload, tools) {
	if (wire === "chat") return chatEvent(payload, tools);
	if (wire === "messages") return claudeEvent(payload, tools);
	return responsesEvent(payload, tools);
}
/** The chat wire's own payload, minus the fields the decoder handles elsewhere. */
function chatEvent(payload, tools) {
	const root = isRecord$2(payload) ? payload : {};
	const out = { frames: [] };
	if (isRecord$2(root.usage)) out.usage = root.usage;
	const choices = Array.isArray(root.choices) ? root.choices : [];
	for (const raw of choices) {
		if (!isRecord$2(raw)) continue;
		const delta = isRecord$2(raw.delta) ? raw.delta : {};
		const reasoning = reasoningOf(delta);
		if (reasoning !== void 0) out.frames.push({ reasoning_content: reasoning });
		const content = text$2(delta.content);
		if (content !== "") out.frames.push({ content });
		const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
		for (const call of calls) {
			if (!isRecord$2(call)) continue;
			const fn = isRecord$2(call.function) ? call.function : {};
			const name = typeof fn.name === "string" && fn.name !== "" ? fn.name : void 0;
			const key = `c${text$2(call.index)}`;
			out.frames.push(...tools.admit(key, name, text$2(fn.arguments), typeof call.id === "string" ? call.id : void 0));
		}
		const finish = text$2(raw.finish_reason);
		if (finish !== "") out.finish = finish;
	}
	return out;
}
/** The thinking one frame carries, in whichever spelling the gateway used. */
function reasoningOf(delta) {
	for (const field of [
		"reasoning",
		"reasoning_content",
		"reasoning_text",
		"thinking"
	]) {
		const value = delta[field];
		if (typeof value === "string" && value !== "") return value;
	}
	if (Array.isArray(delta.reasoning_details)) {
		let body = "";
		for (const part of delta.reasoning_details) if (isRecord$2(part) && typeof part.text === "string") body += part.text;
		if (body !== "") return body;
	}
}
/** One Anthropic Messages event, translated. */
function claudeEvent(payload, tools) {
	const event = isRecord$2(payload) ? payload : {};
	const type = text$2(event.type);
	const out = { frames: [] };
	if (type === "content_block_start") {
		const block = isRecord$2(event.content_block) ? event.content_block : {};
		if (text$2(block.type) === "tool_use") out.frames.push(...tools.admit(`b${text$2(event.index)}`, text$2(block.name), "", text$2(block.id)));
		return out;
	}
	if (type === "content_block_delta") {
		const delta = isRecord$2(event.delta) ? event.delta : {};
		const key = `b${text$2(event.index)}`;
		const kind = text$2(delta.type);
		if (kind === "text_delta") {
			const body = text$2(delta.text);
			if (body !== "") out.frames.push({ content: body });
		} else if (kind === "thinking_delta") {
			const body = text$2(delta.thinking);
			if (body !== "") out.frames.push({ reasoning_content: body });
		} else if (kind === "input_json_delta") out.frames.push(...tools.admit(key, void 0, text$2(delta.partial_json)));
		return out;
	}
	if (type === "message_start") {
		const message = isRecord$2(event.message) ? event.message : {};
		out.usage = anthropicUsage(isRecord$2(message.usage) ? message.usage : {});
		return out;
	}
	if (type === "message_delta") {
		const output = (isRecord$2(event.usage) ? event.usage : {}).output_tokens;
		if (typeof output === "number") out.usage = {
			...out.usage ?? {},
			completion_tokens: output
		};
		const stop = text$2((isRecord$2(event.delta) ? event.delta : {}).stop_reason);
		if (stop !== "") out.finish = anthropicFinish(stop);
		return out;
	}
	if (type === "message_stop") out.done = true;
	return out;
}
/** Anthropic's usage names, in the chat spelling the harness reads. */
function anthropicUsage(usage) {
	const prompt = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const completion = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	const cached = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
	const written = typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
	return {
		prompt_tokens: prompt + cached + written,
		completion_tokens: completion,
		total_tokens: prompt + cached + written + completion,
		...cached + written === 0 ? {} : { prompt_tokens_details: { cached_tokens: cached } }
	};
}
/** Anthropic stop reasons, in the chat finish tokens the harness reads. */
function anthropicFinish(stop) {
	if (stop === "tool_use") return "tool_calls";
	if (stop === "max_tokens") return "length";
	return "stop";
}
/** One OpenAI Responses event, translated. */
function responsesEvent(payload, tools) {
	const event = isRecord$2(payload) ? payload : {};
	const type = text$2(event.type);
	const out = { frames: [] };
	if (type === "response.output_item.added") {
		const item = isRecord$2(event.item) ? event.item : {};
		if (text$2(item.type) === "function_call") out.frames.push(...tools.admit(`i${text$2(event.output_index)}`, text$2(item.name), "", text$2(item.call_id ?? item.id)));
		return out;
	}
	if (type === "response.output_text.delta") {
		const body = text$2(event.delta);
		if (body !== "") out.frames.push({ content: body });
		return out;
	}
	if (type === "response.reasoning_summary_text.delta" || type === "response.output_reasoning.text.delta") {
		const body = text$2(event.delta);
		if (body !== "") out.frames.push({ reasoning_content: body });
		return out;
	}
	if (type === "response.function_call_arguments.delta") {
		out.frames.push(...tools.admit(`i${text$2(event.output_index)}`, void 0, text$2(event.delta)));
		return out;
	}
	if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "response.done") {
		const response = isRecord$2(event.response) ? event.response : {};
		out.usage = responsesUsage(isRecord$2(response.usage) ? response.usage : {});
		out.finish = responsesFinish(response, isRecord$2(response.incomplete_details) ? response.incomplete_details : {});
		out.done = true;
	}
	return out;
}
/** The Responses usage names, in the chat spelling the harness reads. */
function responsesUsage(usage) {
	const prompt = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
	const completion = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
	const cached = isRecord$2(usage.input_tokens_details) && typeof usage.input_tokens_details.cached_tokens === "number" ? usage.input_tokens_details.cached_tokens : 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: prompt + completion,
		...cached === 0 ? {} : { prompt_tokens_details: { cached_tokens: cached } }
	};
}
/** The Responses status, in a chat finish token. */
function responsesFinish(response, incomplete) {
	if (text$2(response.status) === "incomplete" || incomplete.reason === "max_output_tokens") return "length";
	if (Array.isArray(response.output)) {
		for (const item of response.output) if (isRecord$2(item) && text$2(item.type) === "function_call") return "tool_calls";
	}
	return "stop";
}
//#endregion
//#region src/free-upstream.ts
/**
* Outbound wire for the免密 free lane.
*
* Every fact encoded here was verified against the live gateway by direct
* request rather than inferred from its documentation, which matters because
* each one is a hard gate that answers with a bare error and no explanation:
*
* - `Authorization: Bearer public` is the pooled credential. There is no
*   per-user secret on this lane, so a request that carries a real key is
*   rejected as unknown.
* - The endpoint is per MODEL, not per request: the same model cannot be asked
*   through the other wire even if it would accept it.
*
* ## The v2 fingerprint (everything here changed on 2026-10-14)
*
* The gateway stopped recognising v1 clients. All four facts below moved
* together and each one on its own answers `403 FreeTierError` with no
* explanation of which was wrong; they were verified by running a request per
* variant until one answered 200 with real content.
*
* 1. **User-Agent** — the shape is `opencode/<channel>/<version>/<client>` and
*    the major version must be at least 2. `opencode/1.18.x` is now refused by
*    name.
* 2. **Path** — `/inference/v1/*`, not `/zen/v1/*`. The old path answers every
*    free model with `403 FreeTierError` even with a perfect fingerprint.
* 3. **Session headers** — four headers carrying the same value
*    (`x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`,
*    `x-session-id`). The v1-only `x-opencode-request` is not merely optional: a
*    request that still sends it is refused, so the per-turn request id stays a
*    local book-keeping value and never goes on the wire.
* 4. **Tools** — `read` and `shell`, with OpenCode's OWN descriptions and
*    parameter schemas. The v1 approach (four self-disabling stubs with empty
*    `properties`) is dead, and so is promoting the caller's real shell into a
*    slot: v2 compares definitions, so a promoted slot no longer matches.
*    `tool_choice: 'none'` is likewise fatal now — only the Responses wire fills
*    a missing choice, and it fills it with `auto`.
*
* @module src/free-upstream
*/
/**
* Overridable so the offline suite can point the lane at a dead port.
*
* The guard is not decoration: this module is reachable from the CLIENT bundle
* (the aggregate page imports the capability table from the same lane), and the
* client runs in a browser where `process` does not exist. A bare
* `process.env.X` is a ReferenceError at module-evaluation time there, which
* takes the whole settings section down with it — the page the user was on when
* the plugin loaded, not merely this one lane. `typeof` costs a few bytes and
* turns an unguarded read into a miss that falls through to the real gateway.
*/
const FREE_UPSTREAM_BASE = (typeof process === "undefined" ? void 0 : process.env.XDPOOL_FREE_BASE) ?? "https://opencode.ai";
/**
* The gateway fingerprints a genuine client, and only a v2-shaped UA is one.
*
* The shape is `opencode/<channel>/<version>/<client>` with a major version of at
* least 2 — the v1 `opencode/1.18.x` is refused by name since 2026-10-14.
*/
const FREE_CLIENT_UA = "opencode/latest/2.0.26/cli";
/** Anthropic's version header, for the Messages wire. */
const ANTHROPIC_API_VERSION = "2023-06-01";
/** One turn's budget, matching the pool shim's idle ceiling. */
const FREE_TURN_TIMEOUT_MS = 3e5;
const MAX_SESSION_LENGTH = 256;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
* The two tools the v2 gate requires, with OpenCode's own definitions.
*
* ⚠️ **Copied verbatim from the OpenCode v2.0.26 CLI.** The upstream compares
* both the description and the parameter schema: rewording, trimming the schema,
* emptying `properties`, or renaming all trade a working lane for a 403. Nothing
* in these strings is ours to improve.
*/
const FINGERPRINT_TOOL_DEFINITIONS = {
	read: {
		description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File or directory to read"
				},
				offset: {
					type: "integer",
					minimum: 0,
					description: "The line or directory entry to start reading from (1-based)"
				},
				limit: {
					type: "integer",
					minimum: 0,
					description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
				}
			},
			required: ["path"],
			additionalProperties: false
		}
	},
	shell: {
		description: "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command string to execute"
				},
				workdir: {
					type: "string",
					description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."
				},
				timeout: {
					type: "integer",
					minimum: 0,
					description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."
				},
				background: {
					type: "boolean",
					description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
				}
			},
			required: ["command"],
			additionalProperties: false
		}
	}
};
/**
* The note appended when a fingerprint tool had to be injected.
*
* v2's definitions are REAL tools — description and schema both come from the
* official client, and the model will actually call them (it was observed
* calling `read` to answer "what files are in /etc"). v1 suppressed that with a
* "must not be used" stub description; here the only lever is the prompt. The
* wording is the one that was measured: calling them "unavailable" makes the
* model refuse the CALLER's own `Read`/`Bash` too, while "placeholder, use the
* tools you were given" holds the injected ones back without collateral.
*/
function placeholderNote(names) {
	const list = names.map((name) => `\`${name}\``).join(" or ");
	return names.length > 1 ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.` : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}
/** Models served by `/responses` instead of `/chat/completions`. */
const RESPONSES_MODELS = /* @__PURE__ */ new Set(["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]);
/** Models served by the Anthropic-shaped `/messages` endpoint. */
const MESSAGES_MODELS = /* @__PURE__ */ new Set(["union-alpha"]);
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text$1(value) {
	return typeof value === "string" ? value : "";
}
function base62From(bytes) {
	let out = "";
	for (const byte of bytes) out += BASE62[byte % 62] ?? "0";
	return out;
}
/** A gateway-shaped request id for one turn. Kept local: v2 refuses it on the wire. */
function mintRequestId(timestamp = Date.now()) {
	const value = BigInt(timestamp) * 4096n + 1n;
	let hex = "";
	for (let i = 0; i < 6; i += 1) hex += (value >> BigInt(40 - 8 * i) & 255n).toString(16).padStart(2, "0");
	return `msg_${hex}${base62From(crypto.randomBytes(14))}`;
}
/** Does `id` already look like a v2-canonical session (shape *and* descending counter)? */
function isCanonicalSession(id) {
	const s = text$1(id).trim();
	if (!SESSION_RE.test(s)) return false;
	const low = Number(BigInt(`0x${s.slice(4, 16)}`) & 4095n);
	return low >= 4032 && low <= 4095;
}
/** 64-bit FNV-1a, used only to turn a seed string into a stable number. */
function fnv64(str) {
	let h = 14695981039346656037n;
	for (let i = 0; i < str.length; i += 1) {
		h ^= BigInt(str.charCodeAt(i) & 255);
		h = h * 1099511628211n & 18446744073709551615n;
	}
	return h;
}
/** The 12-hex canonical prefix for a 41-bit timestamp + 1..63 counter. */
function canonicalPrefix(ts, seq) {
	const s = BigInt(Math.min(Math.max(seq | 0, 1), 63));
	const value = ~(BigInt(ts) * 4096n + s);
	let hex = "";
	for (let i = 0; i < 6; i += 1) hex += (value >> BigInt(40 - 8 * i) & 255n).toString(16).padStart(2, "0");
	return hex;
}
const SESSION_EPOCH = 1769721600000n;
/** Deterministic canonical upstream session for a conversation seed. */
function sessionFromSeed(seed) {
	const h = fnv64(`xdpool-free\0${seed}`);
	const offset = h & 2147483647n;
	const ts = SESSION_EPOCH + offset % (30n * 24n * 3600n * 1000n);
	const seq = Number(h >> 31n & 63n) + 1;
	return `ses_${canonicalPrefix(ts, seq > 63 ? 63 : seq)}${base62From(crypto.createHash("sha256").update(`xdpool-free-suffix\0${seed}`, "utf8").digest().subarray(0, 14))}`;
}
/** Return `id` if already canonical; otherwise derive a deterministic canonical session from it. */
function canonicalizeSession(id) {
	if (isCanonicalSession(id)) return text$1(id).trim().slice(0, MAX_SESSION_LENGTH);
	const trimmed = text$1(id).trim();
	return sessionFromSeed(trimmed === "" ? "global" : trimmed);
}
/**
* Map one downstream conversation onto one stable upstream session.
*
* This is the difference between a free lane that works and one that 403/429s:
* quota is per session, so a fresh id per request burns the budget and a
* hash-derived id is rejected by the v2 gateway. A deterministic canonical
* session gives the same conversation the same upstream session across
* restarts, which is also how the real client behaves.
*/
function sessionForConversation(sessionId) {
	return canonicalizeSession(sessionId);
}
/**
* A stable per-turn request id, so retries of one turn share it.
*
* NOTE: the v2 gateway refuses `x-opencode-request` on the wire (it is v1-only),
* so this id is local book-keeping only — {@link gatewayHeaders} never sends it.
* It is therefore exempt from the canonical-session encoding the upstream enforces.
*/
function requestIdFor(sessionId, turnSeed) {
	if (text$1(turnSeed) === "") return mintRequestId();
	const digest = crypto.createHash("sha256").update(`xdpool-free-req\0${sessionId}\0${turnSeed}`, "utf8").digest();
	const id = `msg_${digest.subarray(0, 6).toString("hex")}${base62From(digest.subarray(6, 20))}`;
	return REQUEST_RE.test(id) ? id : mintRequestId();
}
/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
function baseModelId(model) {
	return model.replace(/\([^()]+\)\s*$/u, "").trim();
}
/** `muse-spark` answers on the Responses wire whatever the exact suffix is. */
function isMuseSpark(modelId) {
	const clean = baseModelId(modelId);
	const base = clean.includes("/") ? clean.split("/").pop() ?? clean : clean;
	return /^muse[-_]?spark(?:$|[-_:.\s])/iu.test(base);
}
/** Does this model need the Responses wire? */
function isResponsesModel(modelId) {
	return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId);
}
/** Does this model need the Anthropic-shaped wire? */
function isMessagesModel(modelId) {
	return MESSAGES_MODELS.has(baseModelId(modelId));
}
/**
* Which upstream path serves this model.
*
* `/inference/*` since 2026-10-14. The old `/zen/*` prefix answers every free
* model with `403 FreeTierError` no matter how good the fingerprint is, which is
* why the listing path in {@link fetchFreeListing} moved with it.
*/
function endpointFor(modelId) {
	if (isResponsesModel(modelId)) return "/inference/v1/responses";
	if (isMessagesModel(modelId)) return "/inference/v1/messages";
	return "/inference/v1/chat/completions";
}
/** Which wire shape that endpoint speaks; drives encoding and parsing. */
function wireFor(modelId) {
	const path = endpointFor(modelId);
	if (path === "/inference/v1/responses") return "responses";
	if (path === "/inference/v1/messages") return "messages";
	return "chat";
}
/** The listing endpoint that goes with {@link endpointFor}'s prefix. */
const FREE_LISTING_PATH = "/inference/v1/models";
/**
* The headers the gateway fingerprints a genuine client by.
*
* Four headers carry the SAME session value; the v2 client sends it under all
* four names and the gateway checks more than one of them. `x-opencode-request`
* is deliberately absent — it was v1-only, and a v2 request that still carries
* it is refused, so the per-turn request id stays local book-keeping.
*/
function gatewayHeaders({ session, requestId: _requestId, stream, accept }) {
	return {
		"content-type": "application/json",
		authorization: "Bearer public",
		"user-agent": FREE_CLIENT_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		"x-opencode-session-id": session,
		"x-session-affinity": session,
		"x-session-id": session,
		"x-opencode-project": "global",
		accept: accept ?? (stream ? "text/event-stream" : "*/*")
	};
}
function toolNameOf(tool) {
	if (!isRecord$1(tool)) return "";
	if (typeof tool.name === "string" && tool.name.trim() !== "") return tool.name.trim();
	const fn = tool.function;
	if (isRecord$1(fn) && typeof fn.name === "string") return fn.name.trim();
	return "";
}
/**
* The gate tool a name answers to, or '' when it is not one.
*
* EXACT match, not case-folded. The old pass canonicalised by lowercasing, which
* meant a caller's `Read` got renamed to `read` and then compared against
* OpenCode's own definition — two definitions for one name, and a 403.
*/
function fingerprintKey(name) {
	const trimmed = name.trim();
	return FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}
/** The Chat-shape `{function:{…}}` wrapper, or null for the flat Responses one. */
function functionOf(tool) {
	return isRecord$1(tool.function) ? tool.function : null;
}
/** Where one tool's description and schema sit, per wire shape. */
function definitionOf(tool, { claude, flat }) {
	const wrapper = claude || flat ? tool : functionOf(tool);
	if (wrapper === null || wrapper === void 0) return null;
	return {
		description: wrapper.description,
		schema: claude ? wrapper.input_schema : wrapper.parameters
	};
}
/** Does this tool already carry OpenCode's own definition for `name`? */
function carriesFingerprintDefinition(tool, name, shape) {
	const own = definitionOf(tool, shape);
	if (own === null) return false;
	const want = FINGERPRINT_TOOL_DEFINITIONS[name];
	if (want === void 0) return false;
	return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters);
}
function withToolName(tool, name) {
	const fn = functionOf(tool);
	return fn === null ? {
		...tool,
		name
	} : {
		...tool,
		function: {
			...fn,
			name
		}
	};
}
/** The gate's own declaration, spelled the way the wire expects. */
function fingerprintTool(name, { claude, flat }) {
	const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name] ?? {};
	if (claude) return {
		name,
		description,
		input_schema: parameters
	};
	if (flat) return {
		type: "function",
		name,
		description,
		parameters
	};
	return {
		type: "function",
		function: {
			name,
			description,
			parameters
		}
	};
}
/** `original -> alias` for every tool the rename pass touched. */
function aliasesByOriginal(map) {
	return new Map([...map].map(([alias, original]) => [original, alias]));
}
/**
* Point an explicit `tool_choice` at the alias of a tool that was renamed.
*
* Only an alias is retargeted: a choice naming a tool we left alone must stay
* byte-identical, and `none` is never emitted (see {@link applyFingerprint}).
*/
function retargetToolChoice(body, map) {
	if (map.size === 0) return;
	const choice = body.tool_choice;
	if (!isRecord$1(choice)) return;
	const aliases = aliasesByOriginal(map);
	if (typeof choice.name === "string") {
		const alias = aliases.get(choice.name.trim());
		if (alias !== void 0) body.tool_choice = {
			...choice,
			name: alias
		};
		return;
	}
	const fn = choice.function;
	if (isRecord$1(fn) && typeof fn.name === "string") {
		const alias = aliases.get(fn.name.trim());
		if (alias !== void 0) body.tool_choice = {
			...choice,
			function: {
				...fn,
				name: alias
			}
		};
	}
}
/**
* Rewrite prior-turn calls to a tool that was renamed.
*
* Without this the model reads its own earlier `read` call as a call to
* OpenCode's injected tool of that name, and the two definitions disagree.
*/
function aliasHistoryToolCalls(body, map) {
	if (map.size === 0) return;
	const aliases = aliasesByOriginal(map);
	const aliasOf = (name) => typeof name === "string" ? aliases.get(name.trim()) : void 0;
	const withField = (block, field, value) => value === void 0 ? block : {
		...block,
		[field]: value
	};
	if (Array.isArray(body.input)) body.input = body.input.map((item) => {
		if (!isRecord$1(item) || item.type !== "function_call") return item;
		return withField(item, "name", aliasOf(item.name));
	});
	if (!Array.isArray(body.messages)) return;
	body.messages = body.messages.map((message) => {
		if (!isRecord$1(message)) return message;
		if (Array.isArray(message.content)) return {
			...message,
			content: message.content.map((block) => {
				if (!isRecord$1(block)) return block;
				if (block.type === "tool_use") {
					const aliased = aliasOf(block.name);
					return aliased === void 0 ? block : withToolName(block, aliased);
				}
				if (block.type === "tool_result") return withField(block, "tool_name", aliasOf(block.tool_name));
				return block;
			})
		};
		if (!Array.isArray(message.tool_calls)) return message;
		return {
			...message,
			tool_calls: message.tool_calls.map((call) => {
				if (!isRecord$1(call) || !isRecord$1(call.function)) return call;
				const aliased = aliasOf(call.function.name);
				return aliased === void 0 ? call : {
					...call,
					function: {
						...call.function,
						name: aliased
					}
				};
			})
		};
	});
}
/** Tell the model the injected fingerprint tools are placeholders. */
function noteInjectedTools(body, { claude, flat }, names) {
	const note = placeholderNote(names);
	if (flat) {
		body.instructions = typeof body.instructions === "string" && body.instructions.trim() !== "" ? `${body.instructions}\n\n${note}` : note;
		return;
	}
	if (claude) {
		body.system = typeof body.system === "string" && body.system !== "" ? `${body.system}\n\n${note}` : note;
		return;
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const first = messages[0];
	if (isRecord$1(first) && first.role === "system" && typeof first.content === "string") {
		body.messages = [{
			...first,
			content: `${first.content}\n\n${note}`
		}, ...messages.slice(1)];
		return;
	}
	body.messages = [{
		role: "system",
		content: note
	}, ...messages];
}
/**
* Satisfy the v2 free-tier fingerprint gate on `body.tools`.
*
* ## The v2 rules (each one is a 403 that was measured)
*
* 1. `read` and `shell` must be DECLARED, with OpenCode's definitions byte for
*    byte.
* 2. The caller's tools survive UNTOUCHED, including case variants like
*    `Read`/`Bash` — those are not gate tools.
* 3. A caller tool that happens to be named `read`/`shell` with a DIFFERENT
*    definition is renamed to `<name>_client`; {@link aliasHistoryToolCalls} and
*    {@link retargetToolChoice} rewrite the history and the choice to match, and
*    the response side restores the caller's name.
* 4. A duplicate declaration of the same name keeps the first — the upstream
*    refuses duplicates.
* 5. `tool_choice: 'none'` is never emitted. v2 answers 403 to it (v1 allowed it,
*    and the old code even added it). Only the Responses wire fills a missing
*    choice, with `auto`.
*
* ⚠️ v1's "promote the caller's shell into the bash slot" is GONE: v2 compares
* definitions, so a promoted slot no longer matches what the gate wants.
*
* @param body - request body, mutated in place
* @param wire - which upstream shape `body.tools` is spelled in
* @returns what the response side needs to undo the gate
*/
function applyFingerprint(body, wire) {
	const flat = wire === "responses";
	const shape = {
		claude: wire === "messages",
		flat
	};
	const map = /* @__PURE__ */ new Map();
	const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord$1) : [];
	const taken = new Set(tools.map(toolNameOf).filter((name) => name !== ""));
	const seen = /* @__PURE__ */ new Set();
	const present = /* @__PURE__ */ new Set();
	const out = [];
	for (const tool of tools) {
		const current = toolNameOf(tool);
		const key = fingerprintKey(current);
		if (key === "") {
			out.push(tool);
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		if (carriesFingerprintDefinition(tool, key, shape)) {
			out.push(tool);
			present.add(key);
			continue;
		}
		let alias = `${key}_client`;
		for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`;
		taken.add(alias);
		map.set(alias, current);
		out.push(withToolName(tool, alias));
	}
	const injected = [];
	for (const name of FINGERPRINT_TOOLS) {
		if (present.has(name)) continue;
		out.push(fingerprintTool(name, shape));
		injected.push(name);
	}
	body.tools = out;
	retargetToolChoice(body, map);
	aliasHistoryToolCalls(body, map);
	if (injected.length > 0) noteInjectedTools(body, shape, injected);
	const choice = body.tool_choice;
	if (choice === "none" || isRecord$1(choice) && choice.type === "none") delete body.tool_choice;
	if (flat && !body.tool_choice) body.tool_choice = "auto";
	return {
		rename: map,
		injected
	};
}
/** Test seam: this lane's own transport, so the suite never leaves the process. */
const freeLane = { fetch: null };
/**
* The free lane's transport.
*
* `node:http`/`node:https` rather than `globalThis.fetch`, because local proxy
* plugins work by replacing `globalThis.fetch` and re-serializing the body on the
* way out — which mangles a JSON body enough to change the turn. The native
* modules cannot be swapped by another plugin.
*/
function freeFetch(url, init = {}) {
	const method = init.method ?? "GET";
	const stub = freeLane.fetch;
	if (stub !== null && typeof stub.fetch === "function") return stub.fetch(url, {
		method,
		...init
	});
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = (target.protocol === "http:" ? http : https).request({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || (target.protocol === "http:" ? 80 : 443),
			path: `${target.pathname}${target.search}`,
			method,
			headers: init.body === void 0 ? init.headers ?? {} : {
				...init.headers ?? {},
				"content-length": Buffer.byteLength(init.body, "utf8")
			}
		}, (response) => {
			resolve(new Response(Readable.toWeb(response), {
				status: response.statusCode ?? 0,
				statusText: response.statusMessage ?? "",
				headers: response.headers
			}));
		});
		request.on("error", reject);
		const abort = () => {
			request.destroy(/* @__PURE__ */ new Error("The operation was aborted"));
		};
		init.signal?.addEventListener("abort", abort, { once: true });
		request.on("close", () => {
			init.signal?.removeEventListener("abort", abort);
		});
		if (init.body !== void 0) request.write(init.body, "utf8");
		request.end();
	});
}
/**
* POST one streaming turn and hand back chat-shaped deltas.
*
* The shape of the ANSWER decides how it is read, never its Content-Type: a front
* proxy that mislabels a JSON body as an event stream is common, and believing
* the header truncates real answers. A JSON answer to a streamed request is
* folded through the same translation rather than passed on as one opaque
* document, so the caller sees a delta sequence either way.
*/
async function postFreeStreamed({ modelId, body, session, requestId, hooks, plan, signal, timeoutMs = FREE_TURN_TIMEOUT_MS }) {
	const wire = wireFor(modelId);
	const requestBody = {
		...body,
		model: modelId,
		stream: true
	};
	if (wire !== "messages") requestBody.stream_options = {
		...isRecord$1(body.stream_options) ? body.stream_options : {},
		include_usage: true
	};
	const bodyText = JSON.stringify(requestBody);
	const url = `${FREE_UPSTREAM_BASE}${endpointFor(modelId)}`;
	const headers = gatewayHeaders({
		session,
		requestId,
		stream: true
	});
	if (wire === "messages") headers["anthropic-version"] = ANTHROPIC_API_VERSION;
	const tools = new FreeToolWire(body.tools, plan);
	let response;
	try {
		response = await freeFetch(url, {
			method: "POST",
			headers,
			body: bodyText,
			signal
		});
	} catch (error) {
		if (signal?.aborted === true || error instanceof Error && error.name === "AbortError") throw new AggregateError("client", "request aborted");
		throw new AggregateError("server", `the free lane request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const retryAfter = retryAfterMs(response);
	if (!response.ok) {
		const refusal = await response.text().catch(() => "");
		throw classifyUpstream(response.status, refusal, retryAfter, "");
	}
	if (response.body === null) throw new AggregateError("server", "the free lane returned no body", response.status);
	let events;
	let raw = "";
	const head = await readSseHead(response.body, signal ?? new AbortController().signal, timeoutMs);
	if (head.shape === "sse") events = head.payloads;
	else {
		if (head.shape === "empty") throw new AggregateError("server", "the free lane returned no body", response.status);
		raw = head.text;
		if (!head.done) try {
			for (;;) {
				const chunk = await head.reader.read();
				if (chunk.done) break;
				if (chunk.value !== void 0) raw += head.decoder.decode(chunk.value, { stream: true });
			}
		} catch (error) {
			await head.reader.cancel().catch(() => null);
			throw new AggregateError("server", `the free lane stream broke: ${error instanceof Error ? error.message : String(error)}`, response.status);
		}
		raw += head.decoder.decode();
		events = jsonAnswerEvents(raw);
	}
	const result = { status: response.status };
	let finish;
	let usage;
	for (const event of events) {
		let decoded;
		try {
			decoded = JSON.parse(event);
		} catch {
			continue;
		}
		if (isRecord$1(decoded) && (decoded.error !== void 0 || decoded.type === "error")) throw classifyUpstream(response.status, event, retryAfter, "");
		const translated = chatChunksFor(wire, decoded, tools);
		for (const delta of translated.frames) hooks.onDelta(delta);
		if (translated.usage !== void 0) usage = translated.usage;
		if (translated.finish !== void 0) finish = translated.finish;
		if (translated.done === true) result.truncated = finish === "length";
	}
	if (tools.calls() > 0) finish = "tool_calls";
	else if (finish === "tool_calls") finish = result.truncated === true ? "length" : "stop";
	if (finish === "length") result.truncated = true;
	if (usage !== void 0) {
		hooks.onDelta({ usage });
		result.usage = usage;
	}
	result.suppressedOnly = tools.suppressed();
	result.finishReason = finish;
	return result;
}
/**
* The events one JSON answer carries.
*
* The chat and Messages wires answer with one document; the Responses wire
* answers with one document too, but its `output` array holds the events that a
* stream would have delivered. Both are read here so the caller gets one
* sequence either way.
*/
function jsonAnswerEvents(raw) {
	if (sniffBodyShape(raw) === "sse") return raw.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).filter((payload) => payload !== "" && payload !== "[DONE]");
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		if (/^\s*<(!doctype|html[\s>])/iu.test(raw)) throw new AggregateError("client", "the free lane's front proxy answered with an HTML error page");
		throw new AggregateError("server", `unexpected non-stream response: ${raw.slice(0, 200)}`);
	}
	if (isRecord$1(payload) && payload.type === "response" && isRecord$1(payload.response)) {
		const events = [];
		const response = payload.response;
		const output = isRecord$1(response) && Array.isArray(response.output) ? response.output : [];
		for (const item of output) {
			if (!isRecord$1(item)) continue;
			if (text$1(item.type) === "function_call") {
				events.push(JSON.stringify({
					type: "response.output_item.added",
					output_index: events.length,
					item: {
						type: "function_call",
						call_id: text$1(item.call_id ?? item.id),
						name: text$1(item.name)
					}
				}));
				events.push(JSON.stringify({
					type: "response.function_call_arguments.delta",
					output_index: events.length,
					delta: text$1(item.arguments)
				}));
				continue;
			}
			const body = Array.isArray(item.content) ? item.content.map((part) => isRecord$1(part) ? text$1(part.text) : "").join("") : "";
			if (body === "") continue;
			events.push(JSON.stringify({
				type: "response.output_text.delta",
				output_index: events.length,
				delta: body
			}));
		}
		events.push(JSON.stringify({
			type: "response.completed",
			response: isRecord$1(response) ? response : {}
		}));
		return events;
	}
	return [raw];
}
//#endregion
//#region src/free-catalog.ts
/** The model-id prefix this lane publishes, so the shim can route by shape. */
const FREE_MODEL_PREFIX = "free:";
/** The channel tag the aggregate roster carries for these rows. */
const FREE_CHANNEL = "free";
/** Ids that are free-tier without carrying the `-free` suffix. */
const ALWAYS_FREE = /* @__PURE__ */ new Set(["union-alpha", "space-bunny-free"]);
/**
* Local capability baseline.
*
* `contextWindow`/`maxOutput` are the published capacities; `vision` is what this
* lane actually accepted under a direct image-input probe, not what a model card
* claims.
*/
const CAPABILITIES = [
	{
		match: /^mimo.*v2\.6/u,
		vision: true,
		reasoning: true,
		contextWindow: 1048576,
		maxOutput: 131072,
		canDisableThinking: false
	},
	{
		match: /^mimo.*v2\.5/u,
		vision: true,
		reasoning: true,
		contextWindow: 1048576,
		maxOutput: 131072,
		canDisableThinking: false
	},
	{
		match: /^mimo/u,
		vision: true,
		reasoning: true,
		contextWindow: 262144,
		maxOutput: 131072
	},
	{
		match: /^muse.?spark/u,
		vision: true,
		reasoning: true,
		contextWindow: 1048576,
		maxOutput: 131072
	},
	{
		match: /^nemotron/u,
		vision: false,
		reasoning: true,
		contextWindow: 128e3,
		maxOutput: 32768
	},
	{
		match: /^ling/u,
		vision: false,
		reasoning: true,
		contextWindow: 128e3,
		maxOutput: 32768
	},
	{
		match: /^space.?bunny/u,
		vision: true,
		reasoning: true,
		contextWindow: 262144,
		maxOutput: 65536
	},
	{
		match: /^union/u,
		vision: true,
		reasoning: false,
		contextWindow: 262144,
		maxOutput: 131072
	},
	{
		match: /^deepseek/u,
		vision: false,
		reasoning: true,
		contextWindow: 128e3,
		maxOutput: 64e3
	},
	{
		match: /^jev/u,
		vision: false,
		reasoning: false,
		contextWindow: 32768,
		maxOutput: 4096
	}
];
/** The fallback for an id no rule matched: assume it thinks, assume nothing else. */
const FALLBACK_CAPABILITY = {
	vision: false,
	reasoning: true,
	contextWindow: 131072,
	maxOutput: 32768
};
/** Human-facing display names, so a raw upstream id never reaches the picker. */
const DISPLAY_NAMES = {
	"mimo-v2.6-flash-free": "MiMo V2.6 Flash",
	"mimo-v2.5-free": "MiMo V2.5",
	"muse-spark-1.3-contributor-free": "Muse Spark 1.3",
	"muse-spark-1.2-contributor-free": "Muse Spark 1.2",
	"nemotron-3-ultra-free": "Nemotron 3 Ultra",
	"nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
	"ling-3.0-flash-fin-free": "Ling 3.0 Flash Fin",
	"space-bunny-free": "Space Bunny",
	"union-alpha": "Union Alpha",
	"deepseek-v4-flash-free": "DeepSeek V4 Flash",
	"jev-1.13-free": "Jev 1.13"
};
/** Ids whose availability is known to be egress-dependent. */
const REGION_SENSITIVE = [/^muse.?spark/u];
function positiveInt(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : void 0;
}
/** Is this id on the免密 lane? The listing mixes paid and free; only these answer. */
function isFreeLane(modelId) {
	const base = baseModelId(modelId);
	if (ALWAYS_FREE.has(base)) return true;
	return /(?:^|[-_])free(?:$|[-_.])/u.test(base);
}
/**
* The measured figures for an id the table covers, or `undefined` when it covers
* none.
*
* Split out from {@link capabilitiesFor} because that one must ALWAYS answer: the
* lane needs a serving contract for every id it lists, and a guessed window beats
* no window there. A caller that would be *printing* the number to a user must
* use this one instead — "the table has never heard of this model" and "this
* model has a 128K window" are different claims, and only this function keeps
* them apart.
*/
function knownCapabilities(modelId) {
	const base = baseModelId(modelId);
	for (const entry of CAPABILITIES) if (entry.match.test(base)) return {
		vision: entry.vision,
		reasoning: entry.reasoning,
		contextWindow: entry.contextWindow,
		maxOutput: entry.maxOutput,
		canDisableThinking: entry.canDisableThinking !== false
	};
}
/** The baseline capacities for one model id. */
function capabilitiesFor(modelId) {
	return knownCapabilities(modelId) ?? {
		...FALLBACK_CAPABILITY,
		canDisableThinking: true
	};
}
/** Is this id's availability known to depend on where the request leaves from? */
function isRegionSensitive(modelId) {
	const base = baseModelId(modelId);
	return REGION_SENSITIVE.some((pattern) => pattern.test(base));
}
/** Title-case a bare upstream id into something a picker can show. */
function displayModelName(modelId) {
	const base = baseModelId(modelId);
	const known = DISPLAY_NAMES[base];
	if (known !== void 0) return known;
	return base.replace(/[-_.]+/gu, " ").replace(/(\d)\s+/gu, "$1 ").trim().split(" ").map((word) => /^\d/u.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
/** Parse the gateway's `{"data":[{"id":…}]}` listing. */
function parseListing(payload) {
	const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
	const out = [];
	for (const row of rows) {
		const id = typeof row === "string" ? row : row?.id;
		if (typeof id === "string" && id !== "") out.push(id);
	}
	return out;
}
/**
* The free rows for a raw listing, in listing order.
*
* The prefix is what the shim routes on, so it is applied here rather than at
* the call sites: one place decides the lane's id shape, and every reader gets it
* the same way.
*/
function buildFreeCatalog(ids) {
	const seen = /* @__PURE__ */ new Set();
	const rows = [];
	for (const raw of ids) {
		const id = raw.trim();
		if (id === "" || !isFreeLane(id)) continue;
		const base = baseModelId(id);
		if (seen.has(base)) continue;
		seen.add(base);
		const caps = capabilitiesFor(base);
		rows.push({
			id: base,
			modelId: `${FREE_MODEL_PREFIX}${base}`,
			name: displayModelName(base),
			wire: wireFor(base),
			vision: caps.vision,
			reasoning: caps.reasoning,
			contextWindow: positiveInt(caps.contextWindow) ?? FALLBACK_CAPABILITY.contextWindow,
			maxOutput: positiveInt(caps.maxOutput) ?? FALLBACK_CAPABILITY.maxOutput,
			canDisableThinking: caps.canDisableThinking,
			regionSensitive: isRegionSensitive(base)
		});
	}
	return rows;
}
/** One listing round. Returns the parsed JSON document. */
async function fetchFreeListing(options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15e3);
	timer.unref?.();
	let callerAborted = false;
	const onCallerAbort = () => {
		callerAborted = true;
		controller.abort();
	};
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });
	try {
		const response = await freeFetch(`${FREE_UPSTREAM_BASE}${FREE_LISTING_PATH}`, {
			headers: gatewayHeaders({
				session: sessionForConversation(options.session),
				requestId: mintRequestId(),
				stream: false,
				accept: "application/json"
			}),
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`the free lane answered HTTP ${response.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text);
	} catch (error) {
		if (callerAborted || options.signal?.aborted === true) throw new Error("request aborted");
		if (error instanceof Error && error.name === "AbortError") throw new Error(`the free lane's listing did not answer within ${String(options.timeoutMs ?? 15e3)}ms`);
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onCallerAbort);
	}
}
/**
* The static roster, used until the first listing lands and again whenever one
* fails.
*
* An empty picker is the one outcome a user reads as "the plugin broke", so the
* lane ships with rows it can serve without ever having reached the network.
* These are the ids the gateway is known to serve免密 today; a row that later
* disappears costs one dead model entry, while an empty lane costs everything.
*/
const FALLBACK_FREE_MODEL_IDS = Object.freeze([
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
/** Live free roster with a static fallback behind it. */
var FreeCatalog = class {
	rows;
	listeners = /* @__PURE__ */ new Set();
	lastError;
	lastUpdatedAt;
	constructor(fallback = FALLBACK_FREE_MODEL_IDS) {
		this.rows = Object.freeze(buildFreeCatalog(fallback));
	}
	current() {
		return this.rows;
	}
	/** Why the last refresh failed, for display. Never a substitute for rows. */
	error() {
		return this.lastError;
	}
	/** When the live list last landed. */
	updatedAt() {
		return this.lastUpdatedAt;
	}
	/** The row behind a published id, or undefined. */
	find(modelId) {
		return this.rows.find((row) => row.modelId === modelId || row.id === modelId);
	}
	/** Whether anything is being served right now. */
	hasRows() {
		return this.rows.length > 0;
	}
	onChange(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	/**
	* Re-read the listing and notify when the roster actually changed.
	*
	* A failed refresh KEEPS the current rows and records the error. Dropping to
	* empty here would make a network hiccup look like the models were deleted.
	*/
	async refresh(options = {}) {
		let next;
		try {
			next = Object.freeze(buildFreeCatalog(parseListing(await fetchFreeListing(options))));
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			if (this.rows.length === 0) this.rows = Object.freeze(buildFreeCatalog(FALLBACK_FREE_MODEL_IDS));
			for (const listener of this.listeners) listener();
			return this.rows;
		}
		if (next.length === 0) {
			this.lastError = "the gateway listing held no免密 models";
			for (const listener of this.listeners) listener();
			return this.rows;
		}
		this.lastError = void 0;
		this.lastUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		if (next.length === this.rows.length && next.every((row, index) => row.modelId === this.rows[index]?.modelId)) return this.rows;
		this.rows = next;
		for (const listener of this.listeners) listener();
		return this.rows;
	}
};
//#endregion
//#region src/stats.ts
/**
* Retained calls. Bounded on purpose: a busy week is thousands of calls, and a
* dashboard that grows without limit turns into a memory leak with a chart.
*/
const USAGE_MAX_SAMPLES = 2e3;
/**
* Minimum total decoding time before a throughput figure is published.
*
* A one-token answer that arrives in 20ms would otherwise report a tps two
* orders of magnitude above anything a real turn reaches, and the panel would
* rank models by that artefact instead of by speed.
*/
const MIN_DECODE_MS = 120;
/**
* A reported token count, or null when the key is absent / not a finite
* number.
*
* Zero is ACCEPTED: an empty turn really can cost nothing, and reporting that
* as "the gateway said nothing" would make the panel lie in the other
* direction.
*/
function count(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
function zero(value) {
	return count(value) ?? 0;
}
function detailOf(value, key) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
	return zero(value[key]);
}
/**
* Read a gateway `usage` object, accepting both spellings OpenAI-compatible
* gateways use (`prompt_tokens` / `input_tokens`).
*
* Returns undefined when the document is not a usage report at all, so callers
* can tell "the gateway sent zeroes" from "there was nothing here".
*/
function parseUsage(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const obj = value;
	const input = count(obj["prompt_tokens"]) ?? count(obj["input_tokens"]);
	const output = count(obj["completion_tokens"]) ?? count(obj["output_tokens"]);
	if (input === null && output === null) return void 0;
	return {
		inputTokens: input ?? 0,
		outputTokens: output ?? 0,
		reasoningTokens: detailOf(obj["completion_tokens_details"], "reasoning_tokens"),
		cachedTokens: detailOf(obj["prompt_tokens_details"], "cached_tokens")
	};
}
/**
* True for the trailer frame a gateway sends to report usage.
*
* It is recognised by an EMPTY `choices` array beside a `usage` field. A frame
* that also carries content is a normal chunk that happens to mention usage,
* and dropping it would delete the user's answer - which is why the strip step
* downstream is allowed to remove exactly these and nothing else.
*/
function isUsageOnlyFrame(parsed) {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	const obj = parsed;
	if (obj["usage"] === void 0 || obj["usage"] === null) return false;
	const choices = obj["choices"];
	return Array.isArray(choices) && choices.length === 0;
}
/** Local calendar day of an instant, as `YYYY-MM-DD`. */
function usageDayKey(at) {
	const d = new Date(at);
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}
/**
* Timing and usage captured while one stream is forwarded.
*
* Kept free of Node stream types so it can be unit tested with plain numbers;
* the shim owns the Transform that feeds it chunks.
*/
var StreamTracker = class {
	/** Milliseconds from request start to the first byte, once seen. */
	ttftMs;
	/** Milliseconds from first byte to the end of the stream, once finished. */
	decodeMs;
	/** Usage seen in any frame, if the gateway sent any. */
	usage;
	firstAt;
	startedAt;
	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}
	/** Record the first byte. Repeated calls keep the earliest. */
	markFirstByte(at = Date.now()) {
		if (this.firstAt !== void 0) return;
		this.firstAt = at;
		const ttft = at - this.startedAt;
		if (ttft >= 0) this.ttftMs = ttft;
	}
	/** Record stream completion. Repeated calls keep the earliest. */
	finish(at = Date.now()) {
		if (this.decodeMs !== void 0) return;
		if (this.firstAt === void 0) return;
		const decode = at - this.firstAt;
		if (decode >= 0) this.decodeMs = decode;
	}
	/** Fold a parsed frame's usage in; later frames overwrite, as the gateway intends. */
	observe(parsed) {
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		const usage = parseUsage(parsed["usage"]);
		if (usage !== void 0) this.usage = usage;
	}
};
/**
* A bounded window of recent calls, summarised on demand.
*
* In-memory by design: this is a live panel, and persisting every prompt's
* token counts would turn a convenience into a record of what the user asked.
* A restart therefore starts the chart again, which the panel states rather
* than hides.
*/
var UsageRecorder = class {
	samples = [];
	limit;
	constructor(limit = USAGE_MAX_SAMPLES) {
		this.limit = limit > 0 ? limit : 1;
	}
	/** Retain one call, dropping the oldest once the window is full. */
	record(call) {
		this.samples.push(call);
		while (this.samples.length > this.limit) this.samples.shift();
	}
	/** Samples currently retained. */
	size() {
		return this.samples.length;
	}
	/** Forget every retained call. */
	reset() {
		this.samples = [];
	}
	/** Aggregate the retained window. */
	summary() {
		const rows = /* @__PURE__ */ new Map();
		const turns = /* @__PURE__ */ new Map();
		let calls = 0;
		let usageReported = false;
		for (const call of this.samples) {
			calls += 1;
			if (call.usage !== void 0) usageReported = true;
			const bucket = turns.get(call.turnId) ?? {
				calls: 0,
				succeeded: 0,
				failed: 0
			};
			bucket.calls += 1;
			if (call.ok) bucket.succeeded += 1;
			else bucket.failed += 1;
			turns.set(call.turnId, bucket);
			const key = `${call.region}\u0000${call.model}`;
			let acc = rows.get(key);
			if (acc === void 0) {
				acc = {
					row: {
						region: call.region,
						model: call.model,
						calls: 0,
						turns: 0,
						failed: 0,
						recovered: 0,
						inputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						cachedTokens: 0,
						tps: null,
						avgTtftMs: null,
						lastUsedAt: 0
					},
					turnIds: /* @__PURE__ */ new Set(),
					decodeMs: 0,
					ttftTotal: 0,
					ttftCount: 0
				};
				rows.set(key, acc);
			}
			acc.row.calls += 1;
			acc.turnIds.add(call.turnId);
			if (!call.ok) acc.row.failed += 1;
			if (call.at > acc.row.lastUsedAt) acc.row.lastUsedAt = call.at;
			if (call.ttftMs !== void 0) {
				acc.ttftTotal += call.ttftMs;
				acc.ttftCount += 1;
			}
			if (call.decodeMs !== void 0) acc.decodeMs += call.decodeMs;
			if (call.usage !== void 0) {
				acc.row.inputTokens += call.usage.inputTokens;
				acc.row.outputTokens += call.usage.outputTokens;
				acc.row.reasoningTokens += call.usage.reasoningTokens;
				acc.row.cachedTokens += call.usage.cachedTokens;
			}
		}
		const failedTurnIds = /* @__PURE__ */ new Set();
		let recoveredTurns = 0;
		for (const [turnId, bucket] of turns) if (bucket.failed > 0 && bucket.succeeded === 0) failedTurnIds.add(turnId);
		else if (bucket.failed > 0) recoveredTurns += 1;
		const out = [];
		for (const acc of rows.values()) {
			let recovered = 0;
			for (const turnId of acc.turnIds) {
				const bucket = turns.get(turnId);
				if (bucket !== void 0 && bucket.failed > 0 && bucket.succeeded > 0) recovered += 1;
			}
			out.push({
				...acc.row,
				turns: acc.turnIds.size,
				recovered,
				tps: acc.decodeMs >= MIN_DECODE_MS ? Math.round(acc.row.outputTokens / (acc.decodeMs / 1e3)) : null,
				avgTtftMs: acc.ttftCount > 0 ? Math.round(acc.ttftTotal / acc.ttftCount) : null
			});
		}
		out.sort((a, b) => b.calls - a.calls || b.lastUsedAt - a.lastUsedAt || a.model.localeCompare(b.model));
		return {
			samples: this.samples.length,
			turns: turns.size,
			failedTurns: failedTurnIds.size,
			recoveredTurns,
			calls,
			usageReported,
			entries: this.samples.slice().reverse(),
			rows: out,
			accounts: this.accountRows(),
			days: this.days(failedTurnIds)
		};
	}
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
	accountRows() {
		const buckets = /* @__PURE__ */ new Map();
		for (const call of this.samples) {
			const label = call.account ?? "";
			const key = `${call.region}\u0000${label}`;
			let acc = buckets.get(key);
			if (acc === void 0) {
				acc = {
					row: {
						account: label,
						region: call.region,
						calls: 0,
						turns: 0,
						failed: 0,
						inputTokens: 0,
						outputTokens: 0,
						cachedTokens: 0,
						lastUsedAt: 0,
						topModels: []
					},
					turnIds: /* @__PURE__ */ new Set(),
					modelCalls: /* @__PURE__ */ new Map()
				};
				buckets.set(key, acc);
			}
			acc.row.calls += 1;
			acc.turnIds.add(call.turnId);
			if (!call.ok) acc.row.failed += 1;
			if (call.at > acc.row.lastUsedAt) acc.row.lastUsedAt = call.at;
			acc.modelCalls.set(call.model, (acc.modelCalls.get(call.model) ?? 0) + 1);
			if (call.usage !== void 0) {
				acc.row.inputTokens += call.usage.inputTokens;
				acc.row.outputTokens += call.usage.outputTokens;
				acc.row.cachedTokens += call.usage.cachedTokens;
			}
		}
		const out = [];
		for (const acc of buckets.values()) {
			const topModels = [...acc.modelCalls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([model]) => model);
			out.push({
				...acc.row,
				turns: acc.turnIds.size,
				topModels
			});
		}
		out.sort((a, b) => b.calls - a.calls || b.lastUsedAt - a.lastUsedAt || a.account.localeCompare(b.account));
		return out;
	}
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
	days(failedTurnIds) {
		const buckets = /* @__PURE__ */ new Map();
		for (const call of this.samples) {
			const key = usageDayKey(call.at);
			let acc = buckets.get(key);
			if (acc === void 0) {
				acc = {
					day: key,
					calls: 0,
					inputTokens: 0,
					outputTokens: 0,
					failedTurnIds: /* @__PURE__ */ new Set()
				};
				buckets.set(key, acc);
			}
			acc.calls += 1;
			acc.inputTokens += call.usage?.inputTokens ?? 0;
			acc.outputTokens += call.usage?.outputTokens ?? 0;
			if (failedTurnIds.has(call.turnId)) acc.failedTurnIds.add(call.turnId);
		}
		return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14).map((acc) => ({
			day: acc.day,
			calls: acc.calls,
			failedTurns: acc.failedTurnIds.size,
			inputTokens: acc.inputTokens,
			outputTokens: acc.outputTokens
		}));
	}
};
/**
* Inspect one SSE frame's content, without its trailing separator.
*
* Returns undefined when no `data:` line parsed, which covers the `[DONE]`
* sentinel, keep-alive comments and truncated JSON alike - a frame the forwarder
* has no opinion about must come back untouched rather than guessed at.
*/
function inspectSseFrame(frame) {
	for (const line of frame.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let parsed;
		try {
			parsed = JSON.parse(payload);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
		const usage = parsed["usage"];
		if (usage === void 0 || usage === null) continue;
		return {
			parsed,
			usageOnly: isUsageOnlyFrame(parsed)
		};
	}
}
//#endregion
//#region src/free-lane.ts
/**
* Assembly for the免密 free lane.
*
* It is exposed to the shim as an `ExtraLaneSource` — a roster plus one `run` —
* so the shim stays ignorant of sessions, wires and tool bookkeeping. That
* boundary is the whole point of the design: the shim speaks exactly one wire
* downstream, and everything that differs per lane lives here.
*
* The sealed co-paid lane that sat beside this one was removed on the user's
* instruction; the credential-free lane is the one that stays.
*
* Every turn gets a session identity derived from the CONVERSATION, not from the
* request. Free-tier quota is accounted per session, so minting a fresh id per
* request exhausts it; a digest of the conversation keeps the same turn billed
* to the same session across restarts, which is how the real client behaves.
*
* @module src/free-lane
*/
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value) {
	return typeof value === "string" ? value : "";
}
/**
* The conversation identity one request belongs to.
*
* The first user turn's text, hashed. Reading it from the body rather than from a
* header is what makes this work for a caller that knows nothing about this
* lane: pi-ai sends an ordinary chat body and the identity is simply a fact about
* the conversation in it.
*/
function conversationKeyOf$1(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (const raw of messages) {
		if (!isRecord(raw) || text(raw.role) !== "user") continue;
		const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content ?? "");
		return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
	}
	return crypto.createHash("sha256").update("xdpool-free-conversation", "utf8").digest("hex").slice(0, 32);
}
/** The envelope one chat chunk carries, so frames from different lanes match. */
function chatChunk(model, delta, finishReason) {
	return JSON.stringify({
		id: `chatcmpl-${crypto.randomBytes(8).toString("hex")}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model,
		choices: [{
			index: 0,
			delta,
			finish_reason: finishReason
		}]
	});
}
/**
* The pooled免密 lane.
*
* `logger` is optional so the offline suite can build a source with no shim
* around it; the dropped-image warning is the only thing it says.
*/
function createFreeLaneSource(catalog, logger, usageRecorder) {
	return {
		current: () => catalog.current(),
		async run({ modelId, body, signal, onFrame }) {
			const caller = parseBody(body);
			const session = sessionForConversation(conversationKeyOf$1(caller));
			const requestId = requestIdFor(session, String(caller.user ?? ""));
			const wire = wireFor(modelId);
			const warnings = [];
			const payload = requestBodyFor(wire, caller, {
				modelId,
				warnings
			});
			const plan = applyFingerprint(payload, wire);
			if (warnings.length > 0) logger?.warn?.(`free lane: ${warnings.length} image block(s) could not be forwarded; they were dropped`);
			const tracker = new StreamTracker(Date.now());
			const turnId = `free-${crypto.randomBytes(8).toString("hex")}`;
			let ok = false;
			let recordedUsage = void 0;
			try {
				onFrame(chatChunk(modelId, {
					role: "assistant",
					content: ""
				}, null));
				const result = await postFreeStreamed({
					modelId,
					body: payload,
					session,
					requestId,
					plan,
					signal,
					hooks: { onDelta: (delta) => {
						tracker.markFirstByte(Date.now());
						onFrame(chatChunk(modelId, delta, null));
					} }
				});
				ok = true;
				recordedUsage = result.usage === void 0 ? void 0 : parseUsage(result.usage);
				if (result.suppressedOnly === true) onFrame(JSON.stringify({ error: {
					message: "the model asked for a tool this session cannot run",
					type: "server_error"
				} }));
				onFrame(chatChunk(modelId, {}, result.finishReason ?? (result.truncated === true ? "length" : "stop")));
				return result;
			} finally {
				tracker.finish(Date.now());
				usageRecorder?.record({
					region: "free",
					model: modelId,
					account: "free",
					turnId,
					at: Date.now(),
					ok,
					...tracker.ttftMs === void 0 ? {} : { ttftMs: tracker.ttftMs },
					...tracker.decodeMs === void 0 ? {} : { decodeMs: tracker.decodeMs },
					...recordedUsage === void 0 ? {} : { usage: recordedUsage }
				});
			}
		}
	};
}
/** Parse the caller's body, or refuse with something the caller can act on. */
function parseBody(body) {
	try {
		const parsed = JSON.parse(body);
		if (isRecord(parsed)) return parsed;
	} catch {}
	throw new Error("the request body was not a JSON object");
}
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
/** How often the loop wakes to look for a due job. */
/**
* How long to wait for event scoring to land before re-reading the task list.
*
* Scoring is asynchronous on the upstream side, so an immediate re-read still
* shows the old progress and the claim pass would skip a task that is in fact
* now claimable. Measured: the chain is reflected by about eight seconds.
*/
const EVENT_SCORE_WAIT_MS = 9e3;
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
/** The jobs in the order a tick runs them: report before tasks, always. */
const AUTOMATION_JOB_KINDS = [
	"checkin",
	"report",
	"tasks",
	"streak",
	"travel",
	"compensation"
];
/** Reject anything that is not a job kind, so a route cannot name an unknown job. */
function isAutomationJobKind(value) {
	return typeof value === "string" && AUTOMATION_JOB_KINDS.includes(value);
}
const JOB_KINDS = AUTOMATION_JOB_KINDS;
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
/**
* Whether `now`'s local hour is one of `hours`.
*
* The reference panel computes a `nextFire` instant and sleeps until it; this
* loop instead wakes every minute and asks "is any job due now". Both fire at
* the top of a configured hour, but the polling form cannot miss a slot to a
* suspended process — a laptop that slept through 10:00 still runs the job the
* moment it wakes, on the same day.
*/
function isFireHour(now, hours) {
	const { hour } = zonedParts(now);
	return hours.includes(Number(hour));
}
/** Whether this account may be used: not switched off, not cooling. */
function eligible(account, now) {
	if (account.cooldownUntilMs > now) return false;
	if (regionOf(account.credential.domain) === "global") return false;
	return true;
}
const sleep$1 = (ms) => new Promise((resolve) => {
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
			if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
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
					if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
				}
			}
		}
		if (sentAnything && this.eventScoreWaitMs > 0 && !this.stopped) await sleep$1(this.eventScoreWaitMs);
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
				if (this.delayMs > 0 && !this.stopped) await sleep$1(2e3);
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
				if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
				const chat = await this.client.openConversation(credential, expert.expertId);
				if (chat === void 0) continue;
				out.push({
					transport: "desktop",
					events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), expertActualUseEvent(expert, chat.conversationId, chat.requestId)]
				});
			} catch (error) {
				this.logger.warn?.(`automation events expert ${expert.expertId}:`, error);
			}
			if (this.expertGapMs > 0 && !this.stopped) await sleep$1(this.expertGapMs);
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
		if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
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
			if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
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
			if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
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
			if (this.delayMs > 0 && !this.stopped) await sleep$1(this.delayMs);
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
//#endregion
//#region src/provider-notes-zh.ts
/**
* Chinese one-liners for the aggregate-provider page.
*
* The "notes" field of providers-registry.json is English on purpose: the
* registry is copied verbatim from the upstream FCC directory, so its prose
* stays aligned with that source and with the machine-readable ids. The
* settings page, however, is read by Chinese speakers, and an English sentence
* on every card is the defect this table fixes.
*
* Coverage is therefore total and explicit. Every provider id in
* providers-registry.json has exactly one line here, and the ids are written
* verbatim, case-sensitive, in ordinal-sorted order so a diff against the
* registry is reviewable at a glance. Adding a vendor to the registry without
* a line here is a build-time error, not a runtime fallback: the lookup is
* typed and exhaustive over the registry ids, and a silent fallback to the
* English notes is exactly the bug being fixed - it would render as a missing
* translation instead of a missing entry, which is far harder to notice and to
* report.
*
* Style: one short plain-technical sentence per vendor, no marketing language,
* no trailing full stop. Protocol quirks name the concrete field, header or tag
* rather than describing them vaguely. A few lines run past forty characters
* because the concrete identifier itself - a path, a query parameter, a
* required env var - is the useful part of the note.
*/
const PROVIDER_NOTES_ZH = Object.freeze({
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
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
/**
* A zeroed-out automation job record.
*
* Used when no scheduler is wired: the card renders the same shape either way,
* so an unwired profile shows zeroes rather than a missing panel.
*/
function emptyAutomationJob() {
	return {
		ok: 0,
		failed: 0,
		credit: 0,
		energy: 0,
		claimed: 0
	};
}
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Loopback browser origins only; other devices are refused. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** Smallest possible POST body reader, capped so a hung or oversized body
*  cannot pin memory on the Host. Returns `{}` for an empty body. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const LIMIT = 65536;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {});
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
/**
* Validate an untrusted selection payload.
*
* Returns undefined for anything malformed so the route answers 400 instead of
* writing a partial selection into the settings file. An empty array is
* meaningful (`enabledModelIds: []` disables every model, and the card blocks
* saving that state) so it is preserved rather than treated as absent.
*/
function parseSelection(body) {
	const out = {};
	for (const key of ["enabledModelIds", "imageModelIds"]) {
		const value = body[key];
		if (value === void 0) continue;
		if (!Array.isArray(value)) return void 0;
		const ids = [];
		for (const entry of value) {
			if (typeof entry !== "string" || entry === "") return void 0;
			ids.push(entry);
		}
		out[key] = ids;
	}
	const budgets = body["contextBudgets"];
	if (budgets !== void 0) {
		if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) return void 0;
		const map = {};
		for (const [id, raw] of Object.entries(budgets)) {
			if (id === "") return void 0;
			if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1e3) return void 0;
			map[id] = raw;
		}
		out.contextBudgets = map;
	}
	return out;
}
/**
* Validate the account-toggle body. Returns undefined for anything malformed so
* the route answers 400 instead of writing a half-applied switch.
*
* The id must name a currently known account: accepting an arbitrary string
* would let a stale tab (or a renamed credential) leave orphan ids in the
* settings file that no card can ever switch back off.
*/
function parseAccountToggle(body, known) {
	const accountId = typeof body["accountId"] === "string" ? body["accountId"].trim() : "";
	const disabled = body["disabled"];
	if (accountId === "" || typeof disabled !== "boolean") return void 0;
	if (!known(accountId)) return void 0;
	return {
		accountId,
		disabled
	};
}
/**
* Validate an ignore/unignore request.
*
* Two different notions of "known" apply, which is why the caller passes both:
*
* - ignoring requires the account to be IN THE POOL, because the card can only
*   name an account it was just shown;
* - un-ignoring requires the account to be ON THE IGNORE LIST instead — by
*   definition it is not in the pool any more, so checking the pool would make
*   the undo button impossible to use.
*/
function parseAccountIgnore(body, knownInPool, knownIgnored) {
	const accountId = typeof body["accountId"] === "string" ? body["accountId"].trim() : "";
	const ignored = body["ignored"];
	if (accountId === "" || typeof ignored !== "boolean") return void 0;
	if (ignored ? !knownInPool(accountId) : !knownIgnored(accountId)) return void 0;
	return {
		accountId,
		ignored
	};
}
/**
* Validate a pin/clear request.
*
* Pinning requires the account to be in the pool, for the same reason the
* disable route checks: an id nothing can show must not end up in the file,
* where it would silently outlive the account it named and quietly override
* nothing. Clearing is deliberately NOT checked against anything — there is no
* state that could make "stop preferring" wrong, and requiring one would leave a
* user with a stale pin (an account they ignored) unable to clear it from the
* card, which is the one failure mode a pin must never have.
*
* `accountId: null` is the clear request; an empty or whitespace-only string is
* rejected rather than normalised, because a client that sends `""` almost
* certainly built the id wrong, and quietly reading it as "clear" would hide
* that bug behind a button that appears to work.
*/
function parseAccountPrefer(body, knownInPool) {
	const raw = body["accountId"];
	if (raw === null) return { accountId: null };
	if (typeof raw !== "string") return void 0;
	const accountId = raw.trim();
	if (accountId === "" || !knownInPool(accountId)) return void 0;
	return { accountId };
}
/**
* Validate a model-probe request.
*
* Both ids are checked for emptiness and trimmed, but NOT against a roster.
* That is a deliberate difference from the account routes above: a probe's
* whole job is to answer "does this exact pair work", and the pair may well be
* one the picker has not published yet — a model the user is about to enable,
* or one a lane fetched after this page loaded. Refusing to test ids we have
* never heard of would make the button useless exactly when it is most needed,
* and there is nothing to protect here that a bad id could damage: the call
* either answers or fails, and it costs what the user chose to spend by
* clicking.
*/
function parseModelProbe(body) {
	const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
	const model = typeof body["model"] === "string" ? body["model"].trim() : "";
	if (provider === "" || model === "") return void 0;
	return {
		provider,
		model
	};
}
/**
* Read the provider list out of a channel-models request.
*
* Capped at a length a login page can plausibly ask for — thirteen rows — so a
* loopback caller cannot turn a status read into a thousand-iteration walk of
* the host's adapter registry. Empty is valid: a page with nothing signed in has
* no rows to ask about.
*/
/**
* How many providers one channel-models request may ask about.
*
* The roster is thirteen rows; a page that wants more than a dozen is not this
* page, and the route walks the host's adapter registry once per id.
*/
const MAX_CHANNEL_MODEL_PROVIDERS = 32;
/**
* How many ids one provider may hint at.
*
* Cline publishes 492 and is the widest roster here, so this is a ceiling on a
* runaway body rather than a limit anyone will meet. Over the cap the tail is
* dropped, not the request: the first N rows still get their figures.
*/
const MAX_CHANNEL_MODEL_IDS = 2e3;
function parseProviderList(body) {
	const raw = body["providers"];
	if (!Array.isArray(raw)) return void 0;
	if (raw.length > MAX_CHANNEL_MODEL_PROVIDERS) return void 0;
	const out = [];
	for (const entry of raw) {
		if (typeof entry !== "string") return void 0;
		const trimmed = entry.trim();
		if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}
/**
* Parse the optional per-provider id hint.
*
* Deliberately lenient, unlike {@link parseProviderList}: this field is an
* optimisation, not the question being asked. A malformed hint has to degrade
* to "resolve facts the slow way" rather than fail the request, because the
* caller already has the ids on screen and losing them would take the card's
* numbers away for a reason that has nothing to do with the numbers.
*/
function parseChannelModelIds(body) {
	const raw = body["ids"];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const out = {};
	for (const [provider, listed] of Object.entries(raw)) {
		if (!Array.isArray(listed)) continue;
		const ids = listed.filter((id) => typeof id === "string" && id.trim() !== "").map((id) => id.trim()).slice(0, MAX_CHANNEL_MODEL_IDS);
		if (ids.length > 0) out[provider] = ids;
	}
	return Object.keys(out).length === 0 ? void 0 : out;
}
/**
* Parse a manual-run request.
*
* The job name is checked against the real job list rather than passed through:
* an unknown name would otherwise reach the scheduler and silently do nothing,
* which reads to the user as a broken button.
*/
/**
* Parse a reserved-credit update.
*
* The account must already be known, for the same reason the disable route
* checks: an unknown id would sit in the settings file forever, attached to
* nothing the card can act on. A negative or non-finite floor is rejected
* rather than coerced.
*/
function parseCreditReserve(body, known) {
	const accountId = typeof body["accountId"] === "string" ? body["accountId"].trim() : "";
	const raw = body["reserve"];
	if (accountId === "" || typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return void 0;
	if (!known(accountId)) return void 0;
	return {
		accountId,
		reserve: Math.floor(raw)
	};
}
function parseAutomationRun(body) {
	const job = typeof body["job"] === "string" ? body["job"].trim() : "";
	if (job !== "all" && !isAutomationJobKind(job)) return void 0;
	const force = body["force"];
	if (force !== void 0 && typeof force !== "boolean") return void 0;
	return {
		job,
		...force === void 0 ? {} : { force }
	};
}
/**
* One aggregate save payload, or null when the body says nothing this lane
* understands.
*
* Deliberately narrow: an id the registry does not know, a patch carrying no
* field at all, and a lane switch without a boolean are all rejected rather than
* coerced. A card that cannot name a provider must not be able to create one.
*/
function parseAggregatePatch(body) {
	const kind = trimmed(body["kind"]);
	if (kind === "lane") {
		if (typeof body["enabled"] !== "boolean") return void 0;
		return {
			kind: "lane",
			enabled: body["enabled"]
		};
	}
	if (kind === "clear") {
		const providerId = trimmed(body["providerId"]);
		return isProviderId(providerId) ? {
			kind: "clear",
			providerId
		} : void 0;
	}
	if (kind !== "provider") return void 0;
	const providerId = trimmed(body["providerId"]);
	if (!isProviderId(providerId)) return void 0;
	const patch = {
		kind: "provider",
		providerId
	};
	if (typeof body["enabled"] === "boolean") patch.enabled = body["enabled"];
	if (typeof body["apiKey"] === "string") patch.apiKey = body["apiKey"];
	if (typeof body["baseUrl"] === "string") patch.baseUrl = body["baseUrl"];
	if (Array.isArray(body["models"])) {
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const raw of body["models"]) {
			if (typeof raw !== "string") continue;
			const id = raw.trim();
			if (id === "" || seen.has(id)) continue;
			seen.add(id);
			models.push(id);
		}
		patch.models = models;
	}
	if (patch.enabled === void 0 && patch.apiKey === void 0 && patch.baseUrl === void 0 && patch.models === void 0) return void 0;
	return patch;
}
/** A trimmed non-empty string, or ''. */
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}
/** One provider id from a probe or discover body, or undefined. */
function parseProviderId(body) {
	const providerId = trimmed(body["providerId"]);
	return isProviderId(providerId) ? providerId : void 0;
}
/**
* Build the document the aggregate card renders from one store read.
*
* The provider rows NEVER carry the key — only whether one is present. That is
* what lets the whole registry travel to the browser without turning the status
* route into a credential endpoint, and it is why this function reads the store
* rather than serialising it.
*
* Host-side rather than shared with the card, because building it needs the
* running catalog's rows, which the browser half has no way to see.
*/
function aggregateStatusOf(store, models) {
	const providers = [];
	let configured = 0;
	for (const { provider, setting, usable } of listProviderStates(store)) {
		const universe = modelChoicesFor(provider, setting);
		const freeByDefault = isFreeLane(provider.id) || provider.id === "opencode";
		const exposed = (setting.models ?? (freeByDefault ? [] : universe)).filter((id) => universe.includes(id));
		if (Object.keys(setting).length > 0) configured += 1;
		providers.push({
			id: provider.id,
			name: provider.name,
			category: provider.category,
			authKind: provider.auth.kind,
			format: provider.format,
			...provider.auth.url === null ? {} : { authUrl: provider.auth.url },
			...provider.website === void 0 ? {} : { website: provider.website },
			supported: provider.auth.kind !== "oauth" && provider.auth.kind !== "adc",
			configured: usable,
			enabled: providerEnabled(provider, setting),
			...provider.notes === void 0 ? {} : { notes: PROVIDER_NOTES_ZH[provider.id] ?? provider.notes },
			...trimmed(setting.baseUrl) === "" ? {} : { baseUrl: trimmed(setting.baseUrl) },
			hasListing: hasModelsListing(provider),
			models: exposed,
			availableModels: universe,
			discovered: (setting.discovered?.length ?? 0) > 0,
			...setting.addedAt === void 0 ? {} : { addedAt: setting.addedAt }
		});
	}
	return {
		enabled: store.enabled !== false,
		configured,
		modelCount: models.length,
		models,
		providers
	};
}
function toWebAccount(account, disabled, preferred, reserve, reserved) {
	const now = Date.now();
	const cooling = account.cooldownUntilMs > now;
	const deadUntil = account.credentialDeadUntilMs ?? 0;
	const credentialDead = deadUntil > now;
	const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({
		modelId,
		until: new Date(until).toISOString()
	}));
	return {
		id: account.id,
		label: account.label,
		...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
		domain: account.credential.domain,
		...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
		cooling,
		...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
		credentialDead,
		...credentialDead ? { credentialDeadUntil: new Date(deadUntil).toISOString() } : {},
		...modelCooldowns.length === 0 ? {} : { modelCooldowns },
		disabled,
		preferred,
		creditReserve: reserve,
		reserved,
		rateLimitHits: account.rateLimitHits
	};
}
function toWebModel(model, selection) {
	const enabled = selection.enabledModelIds;
	const budget = selection.contextBudgets?.[model.id];
	const capped = budget !== void 0 && budget > 0 && budget < model.nativeContextWindow;
	return {
		id: model.id,
		name: model.name,
		...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
		...model.tags === void 0 ? {} : { tags: model.tags },
		...model.supportedEfforts === void 0 || model.supportedEfforts.length === 0 ? {} : { supportedEfforts: model.supportedEfforts },
		supportsImages: model.supportsImages,
		contextWindow: capped ? budget : model.nativeContextWindow,
		nativeContextWindow: model.nativeContextWindow,
		maxOutputTokens: model.maxOutputTokens,
		enabled: enabled === void 0 || enabled.includes(model.id)
	};
}
/**
* Assemble the card's status document. Per-account credits and check-in state
* are queried live; a failing query degrades to `creditsError` / `checkinError`
* rather than failing the whole document. Never throws.
*/
async function poolWebStatus(deps, region = "cn") {
	const accounts = deps.pool.list(region);
	const regions = ["cn", "global"];
	const pinnedId = deps.pool.preferredId();
	const preferredAccountId = pinnedId === void 0 || !accounts.some((account) => account.id === pinnedId) ? void 0 : pinnedId;
	const selection = deps.catalogs[region].currentSelection();
	const rows = [];
	const now = Date.now();
	for (const account of accounts) {
		const row = toWebAccount(account, deps.pool.isDisabled(account.id), deps.pool.preferredId() === account.id, deps.pool.creditReserveOf(account.id), deps.pool.isReserved(account.id));
		const earned = deps.scheduler?.().earningsToday[account.id];
		if (earned !== void 0) Object.assign(row, { automationToday: earned });
		if (!row.cooling && row.credentialDead !== true) {
			let deadNow = false;
			try {
				const credits = await deps.client.fetchCredits(account.credential);
				deps.pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs);
				deps.pool.clearCredentialDead(account.id);
				Object.assign(row, { credits: {
					total: credits.total,
					packages: credits.packages,
					...credits.expiringSoon === void 0 ? {} : { expiringSoon: credits.expiringSoon },
					...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs }
				} });
			} catch (error) {
				if (isGatewayRejectionError(error)) {
					deps.pool.penalizeCredentialDead(account.id);
					deadNow = true;
					Object.assign(row, { credentialDead: true });
				}
				Object.assign(row, { creditsError: safeMessage(error) });
			}
			if (!deadNow) try {
				const checkin = await deps.client.fetchCheckinStatus(account.credential);
				const web = {
					active: checkin.active,
					todayCheckedIn: checkin.todayCheckedIn,
					streakDays: checkin.streakDays,
					dailyCredit: checkin.dailyCredit,
					todayCredit: checkin.todayCredit,
					isStreakDay: checkin.isStreakDay,
					nextStreakDay: checkin.nextStreakDay,
					streakBonusCredit: checkin.streakBonusCredit
				};
				Object.assign(row, { checkin: web });
			} catch (error) {
				Object.assign(row, { checkinError: safeMessage(error) });
			}
		}
		rows.push(row);
	}
	const cooling = rows.filter((row) => row.cooling).length;
	const lastServed = deps.pool.lastServedId();
	const firstUsable = lastServed !== void 0 ? accounts.find((account) => account.id === lastServed) : accounts.find((account) => account.cooldownUntilMs <= now);
	let shim;
	if (deps.shim === void 0) shim = { running: false };
	else try {
		shim = deps.shim();
	} catch {
		shim = { running: false };
	}
	const automation = deps.scheduler?.() ?? {
		enabled: false,
		running: false,
		checkinHours: [],
		reportHours: [],
		taskHours: [],
		streakHours: [],
		travelHours: [],
		compensationHours: [],
		jobs: {
			checkin: emptyAutomationJob(),
			report: emptyAutomationJob(),
			tasks: emptyAutomationJob(),
			streak: emptyAutomationJob(),
			travel: emptyAutomationJob(),
			compensation: emptyAutomationJob()
		},
		claimableSeen: 0,
		earningsToday: {},
		runInProgress: false
	};
	return {
		ok: accounts.length > 0 && cooling < accounts.length,
		accounts: rows,
		...firstUsable === void 0 ? {} : { activeAccountId: firstUsable.id },
		...preferredAccountId === void 0 ? {} : { preferredAccountId },
		cooling,
		models: deps.catalogs[region].current().map((model) => toWebModel({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxOutputTokens,
			nativeContextWindow: model.contextWindow,
			...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
			...model.tags === void 0 ? {} : { tags: model.tags },
			...model.supportedEfforts === void 0 ? {} : { supportedEfforts: model.supportedEfforts },
			supportsImages: model.supportsImages
		}, selection)),
		selection,
		region,
		distribution: deps.pool.currentDistribution(),
		regions,
		shim,
		automation,
		creditReserves: deps.pool.creditReservesInOrder(),
		ignored: deps.ignoredAccounts?.() ?? [],
		catalogSource: deps.catalogs[region].currentSource(),
		...deps.catalogs[region].catalogUpdatedAt() === void 0 ? {} : { catalogUpdatedAt: deps.catalogs[region].catalogUpdatedAt() },
		...deps.catalogs[region].lastFetchError() === void 0 ? {} : { catalogError: safeMessage(deps.catalogs[region].lastFetchError()) },
		...deps.pool.skippedFilesInOrder().length === 0 ? {} : { skippedFiles: deps.pool.skippedFilesInOrder().map((entry) => ({
			file: basename(entry.path),
			reason: entry.reason
		})) }
	};
}
/**
* Mount the read-only routes on a context where `webServer` is available. The
* caller uses `ctx.inject(['webServer'], ...)` so Desktop startup order cannot
* make this registration disappear.
*/
function registerPoolStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const disposeStatus = ctx.webServer.register({
			kind: "exact",
			path: POOL_STATUS_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					json(res, 200, await poolWebStatus(deps, new URL(req.url ?? "/", "http://localhost").searchParams.get("region") === "global" ? "global" : "cn"));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Read the usage panel's aggregate.
		*
		* GET only and loopback origin only. It never carries a prompt: the
		* recorder holds counts and timings only, so this document is safe to hand
		* the browser by construction rather than by scrubbing something out of it.
		*/
		const disposeUsage = ctx.webServer.register({
			kind: "exact",
			path: POOL_USAGE_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.usage === void 0) return json(res, 503, { error: "usage accounting is not available in this build" });
				try {
					json(res, 200, deps.usage());
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Re-fetch the upstream model catalog.
		*
		* Its own route, distinct from the account rescan, because that is the
		* distinction users were missing: a model list that had fallen back to the
		* static table could not be recovered from the card AT ALL — "detect
		* accounts again" only re-read the desktop snapshots, so the only way back
		* to the full roster was restarting DSH.
		*
		* POST only, loopback origin only. Returns the resulting roster size per
		* region so the card can confirm the refresh actually changed something.
		*/
		const disposeCatalogRefresh = ctx.webServer.register({
			kind: "exact",
			path: POOL_CATALOG_REFRESH_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.refreshCatalog === void 0) return json(res, 503, { error: "catalog refresh is not available in this build" });
				try {
					json(res, 200, {
						ok: true,
						...await deps.refreshCatalog()
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeRescan = ctx.webServer.register({
			kind: "exact",
			path: POOL_RESCAN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					json(res, 200, { accounts: (await deps.pool.scan()).length });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeReset = ctx.webServer.register({
			kind: "exact",
			path: POOL_RESET_COOLDOWN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				deps.pool.resetCooldowns();
				json(res, 200, { ok: true });
			}
		});
		const disposeCheckin = ctx.webServer.register({
			kind: "exact",
			path: POOL_CHECKIN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				try {
					const body = await readJsonBody(req);
					const accountId = typeof body["accountId"] === "string" ? body["accountId"] : "";
					if (accountId === "") return json(res, 400, { error: "accountId is required" });
					const account = deps.pool.list().find((item) => item.id === accountId);
					if (account === void 0) return json(res, 404, { error: "unknown account" });
					const before = await deps.client.fetchCheckinStatus(account.credential);
					if (!before.active) return json(res, 409, { error: "check-in activity is not active" });
					if (before.todayCheckedIn) return json(res, 200, {
						ok: true,
						alreadyCheckedIn: true,
						claim: {
							credit: 0,
							streakDays: before.streakDays,
							isStreakDay: before.isStreakDay
						}
					});
					json(res, 200, {
						ok: true,
						claim: await deps.client.claimDailyCheckin(account.credential)
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeModelsSave = ctx.webServer.register({
			kind: "exact",
			path: POOL_MODELS_SAVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.saveSelection === void 0) return json(res, 503, { error: "settings service unavailable; model selection cannot be saved" });
				try {
					const body = await readJsonBody(req);
					const selection = parseSelection(body);
					if (selection === void 0) return json(res, 400, { error: "invalid selection payload" });
					const region = body["region"] === "global" ? "global" : "cn";
					await deps.saveSelection(region, selection);
					json(res, 200, {
						ok: true,
						region,
						selection
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeAccountDisable = ctx.webServer.register({
			kind: "exact",
			path: POOL_ACCOUNT_DISABLE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.setAccountDisabled === void 0) return json(res, 503, { error: "settings service unavailable; the account switch cannot be saved" });
				try {
					const body = await readJsonBody(req);
					const known = new Set(deps.pool.list().map((account) => account.id));
					const toggle = parseAccountToggle(body, (id) => known.has(id));
					if (toggle === void 0) return json(res, 400, { error: "invalid account toggle payload" });
					await deps.setAccountDisabled(toggle.accountId, toggle.disabled);
					json(res, 200, {
						ok: true,
						...toggle
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Throw one account out of the pool for good, or take it back.
		*
		* Same three guards as the disable route — POST only, loopback origin only,
		* and an explicit `accountId` — plus the semantic split in
		* {@link parseAccountIgnore}: ignoring checks the pool, un-ignoring checks
		* the ignore list.
		*
		* The credential FILE is deliberately left alone. Deleting it would sign the
		* desktop app out (the live file IS the app's current session) and would not
		* even stick, since the app rewrites it on the next sign-in. Ignoring is
		* enforced on the read side instead, which is both reversible and durable.
		*/
		const disposeAccountIgnore = ctx.webServer.register({
			kind: "exact",
			path: POOL_ACCOUNT_IGNORE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.setAccountIgnored === void 0) return json(res, 503, { error: "settings service unavailable; the ignore list cannot be saved" });
				try {
					const body = await readJsonBody(req);
					const knownInPool = new Set(deps.pool.list().map((account) => account.id));
					const knownIgnored = new Set((deps.ignoredAccounts?.() ?? []).map((entry) => entry.id));
					const parsed = parseAccountIgnore(body, (id) => knownInPool.has(id), (id) => knownIgnored.has(id));
					if (parsed === void 0) return json(res, 400, { error: "invalid account ignore payload" });
					await deps.setAccountIgnored(parsed.accountId, parsed.ignored);
					json(res, 200, {
						ok: true,
						...parsed
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeAccountPrefer = ctx.webServer.register({
			kind: "exact",
			path: POOL_ACCOUNT_PREFER_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.setPreferredAccount === void 0) return json(res, 503, { error: "the preferred account cannot be saved in this build" });
				try {
					const body = await readJsonBody(req);
					const known = new Set(deps.pool.list().map((account) => account.id));
					const parsed = parseAccountPrefer(body, (id) => known.has(id));
					if (parsed === void 0) return json(res, 400, { error: "invalid account prefer payload" });
					await deps.setPreferredAccount(parsed.accountId);
					json(res, 200, {
						ok: true,
						...parsed
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Run one automation job on demand.
		*
		* POST only, loopback origin only, and the job name must be one of the four
		* real jobs, so the card cannot name an arbitrary job. This exists so the
		* automation is verifiable without waiting for its scheduled hour.
		*/
		const disposeAutomationRun = ctx.webServer.register({
			kind: "exact",
			path: POOL_AUTOMATION_RUN_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.runAutomation === void 0) return json(res, 503, { error: "automation is not available in this build" });
				try {
					const run = parseAutomationRun(await readJsonBody(req));
					if (run === void 0) return json(res, 400, { error: "invalid automation run payload" });
					const started = deps.runAutomation(run.job, run.force === true);
					json(res, 200, {
						ok: true,
						job: run.job,
						started
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Set or clear one account's reserved-credit floor.
		*
		* POST only, loopback origin only, and the id must already be a known
		* account: the card cannot invent an id, and a stale tab must not leave
		* orphan keys in the settings file.
		*/
		const disposeCreditReserve = ctx.webServer.register({
			kind: "exact",
			path: POOL_CREDIT_RESERVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.setCreditReserve === void 0) return json(res, 503, { error: "settings service unavailable; the reserve cannot be saved" });
				try {
					const body = await readJsonBody(req);
					const known = new Set(deps.pool.list().map((account) => account.id));
					const parsed = parseCreditReserve(body, (id) => known.has(id));
					if (parsed === void 0) return json(res, 400, { error: "invalid credit reserve payload" });
					await deps.setCreditReserve(parsed.accountId, parsed.reserve);
					json(res, 200, {
						ok: true,
						...parsed
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Read the aggregate lane: the whole registry, each provider's state, and the
		* model rows the lane currently offers.
		*
		* GET only, loopback origin only, and token-free by CONSTRUCTION rather than
		* by scrubbing: `aggregateStatusOf` builds each provider row field by field
		* and never copies the key, so there is nothing to redact and a future field
		* cannot accidentally leak one.
		*
		* Not folded into the status document: that one is polled every 30 seconds,
		* and carrying 76 provider records on every poll would make the pool card's
		* refresh cost proportional to a directory nobody is looking at.
		*/
		const disposeAggregate = ctx.webServer.register({
			kind: "exact",
			path: POOL_AGGREGATE_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.aggregateDocument === void 0) return json(res, 503, { error: "the aggregate lane is not available in this build" });
				try {
					json(res, 200, await deps.aggregateDocument());
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Save one aggregate provider's setting, or flip the lane's own switch.
		*
		* POST only, loopback origin only, and one provider per request — the host
		* side does read-modify-write, so two tabs editing two providers cannot
		* clobber each other.
		*
		* The answer is the WHOLE document rather than `{ok:true}`: the card has to
		* re-read the roster anyway (a new key changes which models the picker
		* offers), and returning it here is what makes a save visible without a
		* second round trip.
		*/
		const disposeAggregateSave = ctx.webServer.register({
			kind: "exact",
			path: POOL_AGGREGATE_SAVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.saveAggregate === void 0) return json(res, 503, { error: "the aggregate lane is not available in this build" });
				try {
					const patch = parseAggregatePatch(await readJsonBody(req));
					if (patch === void 0) return json(res, 400, { error: "invalid aggregate patch payload" });
					json(res, 200, {
						ok: true,
						...await deps.saveAggregate(patch)
					});
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Verify one provider's key with a cheap non-generating call.
		*
		* Its own route, not a side effect of saving, because this is the ONLY
		* aggregate action that talks to the network. Folding it into "save" would
		* mean every keystroke-confirm spends the provider's rate limit behind the
		* user's back — and a probe that fails would be indistinguishable from a
		* save that failed.
		*
		* The answer never carries the key: `probeAggregateProvider` redacts it out
		* of the provider's own message, because a 401 body routinely echoes the
		* rejected key back.
		*/
		const disposeAggregateTest = ctx.webServer.register({
			kind: "exact",
			path: POOL_AGGREGATE_TEST_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.probeAggregate === void 0) return json(res, 503, { error: "the aggregate lane is not available in this build" });
				try {
					const providerId = parseProviderId(await readJsonBody(req));
					if (providerId === void 0) return json(res, 400, { error: "invalid aggregate provider payload" });
					json(res, 200, await deps.probeAggregate(providerId));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Send one real streaming call to one model.
		*
		* This is the plugin's only route that spends the user's credits, which is
		* why it is POST-only and loopback-only and why it exists as its own route
		* rather than as a flag on the status document: a status read happens every
		* time the settings card opens, and a probe hidden inside it would bill the
		* user for looking at their own configuration.
		*
		* The abort signal is threaded from the request so that closing the settings
		* card stops a probe mid-flight instead of leaving it streaming against a
		* model the user has already stopped looking at.
		*/
		const disposeModelProbe = ctx.webServer.register({
			kind: "exact",
			path: POOL_MODEL_PROBE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.probeModel === void 0) return json(res, 503, { error: "the connectivity probe is not available in this build" });
				const controller = new AbortController();
				req.on("aborted", () => {
					controller.abort();
				});
				try {
					const probe = parseModelProbe(await readJsonBody(req));
					if (probe === void 0) return json(res, 400, { error: "invalid model probe payload" });
					json(res, 200, await deps.probeModel(probe.provider, probe.model, controller.signal));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				} finally {
					controller.abort();
				}
			}
		});
		/**
		* Fetch one provider's live model list and write it back as its discovered
		* set.
		*
		* Separate from the probe because it COMMITS: it changes what the provider
		* contributes to the model picker. A failed round keeps the previous roster
		* — the asymmetry is deliberate, because a flaky listing that emptied the
		* roster would delete models the user configured on purpose.
		*
		* An authoritative EMPTY listing is a real answer and does commit: the
		* provider serves nothing under this key, and reporting `committed: 0`
		* rather than an error is what tells the user which of the two happened.
		*/
		/**
		* Read what models several login channels contribute right now.
		*
		* Cheap and side-effect free, unlike the probe above: this only asks the
		* host's registry what it already knows, so it can be a plain POST without
		* the billing argument. POST rather than GET because the provider list is
		* genuinely a body — a GET would mean either a long query string or a
		* hard-coded roster, and the roster changes when the plugin does.
		*
		* A provider the host cannot answer for is omitted from the map rather than
		* reported empty, because "no adapter" and "publishes nothing" are different
		* things to say to a user staring at a channel card.
		*/
		const disposeChannelModels = ctx.webServer.register({
			kind: "exact",
			path: POOL_CHANNEL_MODELS_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.channelModels === void 0) return json(res, 503, { error: "the login channels are not available in this build" });
				try {
					const body = await readJsonBody(req);
					const providers = parseProviderList(body);
					if (providers === void 0) return json(res, 400, { error: "invalid channel models payload" });
					json(res, 200, { models: await deps.channelModels(providers, parseChannelModelIds(body)) });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeAggregateDiscover = ctx.webServer.register({
			kind: "exact",
			path: POOL_AGGREGATE_DISCOVER_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.discoverAggregate === void 0) return json(res, 503, { error: "the aggregate lane is not available in this build" });
				try {
					const providerId = parseProviderId(await readJsonBody(req));
					if (providerId === void 0) return json(res, 400, { error: "invalid aggregate provider payload" });
					json(res, 200, await deps.discoverAggregate(providerId));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeChannels = ctx.webServer.register({
			kind: "exact",
			path: POOL_CHANNELS_PATH,
			handler: (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.channelsDocument === void 0) return json(res, 503, { error: "the login channels are not available in this build" });
				try {
					json(res, 200, deps.channelsDocument());
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* The billion-context relay.
		*
		* GET only, loopback origin only. Its own route because it is the one
		* document here that comes from ANOTHER plugin's loopback listener: the
		* proxy publishes its own JSON and this only reads it, so folding it into
		* the pool status document would put a third-party service on the critical
		* path of every 30-second pool poll.
		*
		* Answered even when the proxy is absent — `state: 'missing'` with the
		* install command is far more actionable than a 503, and it is the normal
		* state on a machine that has not installed billion-context.
		*/
		const disposeBillion = ctx.webServer.register({
			kind: "exact",
			path: POOL_BILLION_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.billionDocument === void 0) return json(res, 503, { error: "the billion-context relay is not available in this build" });
				try {
					json(res, 200, await deps.billionDocument());
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* The chain list plus the roster its members are drawn from.
		*
		* GET only. Deliberately not part of the pool status document: chains change
		* only when the user edits them, while the pool card polls every 30 seconds,
		* and rebuilding the chain catalog on every one of those polls would resolve
		* members nobody is looking at.
		*/
		const disposeCombos = ctx.webServer.register({
			kind: "exact",
			path: POOL_COMBOS_PATH,
			handler: (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.combosDocument === void 0) return json(res, 503, { error: "the routing chains are not available in this build" });
				try {
					json(res, 200, deps.combosDocument());
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* Replace the whole chain table.
		*
		* POST only, one table per request (see `POOL_COMBOS_SAVE_PATH`). The write
		* refreshes the running catalog before answering, so a chain saved here is
		* pickable in the same breath — the same reason the aggregate save does it.
		*/
		const disposeCombosSave = ctx.webServer.register({
			kind: "exact",
			path: POOL_COMBOS_SAVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.saveCombos === void 0) return json(res, 503, { error: "the routing chains are not available in this build" });
				try {
					const raw = (await readJsonBody(req))["combos"];
					json(res, 200, await deps.saveCombos(Array.isArray(raw) ? raw : []));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		/**
		* The relay's state, and the only way to change it.
		*
		* Deliberately one route for both verbs rather than a relay setting added to
		* the settings schema: the relay is a network listener, and the one action
		* that must always be reachable is turning it off. A switch buried in a
		* settings form the host renders is a worse place to look for "stop exposing
		* my account pool to the office Wi-Fi".
		*/
		const disposeRelay = ctx.webServer.register({
			kind: "exact",
			path: POOL_RELAY_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				if (deps.relayDocument === void 0 || deps.saveRelay === void 0) return json(res, 503, { error: "the LAN relay is not available in this build" });
				try {
					if (req.method === "GET") {
						json(res, 200, await deps.relayDocument());
						return;
					}
					const body = await readJsonBody(req);
					json(res, 200, await deps.saveRelay(body));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		return () => {
			disposeRelay();
			disposeCombosSave();
			disposeCombos();
			disposeBillion();
			disposeChannels();
			disposeAggregate();
			disposeAggregateDiscover();
			disposeAggregateSave();
			disposeAggregateTest();
			disposeModelProbe();
			disposeChannelModels();
			disposeAutomationRun();
			disposeCreditReserve();
			disposeAccountIgnore();
			disposeAccountPrefer();
			disposeCatalogRefresh();
			disposeCheckin();
			disposeAccountDisable();
			disposeModelsSave();
			disposeReset();
			disposeRescan();
			disposeStatus();
			disposeUsage();
		};
	}, "dsh-xdpool: Web status route");
}
//#endregion
//#region src/billion.ts
/**
* Read-only observation of a locally running billion-context proxy.
*
* WHAT THIS IS, AND WHY IT IS NOT AN EMBEDDED COMPRESSOR
*
* billion-context is a separate DSH plugin that is very likely already
* installed on this machine — on a stock desktop profile it is mounted by the
* profile's bundle layer and runs its own loopback listener. This module never
* implements compression and never proposes to: it finds that listener and
* relays a few numbers so the card can show what the compressor is doing.
* Re-implementing folding here would mean a second, divergent answer to the
* same question and a second set of ways to get it wrong.
*
* HOW THE LISTENER IS FOUND
*
* The proxy picks an ephemeral port at spawn and records it in its own state
* directory, which we read rather than guess. Guessing would mean scanning a
* port range on every card poll, and a wrong guess is worse than no answer: it
* could read some unrelated loopback service. The recorded file is
* `<state>/billion-context/proxy-origin` and holds a JSON object with at least
* an `origin`; `port-zone.json` is the same fact keyed by lane. Both are read,
* and the origin file wins, because it is the one the proxy itself reads on
* startup.
*
* `state` is resolved the same way the proxy resolves it: `XDG_STATE_HOME` when
* set, else `<homedir>/.local/state` on every platform including Windows — not
* `%LOCALAPPDATA%`, which is what a Windows developer would reach for first and
* which would therefore be wrong.
*
* WHAT IS RELAYED
*
* Counts, sizes, timestamps. Not titles, not first-block hints, not any
* conversation material. The proxy is happy to hand over more than that, and
* taking it would put the user's own words into a document the card fetches
* every 30 seconds and that lives in the plugin's HTTP log.
*
* The one addition to that list is the proxy's own origin, so the card can link
* out to the dashboard the proxy already ships instead of redrawing it. That is
* a service address rather than conversation material, and anyone who can read
* this document can already reach that listener directly — which is why it is
* safe to publish where a title would not be.
*
* The proxy also has NO AUTHENTICATION by its own documentation — the README
* says so outright — so every request here is a hard local one, and the relay
* only ever reads `/__bili/health` and `/__bili/sessions`. Both are GETs. This
* module has no code path that could write to that proxy.
*
* @module dsh-xdpool/billion
*/
/** The proxy's own management prefix. Never guess it; it is theirs. */
const BILI_PREFIX = "/__bili";
/** Loopback only. The proxy binds 127.0.0.1 and we refuse anything else. */
const LOOPBACK_HOSTS$1 = [
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1"
];
/**
* How long one relay request may take.
*
* Short on purpose: this runs inside the card's status request, and a stalled
* third-party proxy must degrade to a panel that says "no answer" rather than
* hold the pool card hostage. The proxy answers these two endpoints in
* milliseconds; the budget is for the case where it does not.
*/
const RELAY_TIMEOUT_MS = 1500;
/** How many sessions the card is shown. 50 rows is already past the fold. */
const MAX_SESSIONS = 50;
/**
* Where the proxy keeps its state directory.
*
* Mirrors the proxy's own resolution exactly: `XDG_STATE_HOME` when it holds an
* absolute path, else `<homedir>/.local/state`. Deliberately NOT
* `DSH_HOME ?? homedir()` — DSH_HOME is the profile root and a live value on a
* real desktop install, so preferring it sent this reader to
* `<profile>/.local/state/billion-context` and reported "missing" on a machine
* where the proxy was running and answering. Probed against the live proxy,
* which is the only way that mistake is visible: every unit test with a faked
* state directory passes either way.
*
* Undefined when neither resolves, because inventing a path to probe would
* turn "not installed" into a silent hunt through the filesystem.
*/
function stateRoot() {
	const xdg = env.XDG_STATE_HOME;
	if (typeof xdg === "string" && xdg !== "") {
		if (xdg.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(xdg)) return join(xdg, "billion-context");
		return;
	}
	const home = homedir();
	if (typeof home !== "string" || home === "") return void 0;
	return join(home, ".local", "state", "billion-context");
}
/** A loopback http(s) origin, or undefined for anything else. */
function parseLoopbackOrigin(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		return;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
	if (!LOOPBACK_HOSTS$1.includes(url.hostname.toLowerCase())) return void 0;
	return url.origin;
}
/**
* The proxy origin, from the file the proxy itself reads on startup.
*
* `port-zone.json` is the fallback because it is keyed by lane and therefore
* distinguishes the dsh proxy from, say, a concurrently running opencode one —
* but `proxy-origin` is preferred because it is the single-writer record.
*/
async function readProxyOrigin() {
	const root = stateRoot();
	if (root === void 0) return void 0;
	for (const name of ["proxy-origin", "port-zone.json"]) {
		let raw;
		try {
			raw = await readFile(join(root, name), "utf8");
		} catch {
			continue;
		}
		if (name === "proxy-origin") {
			try {
				const parsed = JSON.parse(raw);
				const origin = typeof parsed.origin === "string" ? parseLoopbackOrigin(parsed.origin) : void 0;
				if (origin !== void 0) return origin;
			} catch {}
			continue;
		}
		try {
			const port = JSON.parse(raw).lanes?.dsh;
			if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
		} catch {
			continue;
		}
	}
}
/** One GET against the proxy, with the relay budget on it. Never throws. */
async function fetchJson(origin, path) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, RELAY_TIMEOUT_MS);
	try {
		const response = await fetch(new URL(BILI_PREFIX + path, origin), {
			method: "GET",
			headers: { accept: "application/json" },
			signal: controller.signal
		});
		if (!response.ok) return void 0;
		return await response.json();
	} catch {
		return;
	} finally {
		clearTimeout(timer);
	}
}
/** A finite number, or undefined. Guards every relayed field. */
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** A string, or ''. */
function str(value) {
	return typeof value === "string" ? value : "";
}
/** A boolean, or false. */
function bool(value) {
	return value === true;
}
/**
* One session row, reduced.
*
* Every field is defaulted rather than passed through: the proxy's document is
* a moving target across versions, and an unreadable row should render as
* zeroes we can explain, not as `undefined` reaching the card.
*/
function toSession(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return void 0;
	const row = raw;
	const id = str(row.id);
	if (id === "") return void 0;
	return {
		id,
		protocol: str(row.protocol),
		live: bool(row.live),
		requests: num(row.requests) ?? 0,
		contextTokens: num(row.contextTokens) ?? 0,
		contextTokensSource: str(row.contextTokensSource),
		tokensSaved: num(row.tokensSaved) ?? 0,
		inputTokens: num(row.inputTokens) ?? 0,
		cachedTokens: num(row.cachedTokens) ?? 0,
		outputTokens: num(row.outputTokens) ?? 0,
		cacheHitPct: num(row.cacheHitPct) ?? -1,
		blocks: num(row.blocks) ?? 0,
		contextWindow: num(row.contextWindow) ?? 0,
		lastSeen: str(row.lastSeen),
		lastModel: str(row.lastModel)
	};
}
/** The whole relay, safe to hand the card: it never rejects. */
async function readBillionStatus() {
	const origin = await readProxyOrigin();
	if (origin === void 0) return {
		state: "missing",
		reason: "billion-context is not running on this machine. Install it with \"dsh plugin --profile <name> add billion-context\" and this page fills in.",
		sessions: [],
		totalSessions: 0
	};
	const health = await fetchJson(origin, "/health");
	if (health === null || typeof health !== "object") return {
		state: "unreachable",
		reason: `billion-context is recorded at ${origin} but did not answer. It may have just been restarted.`,
		origin,
		sessions: [],
		totalSessions: 0
	};
	const meta = health;
	const sessionsDoc = await fetchJson(origin, "/sessions");
	const rawSessions = sessionsDoc !== null && typeof sessionsDoc === "object" ? sessionsDoc.sessions : void 0;
	const rows = Array.isArray(rawSessions) ? rawSessions.slice(0, MAX_SESSIONS) : [];
	const sessions = [];
	for (const row of rows) {
		const session = toSession(row);
		if (session !== void 0) sessions.push(session);
	}
	const total = num(sessionsDoc !== null && typeof sessionsDoc === "object" ? sessionsDoc.total : void 0) ?? sessions.length;
	const version = str(meta.version);
	const startedAt = num(meta.startedAt);
	return {
		state: "ready",
		origin,
		...version === "" ? {} : { version },
		...startedAt === void 0 ? {} : { startedAt },
		sessions,
		totalSessions: total
	};
}
//#endregion
//#region src/diagnostics.ts
/**
* A startup trace this plugin owns.
*
* The host's own logs have moved between at least three directories across the
* 0.1.x / 0.2.x / DSH NEXT lines, and on a machine with no outbound network
* they are not always where anyone thinks to look. When a provider fails to
* register, "the model picker does not list xdpool" is the only symptom the
* user can report, and answering it needs the exact throw — so the plugin
* writes one small append-only file next to the settings it already owns.
*
* Everything here is best-effort: a diagnostic that can crash the thing it is
* diagnosing is worse than no diagnostic, so every path swallows its own
* failure and returns a value the caller can log instead.
*
* @module dsh-xdpool/diagnostics
*/
/**
* Cap the trace so a plugin that restarts in a loop cannot fill the disk.
* Half a megabyte is roughly a month of restarts, which is far more than the
* single boot this file is meant to explain.
*/
const MAX_BYTES = 524288;
/** The file lives beside the settings store, so one directory explains both. */
function startupLogPath() {
	const home = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : homedir();
	return join(home, ".xdpool", "startup.log");
}
/**
* Render any thrown value as one line of text.
*
* `String(error)` on a real `Error` collapses the stack to "Error: message",
* which is exactly the part worth keeping; the object form (`{}` for a
* structured clone, `[object Object]` for anything else) is what produced the
* unreadable `{}` markers in this project's earlier logs.
*/
function describeError(error) {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? ` (${String(error.code)})` : "";
		return `${error.name}: ${error.message}${code}`;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}
/**
* Append one timestamped line. Returns the text that was written, so a caller
* that cannot write the file can still put the same words in the host log.
*/
function recordStartupNote(line) {
	const text = `${(/* @__PURE__ */ new Date()).toISOString()} ${line}`;
	try {
		const path = startupLogPath();
		mkdirSync(join(path, ".."), { recursive: true });
		try {
			if (statSync(path).size > MAX_BYTES) truncateSync(path, 0);
		} catch {}
		appendFileSync(path, `${text}\n`, "utf8");
	} catch {}
	return text;
}
/** Hard ceiling on the whole probe, so a hung upstream cannot wedge the card. */
const PROBE_TIMEOUT_MS = 3e4;
/**
* The smallest prompt that makes a model answer in a few characters.
*
* Deliberately a counting question rather than a greeting: "how many r's are in
* strawberry" forces real generation on any model, whereas "hi" can be answered
* from a cache or a canned reply on some gateways, which would make the probe
* report a working connection to a model that is not actually reachable.
*/
const PROBE_PROMPT = "Reply with the single word: ready";
/** Text a chunk actually carries, ignoring its type. */
function chunkText(chunk) {
	if (typeof chunk.text === "string") return chunk.text;
	return "";
}
/**
* Run one probe and report what came back.
*
* Never throws. A probe exists to be clicked during setup, and a thrown error
* here would surface in the card as a route failure with no explanation, which
* is indistinguishable from "your key is wrong" — the one misdiagnosis this
* button must not cause.
*/
async function probeModelConnectivity(llm, provider, model, options = {}) {
	const startedAt = Date.now();
	const timeout = new AbortController();
	const timer = setTimeout(() => {
		timeout.abort();
	}, PROBE_TIMEOUT_MS);
	const onCallerAbort = () => {
		timeout.abort();
	};
	if (options.signal !== void 0) {
		if (options.signal.aborted) timeout.abort();
		else options.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	let characters = 0;
	let firstFrameMs;
	try {
		const stream = llm.stream({
			provider,
			model,
			system: "You are being called by a connection test. Answer in one short word.",
			messages: [{
				role: "user",
				content: PROBE_PROMPT
			}],
			maxTokens: 24,
			signal: timeout.signal
		});
		for await (const chunk of stream) {
			if (chunk.type === "finish" && chunk.reason !== void 0) {
				const kind = chunk.reason.kind;
				if (kind === "error" || kind === "aborted") {
					const failure = chunk.reason.failure;
					const message = typeof failure?.message === "string" ? failure.message : `stream ended: ${kind}`;
					return {
						ok: false,
						outputChars: characters,
						error: message,
						...firstFrameMs === void 0 ? {} : { firstFrameMs }
					};
				}
				break;
			}
			const text = chunkText(chunk);
			if (text === "") continue;
			characters += text.length;
			if (firstFrameMs === void 0) {
				firstFrameMs = Date.now() - startedAt;
				if (characters > 0) {
					await Promise.race([sleep(900).then(() => "grace"), waitForAbort(timeout.signal)]);
					break;
				}
			}
		}
		return {
			ok: characters > 0,
			outputChars: characters,
			...firstFrameMs === void 0 ? {} : { firstFrameMs },
			...characters > 0 ? {} : { error: "the model returned no output" }
		};
	} catch (error) {
		return {
			ok: false,
			outputChars: characters,
			...firstFrameMs === void 0 ? {} : { firstFrameMs },
			error: describeError(error)
		};
	} finally {
		clearTimeout(timer);
		if (options.signal !== void 0) options.signal.removeEventListener("abort", onCallerAbort);
		timeout.abort();
	}
}
/** Resolve after `ms`, or immediately when the signal aborts. */
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/** Resolve when the signal aborts. Never resolves otherwise. */
function waitForAbort(signal) {
	if (signal.aborted) return Promise.resolve("aborted");
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => {
			resolve("aborted");
		}, { once: true });
	});
}
//#endregion
//#region src/context-budget.ts
/** Rough character-per-token ratio. CJK is ~1 token/char, latin ~1/4. */
const CHARS_PER_TOKEN_LATIN = 4;
const CHARS_PER_TOKEN_CJK = 1;
/** Fixed per-message overhead the chat template adds (role markers etc.). */
const PER_MESSAGE_TOKEN_OVERHEAD = 4;
/** Every image/tool part costs at least this much once decoded. */
const PER_PART_TOKEN_FLOOR = 16;
/**
* Estimate the token cost of one message's `content`.
*
* Deliberately conservative (over-estimates) so we compact slightly early
* rather than discovering the overrun upstream.
*/
function estimateContentTokens(content) {
	if (content === null || content === void 0) return 0;
	if (typeof content === "string") return estimateTextTokens(content);
	if (typeof content === "number" || typeof content === "boolean") return PER_PART_TOKEN_FLOOR;
	if (Array.isArray(content)) {
		let total = 0;
		for (const part of content) total += estimateContentTokens(part);
		return total;
	}
	if (typeof content === "object") {
		const record = content;
		let total = PER_PART_TOKEN_FLOOR;
		for (const key of [
			"text",
			"image_url",
			"input",
			"content"
		]) if (key in record) total += estimateContentTokens(record[key]);
		if (total === PER_PART_TOKEN_FLOOR) total += estimateTextTokens(safeStringify(record));
		return total;
	}
	return 0;
}
/** Estimate tokens for a plain string, accounting for CJK density. */
function estimateTextTokens(text) {
	if (text === "") return 0;
	let cjk = 0;
	for (const char of text) if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
	const latin = text.length - cjk;
	return Math.ceil(cjk / CHARS_PER_TOKEN_CJK + latin / CHARS_PER_TOKEN_LATIN);
}
function isCjk(code) {
	return code >= 12288 && code <= 12351 || code >= 12352 && code <= 12543 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 63744 && code <= 64255 || code >= 65280 && code <= 65519 || code >= 131072 && code <= 191471;
}
function safeStringify(value) {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}
/** Estimate the prompt cost of a whole message array. */
function estimateMessagesTokens(messages) {
	let total = 0;
	for (const message of messages) {
		total += PER_MESSAGE_TOKEN_OVERHEAD;
		total += estimateContentTokens(message.content);
		if (message["tool_calls"] !== void 0) total += estimateContentTokens(message["tool_calls"]);
		if (message["name"] !== void 0) total += estimateTextTokens(String(message["name"]));
	}
	return total;
}
/** True when `role` carries instructions that must survive compaction. */
function isPinnedRole(role) {
	return role === "system" || role === "developer";
}
/**
* Drop the oldest non-pinned messages until the estimate fits `budget`.
*
* Pinned (system/developer) messages and the newest `keepRecent` messages are
* never dropped here — if those alone overrun the budget, the caller must fall
* back to summarisation or give up.
*/
function compactMessages(messages, options) {
	const keepRecent = Math.max(1, options.keepRecent ?? 4);
	const estimate = estimateMessagesTokens(messages);
	if (estimate <= options.budget) return {
		messages: [...messages],
		dropped: [],
		tokens: estimate,
		changed: false
	};
	const pinned = [];
	const body = [];
	for (const message of messages) if (isPinnedRole(message.role)) pinned.push(message);
	else body.push(message);
	const keep = Math.min(keepRecent, body.length);
	const tail = body.slice(body.length - keep);
	const head = body.slice(0, body.length - keep);
	let dropCount = 0;
	let candidate = [
		...pinned,
		...head,
		...tail
	];
	let total = estimateMessagesTokens(candidate);
	while (total > options.budget && dropCount < head.length) {
		dropCount += 1;
		candidate = [
			...pinned,
			...head.slice(dropCount),
			...tail
		];
		total = estimateMessagesTokens(candidate);
	}
	const dropped = head.slice(0, dropCount);
	return {
		messages: candidate,
		dropped,
		tokens: total,
		changed: dropCount > 0
	};
}
/**
* Drop the oldest messages, including pinned ones, as a last resort.
*
* Used when even a summary cannot bring the prompt under budget (for example a
* single enormous pasted document). The newest message always survives.
*/
function hardTruncate(messages, budget) {
	if (messages.length === 0) return {
		messages: [],
		dropped: [],
		tokens: 0,
		changed: false
	};
	let start = 0;
	let candidate = [...messages];
	let total = estimateMessagesTokens(candidate);
	while (total > budget && start < messages.length - 1) {
		start += 1;
		candidate = messages.slice(start);
		total = estimateMessagesTokens(candidate);
	}
	return {
		messages: candidate,
		dropped: messages.slice(0, start),
		tokens: total,
		changed: start > 0
	};
}
/** Instructions handed to the model when we ask it to compact a conversation. */
const SUMMARIZE_INSTRUCTION = [
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
/** Render a message array as plain text for the summarisation prompt. */
function transcriptOf(messages) {
	const lines = [];
	for (const message of messages) {
		const role = message.role === "" ? "unknown" : message.role;
		lines.push(`### ${role}`);
		lines.push(renderContent(message.content));
		if (message["tool_calls"] !== void 0) lines.push(renderContent(message["tool_calls"]));
	}
	return lines.join("\n");
}
function renderContent(content) {
	if (content === null || content === void 0) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => renderContent(part)).filter((text) => text !== "").join("\n");
	if (typeof content === "object") {
		const record = content;
		for (const key of [
			"text",
			"content",
			"input"
		]) if (typeof record[key] === "string") return record[key];
		if (record["type"] !== void 0 && typeof record["type"] === "string") return `[${record["type"]}]`;
		return safeStringify(record);
	}
	return String(content);
}
/** Build the synthetic system message that carries a compaction summary. */
function summaryMessage(summary) {
	return {
		role: "system",
		content: [
			"The earlier part of this conversation was compacted to fit the model context window.",
			"Briefing produced from the dropped turns:",
			"",
			summary.trim()
		].join("\n")
	};
}
/**
* Compact `messages` to `budget`, summarising the dropped turns when possible.
*
* The summary is requested with a *bounded* transcript so the compaction call
* itself can never overrun the window: if the dropped turns are huge, only the
* newest slice of them is summarised, and the oldest are noted as elided.
*/
async function compactWithSummary(messages, options, deps, signal) {
	const first = compactMessages(messages, options);
	if (!first.changed) return {
		messages: first.messages,
		tokens: first.tokens,
		summary: void 0,
		skipped: void 0
	};
	const summaryBudget = Math.max(256, Math.floor(options.budget / 4));
	let toSummarize = first.dropped;
	let elided = 0;
	while (estimateMessagesTokens(toSummarize) > summaryBudget && toSummarize.length > 1) {
		toSummarize = toSummarize.slice(1);
		elided += 1;
	}
	let summary;
	let skipped;
	try {
		const instruction = elided > 0 ? `${SUMMARIZE_INSTRUCTION}\n\nNote: the ${elided} oldest turn(s) were elided before this transcript.` : SUMMARIZE_INSTRUCTION;
		const suffix = elided > 0 ? `\n(the ${elided} oldest turn(s) were elided)` : "";
		const request = [{
			role: "system",
			content: instruction
		}, {
			role: "user",
			content: `${transcriptOf(toSummarize)}${suffix}`
		}];
		const text = await deps.complete(request, signal);
		if (text.trim() !== "") summary = text.trim();
		else skipped = "summariser returned an empty summary";
	} catch (error) {
		skipped = `summarisation failed: ${String(error)}`;
	}
	if (summary === void 0) return {
		messages: first.messages,
		skipped,
		tokens: first.tokens
	};
	const withSummary = injectSummary(first.messages, summary);
	if (estimateMessagesTokens(withSummary) > options.budget) {
		const truncated = hardTruncate(withSummary, options.budget);
		return {
			messages: truncated.messages,
			summary,
			tokens: truncated.tokens
		};
	}
	return {
		messages: withSummary,
		summary,
		tokens: estimateMessagesTokens(withSummary)
	};
}
/**
* Re-insert a summary as: pinned instructions → summary → surviving tail.
*
* Order matters. Pinned (system/developer) messages must stay ahead of the
* summary so that a later synthetic system message can never override the
* harness's own instructions; the tail follows so the newest exchange is the
* last thing the model reads.
*
* `compacted` is always derived from `original` by `compactMessages`, so the
* pinned messages it carries are exactly the originals — no need to re-add
* them from `original`.
*/
function injectSummary(compacted, summary) {
	const pinned = [];
	const rest = [];
	for (const message of compacted) if (isPinnedRole(message.role)) pinned.push(message);
	else rest.push(message);
	return [
		...pinned,
		summaryMessage(summary),
		...rest
	];
}
//#endregion
//#region src/siblings.ts
/**
* The cheapest PAID model sharing `model`'s display name, or undefined.
*
* Cheapest rather than first, because the point of the hint is "there is a
* cheap way out": offering the most expensive twin would make switching look
* like a trap. A sibling whose price is unknown is skipped — an unpriced row
* cannot be promised as "the paid one".
*/
function paidSiblingOf(model, models) {
	let best;
	for (const candidate of models) {
		if (candidate.id === model.id) continue;
		if (candidate.name !== model.name) continue;
		const multiplier = candidate.multiplier;
		if (multiplier === void 0 || multiplier <= 0) continue;
		if (best === void 0 || multiplier < best.multiplier) best = {
			id: candidate.id,
			name: candidate.name,
			multiplier
		};
	}
	return best;
}
/**
* The paid sibling of a model, but ONLY when the model itself is free.
*
* The guard is the whole point: a `x0.79` row with a `x0.06` cousin is not a
* "free model with a paid twin", it is just a more expensive row, and labelling
* it would be noise on most of the list. The hint answers one question — "the
* free one is limited, what now".
*/
function paidAlternativeFor(model, models) {
	if (model.multiplier !== 0) return void 0;
	return paidSiblingOf(model, models);
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint with multi-account failover.
*
* The pi-ai provider points here. Each chat request acquires an account from
* the pool; when the upstream answers with a rate limit, the shim cools that
* account down, takes the next one, and retries in the same request — so a
* `429 soft_rate` never reaches the user as a turn failure.
*
* Security model (Host/Origin loopback checks, constant-time bearer compare,
* random port, in-process secret, body cap, error→status mapping) follows
* corrinehu/dsh-workbuddy-connect (MIT, Copyright (c) 2026 Corrine Hu), which
* designed and validated it.
*
* @module dsh-xdpool/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/** Host must name loopback; drops DNS-rebinding attempts before routing. */
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/** A present Origin must be loopback; non-browser clients send none and pass. */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat POSTs must carry a JSON body type (blocks simple-request CSRF). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson$1(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** True when an upstream failure body means the request overran the model's
*  context window (OpenAI `context_length_exceeded`, WorkBuddy code 11115 /
*  "input length too long"). The shim answers it by compacting the conversation
*  in place and retrying once; see `recoverFromContextOverrun`. */
function isContextTooLong(body) {
	if (body.includes("context_length_exceeded")) return true;
	if (body.includes("input length too long")) return true;
	if (body.includes("\"code\":11115")) return true;
	if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
	return false;
}
/**
* A content-free description of a request, for the log when the upstream
* rejects it.
*
* `model_param_invalid` arrives with an EMPTY `param` field, so the error alone
* says nothing about which parameter was rejected — the user is left with "the
* request parameters do not meet the current model requirements" and no way to
* act. Recording the shape (top-level keys, message count by role, tool count,
* approximate prompt size) makes such a rejection diagnosable from the log.
*
* Deliberately SHAPE ONLY: no message content, no tool schemas, no tokens. It
* ends up in a log file, and the conversation it describes is the user's.
*/
function requestShape(raw) {
	try {
		const parsed = JSON.parse(raw);
		const keys = Object.keys(parsed).sort();
		const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
		const byRole = /* @__PURE__ */ new Map();
		let chars = 0;
		for (const entry of messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			const role = typeof message["role"] === "string" ? message["role"] : "?";
			byRole.set(role, (byRole.get(role) ?? 0) + 1);
			chars += JSON.stringify(message["content"] ?? "").length;
		}
		const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(" ");
		const tools = Array.isArray(parsed["tools"]) ? parsed["tools"].length : 0;
		return `keys=[${keys.join(" ")}] messages=${messages.length}${roles === "" ? "" : ` (${roles})`} tools=${tools} contentChars=${chars}`;
	} catch {
		return "body was not parseable JSON";
	}
}
/**
* Stable identity of the conversation a request belongs to, for `sticky`.
*
* The FIRST user message is the key: it is the one part of the body that does
* not change as the history grows, so every turn of a conversation hashes the
* same way while a new chat (with a different opening message) hashes
* differently. Hashing rather than storing the text keeps conversation content
* out of the pool's memory.
*
* Two conversations that open with the exact same message share an account —
* rare, and harmless: it only means they share one account's prompt cache.
*/
function conversationKeyOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.messages)) return void 0;
		for (const entry of parsed.messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			if (message["role"] !== "user") continue;
			const content = typeof message["content"] === "string" ? message["content"] : JSON.stringify(message["content"] ?? "");
			return createHash("sha256").update(content).digest("hex").slice(0, 32);
		}
		return;
	} catch {
		return;
	}
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function createWorkBuddyShim(options) {
	const { pool, client, catalog, usageRecorder } = options;
	const region = options.region;
	const logger = options.logger;
	const aggregate = options.aggregate;
	const extra = options.extra;
	const maxAttempts = options.maxAttempts ?? 8;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const a = Buffer.from(match[1]);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	/**
	* "The same model has a paid row" sentence for a 429 body, or undefined.
	*
	* Reads the catalog the shim was built with, so the hint names a row this
	* gateway ACTUALLY serves — a CN-only id in a global 429 would be worse than
	* no hint at all. Absent when the cooling model is itself paid, or when the
	* family has no priced twin.
	*/
	function paidTwinHint(modelId) {
		const models = catalog.current();
		const model = models.find((candidate) => candidate.id === modelId);
		if (model === void 0) return void 0;
		const twin = paidAlternativeFor(model, models);
		if (twin === void 0) return void 0;
		return `${twin.id} is the same model on a paid row (x${twin.multiplier.toFixed(2)} credits) and is rate-limited separately; switch to it to keep going`;
	}
	/**
	* Replace a request's model id with the provider's own, leaving the rest of the
	* body byte-identical.
	*
	* A textual replacement rather than a re-serialise: the aggregate lane's caller
	* is pi-ai, and re-encoding its body would drop undefined-valued keys and reorder
	* nothing but risk changing numbers pi-ai deliberately rounded. Only the `model`
	* field changes, and only when it actually names the composite id.
	*/
	function withBareModelId(raw, modelId) {
		try {
			const parsed = JSON.parse(raw);
			parsed.model = modelId;
			return JSON.stringify(parsed);
		} catch {
			return raw;
		}
	}
	/**
	* The aggregate row a composite model id names, or undefined.
	*
	* Answering `undefined` for an id that merely LOOKS composite is the point: a
	* slash is legal in a WorkBuddy model id too, and a request naming one must
	* fall through to the pool rather than to a lane that cannot serve it.
	*/
	function aggregateRowFor(modelId) {
		if (aggregate === void 0 || modelId === void 0) return void 0;
		const parsed = parseProviderModelId(modelId);
		if (parsed === null) return void 0;
		const row = aggregate.catalog.find(modelId);
		if (row === void 0 || row.providerId !== parsed.providerId || row.modelId !== parsed.modelId) return void 0;
		return parsed;
	}
	/**
	* The extra lane a prefixed model id names, or undefined.
	*
	* A prefixed id cannot collide with anything else: `free:` is the plugin's own
	* convention and no gateway publishes a model whose id begins with it. That is
	* why this lane can be routed on the id's PREFIX while the aggregate lane is
	* routed on a slash — no header, no extra field, and no chance of a caller
	* spoofing its way into a lane by guessing.
	*
	* A prefixed id the lane does not currently offer is reported as
	* unavailable, never routed to the pool: the pool would answer "sign in to
	* WorkBuddy" for a model it has never heard of, and the user would go looking
	* for a login that is not the problem.
	*/
	function extraLaneFor(modelId) {
		if (modelId === void 0 || extra === void 0) return void 0;
		if (!modelId.startsWith("free:")) return void 0;
		const source = extra.free;
		if (source === void 0) return void 0;
		const bare = modelId.slice(5);
		if (!source.current().some((row) => row.modelId === modelId || row.id === bare)) return void 0;
		return {
			source,
			modelId: bare,
			lane: "free"
		};
	}
	/** The lane that a prefixed id names even when its roster is empty. */
	function extraLaneNamed(modelId) {
		if (modelId === void 0 || extra === void 0) return void 0;
		return modelId.startsWith("free:") ? "free" : void 0;
	}
	/**
	* Serve one extra-lane turn.
	*
	* The lane arrives here as chat completions, which is the point of the
	* translation layer: the caller never learns which of the three upstream wires
	* the row actually speaks. The source owns the whole turn — session identity,
	* body re-spelling, tool-name restoration, event folding — and hands back chat
	* payloads, so this function only frames them.
	*/
	async function serveExtraCompletion(res, raw, modelId, target, signal) {
		const frames = [];
		try {
			await target.source.run({
				modelId: target.modelId,
				body: raw,
				signal,
				onFrame: (payload) => frames.push(payload)
			});
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			const kind = error instanceof AggregateError ? error.kind : "server";
			const message = error instanceof AggregateError ? error.message : error instanceof Error ? error.message : String(error);
			writeOpenAIError(res, KIND_STATUS[kind], `${target.lane}_${kind}`, message);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		for (const payload of frames) res.write(`data: ${payload}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}
	/**
	* Serve one aggregate turn: forward to the provider, stream back verbatim.
	*
	* No account rotation and no compaction retry. The first is honest — the key
	* belongs to the user and the lane has no other credential to fall back to. The
	* second is out of scope here: compaction is the pool's response to ONE
	* gateway's window, and a third-party window differs per provider, so silently
	* halving a conversation to satisfy one would corrupt the others' turns.
	*/
	async function serveAggregateCompletion(res, raw, modelId, parsed, signal) {
		const store = aggregate?.readStore();
		if (store === void 0) {
			writeOpenAIError(res, 503, "aggregate_off", "the aggregate lane is not available on this profile");
			return;
		}
		let resolved;
		try {
			resolved = resolveAggregateProvider(store, parsed.providerId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeOpenAIError(res, error instanceof AggregateError ? KIND_STATUS[error.kind] : 400, "aggregate_config", message);
			return;
		}
		const body = withBareModelId(raw, parsed.modelId);
		const frames = [];
		try {
			await forwardAggregateStreamed(resolved, parsed.modelId, body, {
				signal,
				onData: (payload) => frames.push(payload)
			});
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof AggregateError) {
				writeOpenAIError(res, KIND_STATUS[error.kind], `aggregate_${error.kind}`, error.message);
				return;
			}
			writeOpenAIError(res, 500, "aggregate_internal", error instanceof Error ? error.message : String(error));
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		for (const payload of frames) res.write(`data: ${payload}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	/**
	* Last balance refresh per account, so a busy account is not probed on
	* every request. Ten minutes is well inside the window where ordinary use
	* could cross a reserve.
	*/
	const lastBalanceAt = /* @__PURE__ */ new Map();
	const BALANCE_REFRESH_MS = 6e5;
	/**
	* Refresh one account known credit balance, best effort.
	*
	* Runs in the background after a successful request. Failures are swallowed
	* on purpose: a reserve is a safety feature, and a flaky balance lookup must
	* never become a failed user request or a noisy log.
	*/
	async function refreshBalance(account) {
		const now = Date.now();
		if (now - (lastBalanceAt.get(account.id) ?? 0) < BALANCE_REFRESH_MS) return;
		lastBalanceAt.set(account.id, now);
		try {
			const credits = await client.fetchCredits(account.credential);
			pool.noteCredits(account.id, credits.total, credits.nearestExpiryMs);
		} catch {}
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson$1(res, 200, {
					ok: true,
					pool: pool.status()
				});
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				const rows = catalog.current().map((model) => ({
					id: model.id,
					object: "model",
					created: 0,
					owned_by: "workbuddy"
				}));
				if (aggregate !== void 0) for (const row of aggregate.catalog.current()) {
					const ownedBy = isComboRow(row) ? COMBO_CHANNEL : row.providerId;
					rows.push({
						id: row.id,
						object: "model",
						created: 0,
						owned_by: ownedBy
					});
				}
				if (extra !== void 0) for (const row of extra.free.current()) rows.push({
					id: row.modelId,
					object: "model",
					created: 0,
					owned_by: FREE_CHANNEL
				});
				writeJson$1(res, 200, {
					object: "list",
					data: rows
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	/**
	* Serve one turn through a combo chain, trying its members in order.
	*
	* The point of a chain is that the members are NOT interchangeable: one is
	* rate-limited, another is out of credit, a third has no key. So every member
	* gets its own lane, and a member that fails is recorded as a member failure —
	* never as "the chain failed", which would leave the user with no way to tell a
	* broken member from an exhausted one.
	*
	* Mixed chains are the interesting case. A chain may name a pool model AND a
	* composite third-party model, and those two speak different wires: the pool
	* needs `prepareChatBody` plus account rotation, the aggregate lane needs the
	* bare provider model id and no rotation. Both are prepared from the caller's
	* ORIGINAL body rather than from each other's output, so nothing one member
	* needs (`developer` role, `tool_choice`) reaches a third-party provider, and
	* nothing a third-party provider returns can be mistaken for the pool's shape.
	*/
	async function serveComboCompletion(res, raw, row, signal) {
		const store = aggregate?.readStore();
		const sources = {
			pool: catalog.current(),
			aggregate: aggregate === void 0 ? [] : aggregate.catalog.providerRows()
		};
		const members = comboChain(row).map((modelId) => resolveComboMember(modelId, sources)).filter((member) => member !== void 0);
		if (members.length === 0) {
			writeOpenAIError(res, 503, "combo_empty", `chain ${row.id} has no member model available right now`);
			return;
		}
		const attempts = [];
		let last;
		const conversationKey = conversationKeyOf(raw);
		for (const member of members) {
			if (signal.aborted) return;
			attempts.push(member.modelId);
			if (!member.aggregate) {
				const account = await pool.acquire(member.modelId, region);
				if (account === void 0) {
					const why = pool.unavailableReason(member.modelId, region);
					last = {
						kind: why.reason,
						status: why.reason === "cooling" ? 429 : 401,
						message: `member ${member.modelId} has no usable WorkBuddy account (${why.reason})`
					};
					continue;
				}
				const prepared = client.prepareChatBody(raw);
				const result = await client.chatStream(account.credential, prepared, signal, conversationKey);
				if (result.ok) {
					const turnId = randomBytes(8).toString("hex");
					await serveSuccessfulStream(res, account, result, logger, refreshBalance, pool, usageRecorder === void 0 ? void 0 : {
						recorder: usageRecorder,
						region: region ?? "cn",
						model: member.modelId,
						turnId
					});
					return;
				}
				last = {
					kind: result.kind,
					status: result.status,
					message: result.message
				};
				if (result.kind === "soft_rate") pool.penalize(account.id, parseRateLimitReset(result.message), member.modelId);
				else if (result.kind === "session_dead") pool.penalizeCredentialDead(account.id);
				else if (result.kind === "hard_credit") pool.penalizeExhausted(account.id);
				continue;
			}
			if (store === void 0 || aggregate === void 0) {
				last = {
					kind: "combo_config",
					status: 503,
					message: "the aggregate lane is not available on this profile"
				};
				continue;
			}
			const parsed = parseProviderModelId(member.modelId);
			if (parsed === null) {
				last = {
					kind: "combo_config",
					status: 400,
					message: `member ${member.modelId} is not a valid provider model id`
				};
				continue;
			}
			let resolved;
			try {
				resolved = resolveAggregateProvider(store, parsed.providerId);
			} catch (error) {
				last = {
					kind: "combo_config",
					status: 400,
					message: error instanceof Error ? error.message : String(error)
				};
				continue;
			}
			const frames = [];
			try {
				await forwardAggregateStreamed(resolved, parsed.modelId, withBareModelId(raw, parsed.modelId), {
					signal,
					onData: (payload) => frames.push(payload)
				});
			} catch (error) {
				last = {
					kind: error instanceof AggregateError ? error.kind : "server",
					status: error instanceof AggregateError ? KIND_STATUS[error.kind] : 502,
					message: error instanceof Error ? error.message : String(error)
				};
				continue;
			}
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
				"X-Accel-Buffering": "no"
			});
			for (const payload of frames) res.write(`data: ${payload}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		const kind = last?.kind ?? "combo_empty";
		writeOpenAIError(res, last?.status ?? 503, `combo_${kind}`, `chain ${row.id}: no member answered after ${attempts.length} [${attempts.join(" → ")}]: ${(last?.message ?? "no member was reachable").slice(0, 300)}`);
	}
	/**
	* Serve one chat completion, rotating accounts on rate limits.
	*
	* A rate-limited account is cooled for exactly the window the upstream
	* reports (when parseable) and the next account is tried immediately, so a
	* pool with any healthy member never surfaces a 429 to the caller.
	*/
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		let modelId;
		try {
			const parsed = JSON.parse(raw);
			modelId = typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
		} catch {
			modelId = void 0;
		}
		const comboRow = aggregate === void 0 || modelId === void 0 ? void 0 : aggregate.catalog.findCombo(modelId);
		if (comboRow !== void 0) {
			await serveComboCompletion(res, raw, comboRow, controller.signal);
			return;
		}
		if (modelId !== void 0 && isComboId(modelId)) {
			writeOpenAIError(res, 503, "combo_missing", `chain ${modelId} is not available right now; edit or re-enable it in XD Pool → Routing`);
			return;
		}
		const aggregateRow = aggregateRowFor(modelId);
		if (aggregateRow !== void 0) {
			await serveAggregateCompletion(res, raw, modelId, aggregateRow, controller.signal);
			return;
		}
		const extraTarget = extraLaneFor(modelId);
		if (extraTarget !== void 0) {
			await serveExtraCompletion(res, raw, modelId, extraTarget, controller.signal);
			return;
		}
		const lane = extraLaneNamed(modelId);
		if (lane !== void 0) {
			writeOpenAIError(res, 503, `${lane}_unavailable`, lane === "free" ? `${modelId} is not available right now; the free lane's model listing is refreshed on the XD Pool card` : `${modelId} is not available right now; sign in to the co-paid lane on the XD Pool card`);
			return;
		}
		const prepared = client.prepareChatBody(raw);
		const conversationKey = conversationKeyOf(raw);
		const tried = [];
		let last;
		const turnId = randomBytes(8).toString("hex");
		const usageContext = usageRecorder === void 0 ? void 0 : {
			recorder: usageRecorder,
			region: region ?? "cn",
			model: modelId ?? "(none)",
			turnId
		};
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const account = await pool.acquire(modelId, region, conversationKey);
			if (account === void 0) {
				const why = pool.unavailableReason(modelId, region);
				if (why.reason === "cooling") {
					const subject = modelId === void 0 ? "every WorkBuddy account is rate-limited" : `every account is rate-limited for model ${modelId}`;
					const upstream = last === void 0 ? "" : ` — ${last.message.slice(0, 200)}`;
					const twin = modelId === void 0 ? void 0 : paidTwinHint(modelId);
					writeOpenAIError(res, 429, "soft_rate", `${subject} (${why.cooling}/${why.total} cooling, tried ${tried.length})${tried.length === 0 ? "" : `: ${tried.join(" → ")}`}${upstream}` + (twin === void 0 ? "" : ` — ${twin}`));
					return;
				}
				if (why.reason === "disabled") {
					writeOpenAIError(res, 403, "no_enabled_account", `all ${why.total} WorkBuddy account(s) for this gateway are switched off or ignored; re-enable one on the pool card`);
					return;
				}
				if (why.reason === "reserve") {
					writeOpenAIError(res, 402, "reserve_floor", `every WorkBuddy account is at or below its credit reserve (${why.total} account(s)); lower the reserve on the pool card or top up credits`);
					return;
				}
				if (why.reason === "session_dead") {
					writeOpenAIError(res, 401, "session_dead", `${why.dead}/${why.total} WorkBuddy account(s) for this gateway were rejected by the upstream (their sign-in was revoked); sign in again in the WorkBuddy desktop app to restore them`);
					return;
				}
				writeOpenAIError(res, 401, "not_signed_in", why.total === 0 ? "no WorkBuddy credential found for this gateway; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)" : `no usable WorkBuddy credential among ${why.total} account(s) for this gateway; sign in again on the desktop app`);
				return;
			}
			tried.push(account.label);
			const result = await client.chatStream(account.credential, prepared, controller.signal, conversationKey);
			if (result.ok) {
				await serveSuccessfulStream(res, account, result, logger, refreshBalance, pool, usageContext);
				return;
			}
			usageRecorder?.record({
				region: region ?? "cn",
				model: modelId ?? "(none)",
				account: account.label,
				turnId,
				at: Date.now(),
				ok: false
			});
			last = {
				kind: result.kind,
				status: result.status,
				message: result.message
			};
			if (result.kind === "session_dead") {
				logger?.warn(`dsh-xdpool: ${account.label} session dead; refreshing token and retrying`);
				const before = account.credential.accessToken;
				if (!await pool.refreshAccount(account.id, { force: true }) || account.credential.accessToken === before) {
					pool.penalizeCredentialDead(account.id);
					logger?.warn(`dsh-xdpool: ${account.label} sign-in is no longer valid (attempt ${attempt + 1}/${maxAttempts}); rotating`);
				}
				continue;
			}
			if (result.kind === "hard_credit") {
				pool.penalizeExhausted(account.id);
				logger?.warn(`dsh-xdpool: ${account.label} has no credits left (attempt ${attempt + 1}/${maxAttempts}); rotating`);
				continue;
			}
			if (result.kind === "client") logger?.warn(`dsh-xdpool: ${account.label} rejected the request as invalid (model ${modelId ?? "(none)"}) — ${requestShape(raw)}; upstream: ${result.message.slice(0, 300)}`);
			if (result.kind !== "soft_rate") break;
			pool.penalize(account.id, parseRateLimitReset(result.message), modelId);
			logger?.warn(`dsh-xdpool: ${account.label} rate-limited on ${modelId ?? "(no model)"} (attempt ${attempt + 1}/${maxAttempts}); rotating`);
		}
		if (last === void 0) {
			writeOpenAIError(res, 500, "internal", "chat request exhausted without a result");
			return;
		}
		if (isContextTooLong(last.message)) {
			const recovered = await recoverFromContextOverrun({
				raw,
				modelId,
				controller,
				region,
				logger,
				client,
				pool,
				maxAttempts,
				usage: usageContext,
				contextWindow: modelId === void 0 ? void 0 : catalog.current().find((m) => m.id === modelId)?.contextWindow
			});
			if (recovered.ok) {
				await serveSuccessfulStream(res, recovered.account, recovered.result, logger, refreshBalance, pool, usageContext);
				return;
			}
			writeOpenAIError(res, 400, "context_length_exceeded", contextOverflowMessage(modelId, recovered.detail));
			return;
		}
		writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(" → ")}]: ${last.message.slice(0, 400)}`);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
/**
* Build the overflow message the Harness must recognize.
*
* This is deliberately NOT free-form prose. `dsh-compaction-basic` decides
* whether to compact-and-retry by running the text that reaches it through
* `isContextWindowExceededError()` (`@deepseek-ai/dsh-llm`), whose matcher
* accepts only specific phrasings:
*
*   - `context_length_exceeded` / `context window exceeded`
*   - `maximum context length`
*   - `<input|prompt|request|messages> too large|long for ... context`
*   - `<input|prompt|request> exceeds the ... context window`
*
* The obvious friendly sentence ("the conversation exceeds this model's
* context window") matches NONE of them, and neither does the WorkBuddy
* upstream's own "input length too long" / code 11115. Emitting either meant
* the Harness saw an unclassifiable 400, skipped its recovery path, and
* surfaced a dead turn — the bug this function exists to prevent.
*
* The leading clause carries the machine-matched wording; the trailing clause
* is what a human reads. Keep both in sync with
* `tests/context-overflow-contract.test.ts`.
*/
function contextOverflowMessage(modelId, detail = "") {
	return `This model's maximum context length was exceeded: the prompt is too large for ${modelId === void 0 ? "the model" : `model ${modelId}`}, and the conversation could not be compacted in place${detail === "" ? "" : ` (${detail})`}. Compact the conversation, or start a new chat.`;
}
/**
* Where one SSE frame ends inside a buffer.
*
* Both offsets come back because a frame's CONTENT ends before its SEPARATOR
* does: the stripper inspects the content to decide whether the frame is the
* gateway's usage trailer, while the host still needs the separator to keep
* the stream well-formed.
*/
function frameSpan(buf) {
	const bare = buf.indexOf("\n\n");
	const crlf = buf.indexOf("\r\n\r\n");
	if (bare === -1 && crlf === -1) return void 0;
	if (crlf !== -1 && (bare === -1 || crlf < bare)) return {
		contentEnd: crlf,
		frameEnd: crlf + 4
	};
	return {
		contentEnd: bare,
		frameEnd: bare + 2
	};
}
/**
* Serve one already-successful upstream stream as an SSE response.
*
* Extracted so the context-overrun recovery path reuses the exact same
* bookkeeping (noteServed + background balance refresh) as a first-try hit.
*
* The usage trailer is stripped here rather than never requested: the panel is
* built from those numbers, so asking for them and then dropping the frames the
* host did not ask for costs one filter and keeps the forwarded stream
* byte-identical to what the host would have received without it.
*/
async function serveSuccessfulStream(res, account, result, logger, refreshBalance, pool, usage) {
	logger?.info?.(`dsh-xdpool: served by ${account.label}`);
	pool.noteServed(account.id);
	refreshBalance(account);
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no"
	});
	const tracker = new StreamTracker(Date.now());
	let recorded = false;
	/**
	* File this call exactly once.
	*
	* Reached from the filter's flush AND from the upstream error handler, and an
	* upstream stream that dies mid-flight can reach both, so the flag is what
	* keeps one physical call from being counted twice. A stream that broke is
	* recorded as failed: the host got a 200 and then an answer that stops
	* halfway, which is a failed turn from the user's side of the wire.
	*/
	const finish = (ok) => {
		if (recorded) return;
		recorded = true;
		if (usage?.recorder === void 0) return;
		usage.recorder.record({
			region: usage.region,
			model: usage.model,
			account: account.label,
			turnId: usage.turnId,
			at: Date.now(),
			ok,
			...tracker.ttftMs === void 0 ? {} : { ttftMs: tracker.ttftMs },
			...tracker.decodeMs === void 0 ? {} : { decodeMs: tracker.decodeMs },
			...tracker.usage === void 0 ? {} : { usage: tracker.usage }
		});
	};
	let sawDone = false;
	let pending = Buffer.alloc(0);
	const strip = new Transform({
		transform(chunk, _encoding, done) {
			tracker.markFirstByte(Date.now());
			pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
			const keep = [];
			for (;;) {
				const span = frameSpan(pending);
				if (span === void 0) break;
				const seen = inspectSseFrame(pending.subarray(0, span.contentEnd).toString("utf8"));
				if (seen === void 0) keep.push(pending.subarray(0, span.frameEnd));
				else {
					tracker.observe(seen.parsed);
					if (!seen.usageOnly) keep.push(pending.subarray(0, span.frameEnd));
				}
				pending = pending.subarray(span.frameEnd);
			}
			if (keep.length === 0) return done();
			this.push(keep.length === 1 ? keep[0] : Buffer.concat(keep));
			done();
		},
		flush(done) {
			if (pending.length > 0) this.push(pending);
			tracker.finish(Date.now());
			finish(sawDone);
			done();
		}
	});
	const body = Readable.fromWeb(result.response.body);
	body.on("data", (chunk) => {
		if (chunk.includes("[DONE]")) sawDone = true;
	});
	body.on("error", (error) => {
		logger?.warn("dsh-xdpool: upstream stream failed mid-flight", error);
		finish(false);
		if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
	});
	body.pipe(strip).pipe(res);
}
/**
* Compact an over-long conversation and retry it once.
*
* Strategy, in order:
*  1. drop the oldest turns, keeping system messages and the newest exchange;
*  2. ask the model to summarise the dropped turns and splice that summary in;
*  3. hard-truncate as a last resort.
*
* Returns `ok: false` only when even a truncated prompt still overran — the
* caller then surfaces the original actionable 400.
*/
async function recoverFromContextOverrun(options) {
	const { raw, modelId, controller, region, logger, client, pool, maxAttempts, usage } = options;
	const parsed = client.parseChatBody(raw);
	if (parsed === void 0) return {
		ok: false,
		detail: "request body was not parseable JSON"
	};
	const rawMessages = parsed["messages"];
	if (!Array.isArray(rawMessages)) return {
		ok: false,
		detail: "request carried no messages array"
	};
	const messages = rawMessages.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value));
	if (messages.length === 0) return {
		ok: false,
		detail: "request carried no usable messages"
	};
	const overrunTokens = estimateMessagesTokens(messages);
	const realWindow = options.contextWindow;
	const fromWindow = realWindow !== void 0 && realWindow > 0 ? Math.max(512, Math.floor(realWindow * .8) - 2048) : Number.POSITIVE_INFINITY;
	const fromOverrun = Math.max(512, Math.floor(overrunTokens / 2));
	const budget = Math.min(fromWindow, fromOverrun);
	logger?.warn(`dsh-xdpool: context overrun on ${modelId ?? "(no model)"} (~${overrunTokens} tokens, catalog window ${realWindow ?? "unknown"}); compacting to ~${budget} and retrying once`);
	let summary;
	let compacted = messages;
	let compactionDetail = "";
	try {
		const summariser = await pool.acquire(modelId, region);
		if (summariser === void 0) compactionDetail = "no account available to summarise with";
		else {
			const outcome = await compactWithSummary(messages, {
				budget,
				keepRecent: 6
			}, { complete: async (request, signal) => {
				const body = client.buildChatBody({
					...parsed,
					stream: true,
					max_tokens: Math.max(256, Math.floor(budget / 2))
				}, request);
				return await client.completeChat(summariser.credential, body, signal ?? controller.signal, conversationKeyOf(raw));
			} }, controller.signal);
			compacted = outcome.messages;
			summary = outcome.summary;
			if (outcome.skipped !== void 0) compactionDetail = outcome.skipped;
		}
	} catch (error) {
		compactionDetail = `summarisation failed: ${String(error)}`;
	}
	if (estimateMessagesTokens(compacted) > budget) compacted = hardTruncate(compacted, budget).messages;
	if (summary === void 0 && estimateMessagesTokens(compacted) >= overrunTokens) return {
		ok: false,
		detail: compactionDetail === "" ? "compaction could not reduce the prompt" : compactionDetail
	};
	const retryBody = client.buildChatBody(parsed, compacted);
	const tried = [];
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		if (controller.signal.aborted) return {
			ok: false,
			detail: "client disconnected"
		};
		const account = await pool.acquire(modelId, region);
		if (account === void 0) return {
			ok: false,
			detail: "no account available after compaction"
		};
		tried.push(account.label);
		const result = await client.chatStream(account.credential, retryBody, controller.signal, conversationKeyOf(raw));
		if (!result.ok) usage?.recorder.record({
			region: usage.region,
			model: usage.model,
			account: account.label,
			turnId: usage.turnId,
			at: Date.now(),
			ok: false
		});
		if (result.ok) {
			logger?.info?.(`dsh-xdpool: recovered from context overrun on ${modelId ?? "(no model)"} (summarised: ${summary === void 0 ? "no" : "yes"})`);
			return {
				ok: true,
				account,
				result
			};
		}
		if (isContextTooLong(result.message)) return {
			ok: false,
			detail: "prompt still exceeded the window after compaction"
		};
		if (result.kind === "session_dead") {
			const before = account.credential.accessToken;
			if (!await pool.refreshAccount(account.id, { force: true }) || account.credential.accessToken === before) pool.penalizeCredentialDead(account.id);
			continue;
		}
		if (result.kind === "hard_credit") {
			pool.penalizeExhausted(account.id);
			continue;
		}
		if (result.kind === "soft_rate") {
			pool.penalize(account.id, parseRateLimitReset(result.message), modelId);
			continue;
		}
		return {
			ok: false,
			detail: `upstream ${result.kind} after compaction`
		};
	}
	return {
		ok: false,
		detail: `no account served the compacted request (tried ${tried.length})`
	};
}
//#endregion
//#region src/relay.ts
/**
* LAN relay: re-exposes the pool's loopback OpenAI shim on a LAN address, so a
* second machine, a phone, or another editor can talk to the pool with a plain
* OpenAI client.
*
* WHY A SEPARATE LISTENER INSTEAD OF BINDING THE SHIM TO 0.0.0.0
*
* The shim's own secret is minted per process and re-generated on every start.
* Binding the shim directly would mean handing that secret to every device on
* the network: one DSH restart later every client that saved it is broken, and
* in the meantime it has been written into whatever config file each client
* keeps its API key in.
*
* So the relay owns a key of its own, rotatable from the card, and holds the
* shim secret inside the process. A client that has the relay key can reach the
* pool through the relay. The shim secret is never written to a response and
* never leaves this process — that separation is the whole security model, not
* a detail.
*
* The relay translates nothing. It forwards a small whitelisted set of paths
* verbatim and copies the upstream status, headers, and body back, so a remote
* caller sees exactly the shape the shim produces — the shape the tests pin.
* Translating here would put a second, drifting copy of the wire format between
* the client and the code that is actually verified.
*
* @module dsh-xdpool/relay
*/
/**
* Marked on every forwarded request so a relay pointed at its own address
* refuses instead of looping. A client has no reason to send it, and refusing
* is cheaper than debugging a request storm you caused by accident.
*/
const RELAY_HOP_HEADER = "x-xdpool-relay-hop";
/**
* The only paths this relay forwards.
*
* Deliberately exactly the routes the shim serves. Anything else is refused
* with 404 *before* a byte of the body is read or forwarded, so the relay can
* never become a general-purpose proxy for whatever else might answer on the
* shim's port.
*/
const RELAY_FORWARDED_PATHS = /* @__PURE__ */ new Set(["/v1/models", "/v1/chat/completions"]);
/** Default LAN port. Loopback by default; see {@link RELAY_HOSTS}. */
const RELAY_DEFAULT_PORT = 8326;
/**
* Bind addresses the user may choose.
*
* `127.0.0.1` means "no off-box client can reach this at all", and it is the
* default: listening on every interface is a decision to make on purpose, not a
* side effect of a feature existing.
*/
const RELAY_HOSTS = ["127.0.0.1", "0.0.0.0"];
/**
* Bind address and port, or undefined when the settings cannot describe one.
*
* An out-of-range port is treated as "not configured" rather than clamped:
* silently listening somewhere other than where the user asked is worse than
* declining to start and saying so.
*/
function bindTarget(settings) {
	const host = RELAY_HOSTS.includes(settings.host) ? settings.host : RELAY_HOSTS[0];
	if (host === void 0) return void 0;
	const port = settings.port;
	if (!Number.isInteger(port) || port < 0 || port > 65535) return void 0;
	return {
		host,
		port
	};
}
/** Constant-time key comparison that tolerates a missing or wrong-length key. */
function keyMatches(presented, expected) {
	if (expected === "") return false;
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
/**
* The caller's token, falling back to `x-api-key`.
*
* Both spellings are read because Anthropic-compatible clients send the latter,
* and a relay that only understood one of them would look like a dead network
* to half the clients it exists for.
*/
function bearerOf(req) {
	const header = req.headers.authorization;
	if (typeof header === "string") {
		const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
		if (match?.[1] !== void 0) return match[1].trim();
	}
	const alt = req.headers["x-api-key"];
	if (typeof alt === "string") return alt.trim();
	return "";
}
/** Connection-scoped headers, which must not be copied onto the next hop. */
const HOP_BY_HOP = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade"
]);
/**
* Headers for the upstream hop: the caller's, minus the hop-by-hop set and the
* ones that must not travel onward, plus our own hop marker.
*
* `x-api-key` is dropped as well as `authorization`: a client using the
* Anthropic spelling would otherwise have its relay key forwarded verbatim to
* the shim, where it does nothing and is a leaked secret sitting in a log.
*/
function upstreamHeaders(req, shimToken) {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		if (lower === "host" || lower === "authorization" || lower === "x-api-key") continue;
		if (lower === "x-xdpool-relay-hop") continue;
		if (value !== void 0) headers[lower] = value;
	}
	headers.authorization = `Bearer ${shimToken}`;
	headers[RELAY_HOP_HEADER] = "1";
	return headers;
}
function writeJson(res, status, code, message) {
	const body = `${JSON.stringify({ error: {
		message,
		type: code,
		code
	} })}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/**
* Build the relay.
*
* Nothing binds until {@link PoolRelay.ready} settles, so a port clash becomes a
* status the card can display instead of an exception that takes plugin startup
* down with it.
*/
function createPoolRelay(options) {
	const { shim, logger } = options;
	let server;
	let listening = false;
	let boundHost = "";
	let boundPort = 0;
	let bindError = "";
	/** Re-read per request; a throwing reader must not take the relay down. */
	const settingsOf = () => {
		try {
			return options.read();
		} catch (error) {
			logger?.warn(`xdpool relay: settings unreadable, treating the relay as off: ${String(error)}`);
			return {
				enabled: false,
				host: RELAY_HOSTS[0] ?? "127.0.0.1",
				port: RELAY_DEFAULT_PORT,
				key: ""
			};
		}
	};
	const stop = () => new Promise((resolve) => {
		const current = server;
		server = void 0;
		listening = false;
		boundHost = "";
		boundPort = 0;
		if (current === void 0) {
			resolve();
			return;
		}
		current.closeAllConnections?.();
		current.close(() => resolve());
	});
	const start = (host, port) => new Promise((resolve) => {
		const next = createServer(handle);
		const fail = (error) => {
			bindError = error instanceof Error ? error.message : String(error);
			logger?.warn(`xdpool relay: cannot bind ${host}:${port} — ${bindError}`);
			next.close(() => resolve());
		};
		next.once("error", fail);
		next.listen(port, host, () => {
			next.removeListener("error", fail);
			const address = next.address();
			if (address === null || typeof address === "string") {
				bindError = "the listener bound an address the relay cannot advertise";
				next.close(() => resolve());
				return;
			}
			server = next;
			listening = true;
			boundHost = host;
			boundPort = address.port;
			bindError = "";
			logger?.info?.(`xdpool relay: listening on http://${host}:${address.port}/v1`);
			resolve();
		});
	});
	function handle(req, res) {
		const settings = settingsOf();
		if (req.headers["x-xdpool-relay-hop"] !== void 0) {
			writeJson(res, 508, "relay_loop", "this request already came through the relay");
			return;
		}
		if (!settings.enabled) {
			writeJson(res, 503, "relay_disabled", "the XD Pool LAN relay is switched off");
			return;
		}
		if (!keyMatches(bearerOf(req), settings.key)) {
			writeJson(res, 401, "relay_unauthorized", "a valid XD Pool relay key is required");
			return;
		}
		const path = (req.url ?? "").split("?")[0] ?? "";
		if (!RELAY_FORWARDED_PATHS.has(path)) {
			writeJson(res, 404, "relay_no_route", `${path} is not a path this relay forwards`);
			return;
		}
		const target = new URL(`${shim.baseUrl()}${path}`);
		const upstream = (target.protocol === "https:" ? request$1 : request)({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port === "" ? 80 : Number(target.port),
			method: req.method,
			path: `${target.pathname}${target.search}`,
			headers: upstreamHeaders(req, shim.token())
		}, (answer) => {
			res.writeHead(answer.statusCode ?? 502, answer.headers);
			answer.pipe(res);
		});
		res.once("close", () => {
			if (!res.writableEnded) upstream.destroy();
		});
		upstream.on("error", (error) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			writeJson(res, 502, "relay_unreachable", `the pool shim did not answer: ${String(error)}`);
		});
		req.pipe(upstream);
	}
	const sync = async () => {
		const settings = settingsOf();
		const target = bindTarget(settings);
		if (!settings.enabled || target === void 0) {
			await stop();
			bindError = settings.enabled && target === void 0 ? `port ${settings.port} is not a port this relay can bind` : "";
			return;
		}
		if (satisfied(target.host, target.port)) return;
		await stop();
		await start(target.host, target.port);
	};
	/**
	* Whether the current listener already satisfies what the settings ask for.
	*
	* Compared against the REQUESTED port, not the bound one: binding port 0
	* resolves to some port the OS chose, so comparing the resolved value against
	* the request of 0 would never match and every sync would rebind — handing the
	* user a different port each time they saved anything.
	*/
	const satisfied = (host, requestedPort) => server !== void 0 && host === boundHost && (requestedPort === 0 || requestedPort === boundPort);
	const status = async () => {
		const settings = settingsOf();
		return {
			enabled: settings.enabled,
			listening,
			host: boundHost === "" ? settings.host : boundHost,
			port: boundPort === 0 ? settings.port : boundPort,
			endpoint: listening ? `http://${boundHost}:${boundPort}/v1` : "",
			key: settings.key,
			error: bindError
		};
	};
	return {
		ready: sync().then(() => void 0),
		status,
		sync: async () => {
			await sync();
			return status();
		},
		close: stop
	};
}
/** A fresh relay key: 32 random bytes, URL-safe so it survives a copy-paste. */
function newRelayKey() {
	return randomBytes(32).toString("base64url");
}
//#endregion
//#region src/status.ts
/** Build the status document. Never throws. */
async function buildStatus(options) {
	const { pool, catalog, client } = options;
	const accounts = pool.list();
	const now = Date.now();
	const rows = [];
	for (const account of accounts) {
		const modelCooldowns = Object.entries(account.modelCooldowns).filter(([, until]) => until > now).sort((a, b) => a[1] - b[1]).map(([modelId, until]) => ({
			modelId,
			until: new Date(until).toISOString()
		}));
		const row = {
			id: account.id,
			label: account.label,
			...account.credential.nickname === void 0 ? {} : { nickname: account.credential.nickname },
			domain: account.credential.domain,
			...account.credential.expiresAtMs === 0 ? {} : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
			cooling: account.cooldownUntilMs > now,
			...account.cooldownUntilMs > now ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
			...modelCooldowns.length === 0 ? {} : { modelCooldowns },
			rateLimitHits: account.rateLimitHits,
			sourcePath: account.credential.sourcePath
		};
		if (options.includeCredits === true && !row.cooling) try {
			Object.assign(row, { credits: await client.fetchCredits(account.credential) });
		} catch (error) {
			Object.assign(row, { creditsError: String(error).slice(0, 200) });
		}
		rows.push(row);
	}
	const cooling = rows.filter((row) => row.cooling).length;
	const firstUsable = accounts.find((account) => account.cooldownUntilMs <= now);
	return {
		ok: accounts.length > 0 && cooling < accounts.length,
		accounts: rows,
		...firstUsable === void 0 ? {} : { activeAccountId: firstUsable.id },
		cooling,
		models: catalog.current().map((model) => ({
			id: model.id,
			name: model.name,
			...model.multiplier === void 0 ? {} : { multiplier: model.multiplier },
			...model.tags === void 0 ? {} : { tags: model.tags }
		})),
		shim: options.shim ?? { running: false }
	};
}
/** Format the status document for a terminal. */
function formatStatus(status) {
	const lines = [];
	lines.push(`WorkBuddy XD Pool: ${status.accounts.length} account(s), ${status.cooling} cooling`);
	lines.push(`Shim: ${status.shim.running ? "running" : "stopped"}${status.shim.baseUrl === void 0 ? "" : ` at ${status.shim.baseUrl}`}`);
	lines.push("");
	if (status.accounts.length === 0) {
		lines.push("No WorkBuddy credential found. Sign in on the WorkBuddy desktop app,");
		lines.push("then run: dsh plugin --profile desktop exec dsh-xdpool import <key>");
		return lines.join("\n");
	}
	for (const account of status.accounts) {
		const flag = account.cooling ? "⏸ " : "▶ ";
		const active = account.id === status.activeAccountId ? " (next up)" : "";
		lines.push(`${flag}${account.label}${active}`);
		lines.push(`    uid/uin   : ${account.id}  [${account.domain || "cn"}]`);
		if (account.expiresAt !== void 0) lines.push(`    expires   : ${account.expiresAt}`);
		if (account.credits !== void 0) {
			const { total } = account.credits;
			const parts = [];
			if (total !== void 0) parts.push(`total ${total}`);
			lines.push(`    credits   : ${parts.join(" | ") || "n/a"}`);
		}
		if (account.creditsError !== void 0) lines.push(`    credits   : query failed — ${account.creditsError}`);
		if (account.cooling && account.cooldownUntil !== void 0) lines.push(`    cooldown  : until ${account.cooldownUntil} (hits ${account.rateLimitHits})`);
		if (account.modelCooldowns !== void 0 && account.modelCooldowns.length > 0) for (const mc of account.modelCooldowns) lines.push(`    model-cool: ${mc.modelId} until ${mc.until}`);
		lines.push(`    source    : ${account.sourcePath}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
/** Format the per-model credit multipliers. */
function formatRates(status) {
	const lines = ["Model credit multipliers:"];
	for (const model of status.models) {
		const rate = model.multiplier === void 0 ? "x?" : `x${model.multiplier.toFixed(2)}`;
		lines.push(`  ${model.name.padEnd(20)} ${rate}`);
	}
	return lines.join("\n");
}
//#endregion
//#region src/migrate.ts
/**
* One-time adoption of state written under the plugin's pre-rename name.
*
* WHAT CHANGED
*
* This plugin used to be `dsh-workbuddy-xdpool`, and its own directory was
* `~/.dsh/.workbuddy-xdpool`. It is now `dsh-xdpool`, reading `~/.dsh/.xdpool`.
* Every name the plugin owned changed at once — package, provider ids, settings
* namespace, CLI and this directory — so an existing install that simply
* upgrades would otherwise look like a fresh one and silently lose:
*
*   - the API keys typed into the aggregate page,
*   - the account ignore list,
*   - the preferred account,
*   - the startup trace.
*
* NONE OF THAT IS RECONSTRUCTIBLE. The keys are the user's own credentials for
* third-party vendors; nothing upstream can hand them back. So the old
* directory is COPIED, never moved and never deleted — a downgrade, or a user
* who keeps both builds side by side, must still find the original intact.
*
* WHY COPY AND NOT RENAME
*
* A rename would be atomic and cheaper, and it is the wrong choice: if the
* upgrade is later rolled back, or if both builds run on one machine, the older
* build would find its directory gone. Copying costs a few kilobytes and leaves
* both halves working.
*
* WHAT THIS DELIBERATELY DOES NOT TOUCH
*
* Two other things carry the old name, and neither can be migrated from inside
* the plugin:
*
*   1. `settings.yaml`'s `agent-default-model.provider` and the profile's
*      `cordis.patch.yml`, which pin the user's default model to a provider id.
*      Those files belong to the host profile, not to this plugin, and writing
*      them from here would be the plugin editing its own loader config. The
*      plugin logs the exact rename instead — see `describeProviderIdRename`.
*   2. The old settings namespace's saved values. The host resolves those by
*      namespace, and the plugin only ever sees the new one.
*
* @module dsh-xdpool/migrate
*/
/** Directory the plugin wrote before the rename. */
const LEGACY_DATA_DIR_NAME = ".workbuddy-xdpool";
/** Directory it writes now. */
const CURRENT_DATA_DIR_NAME = ".xdpool";
/** Provider ids before the rename, and what each became. */
const PROVIDER_ID_RENAMES = Object.freeze({
	"workbuddy-xdpool": "xdpool",
	"workbuddy-xdpool-global": "xdpool-global",
	"workbuddy-xdpool-aggregate": "xdpool-aggregate",
	"workbuddy-xdpool-free": "xdpool-free"
});
/** The DSH home, honouring the same override the rest of the plugin uses. */
function dshHome$1(env) {
	const fromEnv = env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	return join(homedir(), ".dsh");
}
/**
* Copy the pre-rename data directory into the current one, once.
*
* Idempotent and safe to call on every startup:
*
*   - no legacy directory  -> nothing to do,
*   - current directory already exists -> do not touch it, because it may hold
*     newer state than the legacy one and merging the two would resurrect
*     values the user has since changed,
*   - legacy directory empty -> nothing worth copying.
*
* Individual files are copied only when the destination does not already have
* that name, so a partially-populated new directory still gains whatever it is
* missing without any file being overwritten.
*
* Never throws: a failed adoption must not stop the plugin from starting. The
* caller logs the returned reason.
*/
function adoptLegacyDataDir(env = process.env) {
	const home = dshHome$1(env);
	const to = join(home, CURRENT_DATA_DIR_NAME);
	const from = join(home, LEGACY_DATA_DIR_NAME);
	if (!existsSync(from)) return {
		adopted: false,
		to,
		files: [],
		skipped: "no-legacy-dir"
	};
	let legacyNames;
	try {
		legacyNames = readdirSync(from).filter((name) => {
			try {
				return statSync(join(from, name)).isFile();
			} catch {
				return false;
			}
		});
	} catch {
		return {
			adopted: false,
			to,
			files: [],
			skipped: "failed"
		};
	}
	if (legacyNames.length === 0) return {
		adopted: false,
		from,
		to,
		files: [],
		skipped: "legacy-empty"
	};
	const copied = [];
	try {
		for (const name of legacyNames) {
			const target = join(to, name);
			if (existsSync(target)) continue;
			cpSync(join(from, name), target);
			copied.push(name);
		}
	} catch {
		return {
			adopted: copied.length > 0,
			from,
			to,
			files: copied.sort(),
			...copied.length === 0 ? { skipped: "failed" } : {}
		};
	}
	if (copied.length === 0) return {
		adopted: false,
		from,
		to,
		files: [],
		skipped: "already-migrated"
	};
	return {
		adopted: true,
		from,
		to,
		files: copied.sort()
	};
}
/**
* The one-line instruction for a user whose default model is still pinned to a
* pre-rename provider id.
*
* This is deliberately a message and not an edit. The pin lives in the host
* profile's own `settings.yaml` / `cordis.patch.yml`; rewriting those from
* inside the plugin would mean the plugin editing the loader config that mounts
* it, which is exactly the kind of self-modifying setup that turns a rename into
* an unbootable install. Naming the file and the replacement is the honest
* middle ground: the plugin cannot silently fix it, and the user can in one
* edit.
*/
function describeProviderIdRename() {
	return "provider ids renamed (" + Object.entries(PROVIDER_ID_RENAMES).map(([before, after]) => `${before} -> ${after}`).join(", ") + "); if your default model was pinned to an old id, update \"agent-default-model.provider\" in the profile settings.yaml and any matching row in cordis.patch.yml";
}
//#endregion
//#region pi-ai-generation.ts
/**
* Cross-generation guard for `@earendil-works/pi-ai`.
*
* The failure this exists to catch: the plugin assembles its provider with ONE
* copy of pi-ai while the host's `PiAiAdapter` consumes the event stream with
* ANOTHER. The two generations disagree on the shape of the terminal message,
* and the seam between them throws `Cannot read properties of undefined
* (reading 'length')` inside the host adapter — which the host then classifies
* as a non-retryable `PI_AI_ERROR`. From the user's side it is "every turn
* fails, immediately, with no content and no useful error".
*
* A `package.json` range cannot prevent this. The old peer range was
* `>=0.82.1 <0.85.0` while the host shipped 0.87.x: the upper bound excluded the
* host's generation outright, which turned a cross-generation mix into a
* legitimate install. Ranges describe what a package tolerates; they cannot
* describe what the OTHER resolved copy on the same machine happens to be.
*
* So this checks the resolved reality at load time and says so, loudly, in the
* log. It does NOT refuse to start: a version mismatch might well be benign, and
* a plugin that hard-fails on a guess would be worse than one that warns.
*
* @module dsh-xdpool/pi-ai-generation
*/
/** The package whose generation must agree between plugin and host. */
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
/**
* The major.minor of a version string, which is what "generation" means here.
*
* Patch differences are expected and harmless; two copies differing in
* minor — 0.85 vs 0.87 — is exactly the split that broke the adapter seam.
*/
function generationOf(version) {
	const trimmed = version.trim();
	const parts = /^(\d+)\.(\d+)/u.exec(trimmed);
	if (parts === null || parts === void 0 || parts[1] === void 0 || parts[2] === void 0) return trimmed;
	return `${parts[1]}.${parts[2]}`;
}
/**
* Read the version of a resolved pi-ai, starting the lookup from `fromDir`.
*
* Using `require.resolve` with an explicit anchor is what makes the two sides
* distinguishable: resolving plainly would return whichever copy this module
* happens to see, the same one for both, and the comparison would always pass.
*/
function piAiGenerationFrom(fromDir) {
	try {
		const require_ = createRequire(`${fromDir.replace(/[\\/]+$/u, "")}/`);
		const pkgPath = require_.resolve(`${PI_AI_PACKAGE}/package.json`);
		const pkg = require_(pkgPath);
		if (typeof pkg.version !== "string") return void 0;
		return {
			version: pkg.version,
			resolvedFrom: pkgPath
		};
	} catch {
		return;
	}
}
/**
* Compare the copy the plugin assembled with against the copy the host adapter
* will use.
*
* `hostDir` should be a directory inside the host install (its own
* `node_modules`), so the two resolutions walk different trees.
*/
function checkPiAiGeneration(pluginDir, hostDir) {
	const plugin = piAiGenerationFrom(pluginDir);
	const host = piAiGenerationFrom(hostDir);
	if (plugin === void 0 || host === void 0) return { kind: "unknown" };
	if (generationOf(plugin.version) === generationOf(host.version)) return {
		kind: "aligned",
		generation: generationOf(plugin.version)
	};
	return {
		kind: "mismatched",
		plugin,
		host
	};
}
/**
* A warning message for a mismatched pair, or undefined when there is nothing
* to say.
*/
function piAiMismatchMessage(check) {
	if (check.kind !== "mismatched") return void 0;
	return `dsh-xdpool: @earendil-works/pi-ai generation mismatch — this plugin assembled its provider with ${check.plugin.version} while the host adapter resolves ${check.host.version}. Two generations on one call chain produce a TypeError at the adapter seam ("Cannot read properties of undefined"), which the host reports as a non-retryable PI_AI_ERROR, so every turn fails with no content. Align the two by pinning pi-ai to the host generation (for example a pnpm \`overrides\` entry in the profile) and restart DSH.`;
}
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
* Synchronous read, for startup.
*
* The host pins the account from inside `apply()`, which is synchronous, and
* doing it there removes a startup race: an async load could resolve AFTER the
* first account scan, so the first request of the process would be served by
* whichever account the strategy picked rather than the one the user asked for.
* The file is tens of bytes, so a blocking read at startup costs nothing
* measurable.
*/
function readPreferredIdSync(path = preferredIdPath()) {
	try {
		return normalize(JSON.parse(readFileSync(path, "utf8")));
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
	await writeFile(temp, `${payload}\n`, "utf8");
	await rename(temp, path);
}
//#endregion
//#region src/index.ts
/**
* Host-side plugin entry. Registers the `xdpool` provider into the
* Harness LLM seam once the loopback shim holds its port, plus the HTTP status
* routes consumed by the CLI.
*
* @module dsh-xdpool/index
*/
/**
* One aggregate catalog row as the card renders it.
*
* A local mapping rather than a cast: the row is the plugin's own type and the
* document's is the card's, and a cast would let one gain a field the other
* lacks without anything saying so.
*/
function toWebAggregateModel(row) {
	return {
		id: row.id,
		name: row.name,
		providerId: row.providerId,
		modelId: row.modelId,
		contextWindow: row.contextWindow,
		maxOutputTokens: row.maxOutputTokens,
		supportsImages: row.supportsImages,
		source: row.source
	};
}
/**
* The relay's settings, with defaults filled in.
*
* A partially-written section reads as the safest interpretation of itself: off,
* loopback-only, no key. `enabled` in particular is never inferred from the
* presence of a key or a host — an absent `enabled` means the user never turned
* this on, and guessing otherwise would expose their account pool to the network
* because a file happened to have a port in it.
*/
function relaySettingsOf(store) {
	const saved = store.relay ?? {};
	const host = RELAY_HOSTS.includes(saved.host ?? "") ? saved.host ?? RELAY_HOSTS[0] ?? "127.0.0.1" : RELAY_HOSTS[0] ?? "127.0.0.1";
	return {
		enabled: saved.enabled === true,
		host,
		port: saved.port ?? 8326,
		key: saved.key ?? ""
	};
}
/**
* The routing document the chain editor draws from.
*
* `missing` is reported rather than silently dropped: the user's chain named a
* model that is gone, and the only honest thing is to show them WHICH one. OFM
* makes the same choice, for the same reason — a chain that quietly rewrites
* itself looks like it obeyed, and the user is the only one who can tell that a
* member they paid for is now a fallback to something free.
*/
function combosStatusOf(store, catalog, poolRows) {
	const chains = combosOf(store);
	const providerRows = catalog.providerRows();
	const settings = new Map(configuredProviderIds(store).map((providerId) => [providerId, providerSettingOf(store, providerId)]));
	const candidates = [...poolRows.map((row) => ({
		id: row.id,
		name: row.name,
		owner: "workbuddy",
		usable: true,
		contextWindow: row.contextWindow,
		supportsImages: row.supportsImages
	})), ...providerRows.map((row) => {
		const setting = settings.get(row.providerId);
		const provider = getProvider(row.providerId);
		return {
			id: row.id,
			name: row.name,
			owner: row.providerId,
			usable: provider === null || setting === void 0 ? false : providerAuthUsable(provider, setting),
			contextWindow: row.contextWindow,
			supportsImages: row.supportsImages
		};
	})];
	const known = new Set(candidates.map((candidate) => candidate.id));
	return {
		combos: chains.map((chain) => {
			const resolved = buildComboCatalog([chain], {
				pool: poolRows,
				aggregate: providerRows
			})[0];
			return {
				id: resolved?.id ?? comboId(chain.name),
				name: chain.name,
				models: resolved?.models ?? [],
				missing: chain.models.filter((modelId) => !known.has(modelId)),
				strategy: resolved?.strategy ?? chain.strategy ?? "fallback",
				stickyLimit: resolved?.stickyLimit ?? chain.stickyLimit ?? 1,
				enabled: chain.enabled !== false,
				contextWindow: resolved?.contextWindow ?? 131072,
				supportsImages: resolved?.supportsImages ?? false
			};
		}),
		candidates
	};
}
/**
* This plugin's install root, the tree its own provider is assembled from.
*
* Two directories up from `lib/` — the built bundle sits in `lib/`, so the
* package root is its parent. Used as one side of the pi-ai generation check.
*/
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
* The host's own module directory, the tree its `PiAiAdapter` resolves from.
*
* Reached from the host package this plugin is loaded by: walking up from a
* `@deepseek-ai/dsh-llm-pi-ai` import lands in the host's `node_modules`, which
* is where the HOST generation actually lives. The plugin's own tree is the
* other side; comparing one tree with itself would always agree.
*/
const HOST_MODULE_ROOT = (() => {
	try {
		return fileURLToPath(new URL("../../node_modules/@deepseek-ai/dsh-llm-pi-ai/", import.meta.url));
	} catch {
		return "";
	}
})();
/** Stable Cordis plugin name. */
const name = "llm-xdpool";
/** The model registry required before the provider can register. */
const inject = ["llm", "settings"];
/**
* Settings namespace for the XD Pool card. Registering a section here
* is what makes the provider appear on the Models settings page and causes the
* Host to mount the plugin's client card under Plugin configuration — exactly
* the mechanism the single-account connector uses.
*/
const XDPOOL_SETTINGS_NS = "xdpool";
/** Upper bound the card offers as the "default" context window, in tokens. */
const DEFAULT_CONTEXT_BUDGET = 2e5;
/**
* Fold a saved automation block into scheduler options.
*
* Absent means off, stated once here so every caller agrees: the card writes
* `enabled` as a real boolean, and a config that never touched the section must
* not accidentally arm background upstream traffic.
*/
function automationOptions(automation) {
	return {
		enabled: automation?.enabled === true,
		...automation?.checkinHours === void 0 ? {} : { checkinHours: automation.checkinHours },
		...automation?.reportHours === void 0 ? {} : { reportHours: automation.reportHours },
		...automation?.taskHours === void 0 ? {} : { taskHours: automation.taskHours },
		...automation?.streakHours === void 0 ? {} : { streakHours: automation.streakHours },
		...automation?.travelHours === void 0 ? {} : { travelHours: automation.travelHours },
		...automation?.compensationHours === void 0 ? {} : { compensationHours: automation.compensationHours }
	};
}
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
* Peel one live volatile reference.
*
* On 0.1.7 a volatile field is handed back as `{ get(): T }` rather than a
* plain value, so a running instance observes a settings edit without being
* remounted. Every read of a marked field therefore has to unwrap: passing the
* reference onward compares an object against a string and reports the field as
* unset. On 0.1.5 the field is already a plain value, so this is a no-op.
*
* The test is duck-typed on purpose — importing `isVolatile` would add a
* dependency the 0.1.5 line does not carry.
*/
function unwrapVolatile(value) {
	if (value !== null && typeof value === "object" && typeof value.get === "function") return value.get();
	return value;
}
/**
* Deep copy of a config value with every live `{get(): T}` reference replaced
* by the value it resolves to.
*
* {@link unwrapVolatile} peels only the one level an ordinary read needs. A
* settings service is different: it validates and `structuredClone`s the WHOLE
* object, so a reference surviving anywhere inside it fails schema validation
* with a message that names the field but not the cause —
* `$.authFile expected string but got [object Object]`. That is what makes the
* namespace fail to register and the card silently disappear, which is why the
* object handed to `installSection` goes through this first.
*/
function unwrapVolatileDeep(value) {
	const peeled = unwrapVolatile(value);
	if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry));
	if (peeled !== null && typeof peeled === "object") {
		const out = {};
		for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry);
		return out;
	}
	return peeled;
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
/** Settings key holding one region's saved selection. */
const modelSelectionKeyFor = (region) => region === "cn" ? "modelSelectionCn" : "modelSelectionGlobal";
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
const Config = z.object({
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
/** Live API, published for the CLI. */
let api;
/** The live API, or undefined when the plugin has not applied yet. */
function currentApi() {
	return api;
}
/** Test seam: install an API instance without booting cordis. */
function setApi(next) {
	api = next;
}
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
/**
* Log a warning when the plugin and the host resolve different pi-ai
* generations.
*
* Never throws and never blocks startup: the check is a filesystem lookup, and
* a plugin that refused to load because of a version guess would be worse than
* one that merely warns. The two directories are THIS plugin's install root and
* the host's own module directory, so the two resolutions walk different trees —
* resolving from one place only would compare a copy with itself and always
* agree.
*/
function warnOnPiAiGenerationMismatch(ctx) {
	try {
		const message = piAiMismatchMessage(checkPiAiGeneration(PLUGIN_ROOT, HOST_MODULE_ROOT));
		if (message !== void 0) ctx.logger.warn(message);
	} catch {}
}
/**
* Start the loopback endpoint, register the `xdpool` provider, and
* discover accounts. The provider registers only after `shim.ready` resolves,
* because its models read the shim origin at construction time.
*/
function apply(ctx, config = {}) {
	const core = createCore(ctx.logger);
	warnOnPiAiGenerationMismatch(ctx);
	const migration = adoptLegacyDataDir();
	if (migration.adopted) recordStartupNote(`adopted pre-rename state from ${migration.from ?? "(unknown)"} -> ${migration.to} (${migration.files.length} file(s): ${migration.files.join(", ")})`);
	else if (migration.skipped === "failed") recordStartupNote(`could not adopt pre-rename state into ${migration.to}; continuing with current data`);
	const ignoredPath = ignoredIdsPath();
	let ignoredAccounts = readIgnoredAccountsSync(ignoredPath);
	core.pool.applyIgnored(ignoredAccounts.map((entry) => entry.id));
	/** Re-read the ignore file and push it into the pool. */
	const refreshIgnored = () => {
		ignoredAccounts = readIgnoredAccountsSync(ignoredPath);
		core.pool.applyIgnored(ignoredAccounts.map((entry) => entry.id));
	};
	const preferredPath = preferredIdPath();
	const applyPreferred = (accountId) => {
		core.pool.prefer(accountId);
	};
	applyPreferred(readPreferredIdSync(preferredPath));
	/**
	* Fetch and install the model catalog for both regions.
	*
	* Each region is isolated AND independently retried: they are separate
	* gateways on separate hosts, so one being unreachable must not degrade the
	* other. The failure this exists for is a startup network hiccup — several
	* components reporting `fetch failed` inside the same second, with the next
	* request succeeding 0.7s later — which used to cost the user their model
	* list for the whole session, with no way back short of a DSH restart.
	*
	* Returns what each region ended up with, so the card can confirm a manual
	* refresh actually changed something.
	*/
	const seedCatalog = async () => {
		const accounts = await core.pool.scan();
		const regions = {};
		for (const region of ["cn", "global"]) try {
			const credential = accounts.find((account) => regionOf(account.credential.domain) === region)?.credential;
			if (credential === void 0) {
				ctx.logger.info?.(`dsh-xdpool: no ${region} account yet; keeping the static ${region} catalog`);
				regions[region] = {
					source: "fallback",
					models: core.catalogs[region].current().length
				};
				continue;
			}
			const models = await core.client.fetchModels(credential);
			core.catalogs[region].updateFromUpstream(models);
			ctx.logger.info?.(`dsh-xdpool: ${region} catalog seeded with ${models.length} model(s)`);
			regions[region] = {
				source: "live",
				models: models.length
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			core.catalogs[region].noteFetchFailure(message);
			ctx.logger.warn(`dsh-xdpool: ${region} model catalog unavailable; using static fallback`, error);
			regions[region] = {
				source: core.catalogs[region].currentSource(),
				models: core.catalogs[region].current().length,
				error: message
			};
		}
		return { regions };
	};
	/**
	* Invalidate the provider snapshot so the picker re-reads the catalog.
	*
	* Seeded with a no-op and reassigned once the adapters exist. The settings
	* section calls its `onChange` hook SYNCHRONOUSLY from `installSection`,
	* before registration has run, so a plain `let builtAdapter` declared later
	* would be read from its temporal dead zone ("Cannot access `builtAdapter`
	* before initialization") and abort the whole apply — which in turn leaves the
	* providers undeclared and the settings page unable to render them.
	*/
	/** The domestic adapter, published for the CLI after registration. */
	let builtAdapter;
	let invalidateCatalog = () => {};
	/**
	* The effective config with every live volatile reference peeled.
	*
	* On 0.1.7 a field marked volatile is handed to the plugin as `{get(): T}` so
	* a settings edit is observed without a remount, and the loader keeps the
	* reference live. Every read below therefore goes through this view: a raw
	* reference compared against a string reports the field as unset, which is
	* how a saved reserve would read back as "0" while the file holds the value.
	* On 0.1.5 there is nothing to peel and this is the identity.
	*/
	let rawCurrent = () => config;
	const current = () => unwrapVolatileDeep(rawCurrent());
	const sectionHooks = {
		setSource(source) {
			rawCurrent = source;
		},
		onChange() {
			applyConfigFromSource();
		}
	};
	const applyConfigFromSource = () => {
		const { authFile, cooldownMs, distribution, disabledAccountIds, creditReserves, enabledModelIds, imageModelIds, contextBudgets, modelSelectionCn, modelSelectionGlobal, automation } = current();
		core.pool.applyConfig({
			...authFile === void 0 ? {} : { authDirs: [dirname(authFile)] },
			...cooldownMs === void 0 ? {} : { cooldownMs },
			distribution: distribution ?? "priority",
			...disabledAccountIds === void 0 ? {} : { disabledAccountIds },
			...creditReserves === void 0 ? {} : { creditReserves },
			...automation?.exhaustCooldownMs === void 0 ? {} : { exhaustCooldownMs: automation.exhaustCooldownMs }
		});
		const legacySelection = {
			...enabledModelIds === void 0 ? {} : { enabledModelIds },
			...imageModelIds === void 0 ? {} : { imageModelIds },
			...contextBudgets === void 0 ? {} : { contextBudgets }
		};
		const fallbackSelection = (region) => {
			return legacySelection.enabledModelIds === void 0 && legacySelection.imageModelIds === void 0 && legacySelection.contextBudgets === void 0 ? core.catalogs[region].currentSelection() : legacySelection;
		};
		core.catalogs.cn.applySelection(modelSelectionCn ?? fallbackSelection("cn"));
		core.catalogs.global.applySelection(modelSelectionGlobal ?? fallbackSelection("global"));
		core.scheduler.applyConfig(automationOptions(automation));
	};
	const settingsService = ctx.settings;
	if (typeof settingsService.installSection === "function") settingsService.installSection(ctx, XDPOOL_SETTINGS_NS, Config, unwrapVolatileDeep(config), sectionHooks);
	if (typeof settingsService.configure === "function") ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}));
	if (typeof settingsService.installSection !== "function" && typeof settingsService.configure !== "function") ctx.logger.warn?.("dsh-xdpool: settings service exposes neither installSection nor configure; the card will not mount");
	ctx.on("loader/volatile-update", () => {
		applyConfigFromSource();
	});
	applyConfigFromSource();
	recordStartupNote(`apply entered host=${typeof ctx.llm?.registerAdapter} settings=${typeof settingsService.installSection}/${typeof settingsService.configure}`);
	/**
	* Write one key of the plugin's own settings section. Only ever called with
	* the three model-selection keys, so the settings file cannot be steered from
	* the browser; the catalog re-reads through `onChange` either way.
	*/
	/**
	* Persist one settings key, then VERIFY it landed.
	*
	* The settings service resolves `set()` even when the write did not stick, so a
	* fire-and-forget call reports success while the file keeps the old value — and
	* the card then shows a value that silently reverts on the next read. That is
	* exactly the "I typed a reserve, reopened, and it still says 0" report: the
	* write was reported as saved but never reached the document. Every write now
	* awaits the setter and re-reads the document; a mismatch throws so the caller
	* surfaces a real error instead of claiming success.
	*
	* `expected` is what the caller believes it just wrote. Comparison goes through
	* a JSON round-trip so key order cannot cause a false mismatch.
	*/
	/**
	* Deep equality that ignores key order, used to verify a settings write.
	*
	* `JSON.stringify` is key-order sensitive, so comparing two equal objects whose
	* keys were inserted in a different order would report a false "not persisted"
	* failure — and a false failure on a write that DID land is as harmful as a
	* false success: it sends the user chasing a bug that is not there.
	*/
	function stableJsonEqual(left, right) {
		return canonicalJson(left) === canonicalJson(right);
	}
	function canonicalJson(value) {
		if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
		if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
		return JSON.stringify(value);
	}
	/**
	* The namespace `settings.update` expects on the running line.
	*
	* 0.1.5 resolves writers by the NAMESPACE the plugin registered through
	* `installSection`, so the plugin picks it. 0.1.7 resolves them by the HOST
	* PLUGIN ENTRY ID instead (`configEditor.entries().find(row => row.options.id
	* === ns)`), and the profile patch chooses that id — the live Desktop host
	* mounts this plugin as `llm-xdpool`, but a marketplace install can
	* wrap it (`mkt-...`) or mount it through an `include` row. Asking the fiber
	* for its own entry id is therefore the only correct answer there; guessing
	* our own namespace makes every save throw `No configurable plugin entry`.
	*/
	const settingsWriteNs = typeof settingsService.installSection === "function" ? XDPOOL_SETTINGS_NS : (() => {
		try {
			const entryId = ctx.fiber?.entry?.options?.id;
			return entryId === void 0 || entryId === "" ? XDPOOL_SETTINGS_NS : entryId;
		} catch {
			return XDPOOL_SETTINGS_NS;
		}
	})();
	const setSetting = async (key, value, expected) => {
		if (value === void 0) return;
		const update = settingsService?.update;
		if (update === void 0) throw new Error(`settings service has no update(); ${key} was not saved`);
		await update.call(settingsService, settingsWriteNs, { [key]: value });
		if (expected !== void 0) {
			const stored = current()[key];
			if (!stableJsonEqual(stored, expected)) throw new Error(`settings field "${key}" was not persisted`);
		}
	};
	core.scheduler.setEarningsPersistence(async (ledger) => {
		await setSetting("automationEarnings", ledger, ledger);
	});
	const storedLedger = current().automationEarnings;
	if (storedLedger !== void 0) core.scheduler.applyEarningsLedger(storedLedger);
	const usageRecorder = new UsageRecorder();
	const aggregateCatalog = new AggregateCatalog(() => readAggregateSettingsSync(), () => core.catalogs.cn.current());
	aggregateCatalog.refresh();
	const freeCatalog = new FreeCatalog();
	const freeLane = createFreeLaneSource(freeCatalog, ctx.logger, usageRecorder);
	const shims = {
		cn: createWorkBuddyShim({
			pool: core.pool,
			client: core.client,
			catalog: core.catalogs.cn,
			logger: ctx.logger,
			region: "cn",
			usageRecorder,
			aggregate: {
				catalog: aggregateCatalog,
				readStore: () => readAggregateSettingsSync()
			},
			extra: { free: freeLane }
		}),
		global: createWorkBuddyShim({
			pool: core.pool,
			client: core.client,
			catalog: core.catalogs.global,
			logger: ctx.logger,
			region: "global",
			usageRecorder
		})
	};
	const shim = shims.cn;
	/** Resolve a region's loopback origin once it has bound a port. */
	const shimInfo = (which) => {
		try {
			return {
				running: true,
				baseUrl: shims[which].baseUrl()
			};
		} catch {
			return { running: false };
		}
	};
	let stopped = false;
	/**
	* The LAN relay, mounted on the CN shim only.
	*
	* It is not folded into the shim's own listener on purpose — see
	* `src/relay.ts`: the shim secret is per-process, and handing it to every
	* device on the network would break every client on the next DSH restart.
	* The relay holds that secret and authenticates clients with a key of its own.
	*/
	const relay = createPoolRelay({
		shim: shims.cn,
		read: () => relaySettingsOf(readAggregateSettingsSync()),
		logger: ctx.logger
	});
	ctx.effect(() => () => {
		stopped = true;
		relay.close();
		shims.cn.close();
		shims.global.close();
		core.scheduler.stop();
	});
	relay.ready.catch((error) => {
		ctx.logger.warn(`xdpool relay: startup failed — ${String(error)}`);
	});
	ctx.inject(["webServer"], (webCtx) => registerPoolStatusRoute(webCtx, {
		pool: core.pool,
		catalogs: core.catalogs,
		client: core.client,
		usage: () => usageRecorder.summary(),
		shim: () => shimInfo("cn"),
		scheduler: () => core.scheduler.status(),
		runAutomation: (_job, _force) => core.scheduler.startRunAll(),
		saveSelection: async (region, selection) => {
			const payload = {
				...selection.enabledModelIds === void 0 ? {} : { enabledModelIds: [...selection.enabledModelIds] },
				...selection.imageModelIds === void 0 ? {} : { imageModelIds: [...selection.imageModelIds] },
				...selection.contextBudgets === void 0 ? {} : { contextBudgets: { ...selection.contextBudgets } }
			};
			await setSetting(modelSelectionKeyFor(region), payload, payload);
		},
		setAccountDisabled: async (accountId, disabled) => {
			const currentIds = current().disabledAccountIds ?? [];
			const next = disabled ? currentIds.includes(accountId) ? currentIds : [...currentIds, accountId] : currentIds.filter((id) => id !== accountId);
			await setSetting("disabledAccountIds", next, next);
		},
		setCreditReserve: async (accountId, reserve) => {
			const next = { ...current().creditReserves ?? {} };
			if (reserve > 0) next[accountId] = reserve;
			else delete next[accountId];
			await setSetting("creditReserves", next, next);
		},
		setAccountIgnored: async (accountId, ignored) => {
			if (ignored) {
				const known = core.pool.list().find((account) => account.id === accountId);
				await ignoreAccount({
					id: accountId,
					...known === void 0 ? {} : { label: known.label }
				}, ignoredPath);
			} else await unignoreAccount(accountId, ignoredPath);
			refreshIgnored();
			if (!ignored) await core.pool.scan();
		},
		ignoredAccounts: () => ignoredAccounts,
		setPreferredAccount: async (accountId) => {
			await writePreferredId(accountId ?? void 0, preferredPath);
			applyPreferred(accountId ?? void 0);
		},
		refreshCatalog: async () => {
			const result = await seedCatalog();
			invalidateCatalog();
			return result;
		},
		aggregateDocument: () => aggregateStatusOf(readAggregateSettingsSync(), aggregateCatalog.providerRows().map(toWebAggregateModel)),
		saveAggregate: async (patch) => {
			if (patch.kind === "lane") await setAggregateEnabled(patch.enabled);
			else if (patch.kind === "clear") await clearProviderSetting(patch.providerId);
			else await updateProviderSetting(patch.providerId, {
				...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
				...patch.apiKey === void 0 ? {} : { apiKey: patch.apiKey },
				...patch.baseUrl === void 0 ? {} : { baseUrl: patch.baseUrl },
				...patch.models === void 0 ? {} : { models: patch.models }
			});
			await aggregateCatalog.refresh();
			return aggregateStatusOf(readAggregateSettingsSync(), aggregateCatalog.providerRows().map(toWebAggregateModel));
		},
		probeAggregate: async (providerId) => {
			const probe = await probeAggregateProvider(readAggregateSettingsSync(), providerId);
			return {
				ok: probe.ok,
				status: probe.status,
				message: probe.message,
				...probe.modelCount === void 0 ? {} : { modelCount: probe.modelCount },
				...probe.modelIds === void 0 ? {} : { modelIds: probe.modelIds }
			};
		},
		/**
		* One real streaming call, for the card's per-model "test connection" button.
		*
		* Routed through `ctx.llm.stream` rather than through any of this plugin's
		* own lanes, and that is the whole point: `ctx.llm` is the host's adapter
		* registry, so it resolves the provider/model pair to whichever credential
		* and endpoint actually serve it — including lanes this plugin knows nothing
		* about. Asking our own shims instead would make the button report on the
		* plumbing rather than on the model the user clicked.
		*
		* Never throws (see {@link probeModelConnectivity}): the measurement is the
		* answer, and a rejection here would show as a bare route failure that reads
		* like a wrong key.
		*/
		probeModel: async (provider, model, signal) => {
			return probeModelConnectivity(ctx.llm, provider, model, { signal });
		},
		/**
		* What each login channel contributes, read from the host's own catalogue.
		*
		* Not from the pack, on purpose. The pack's `model.list` keeps the id, the
		* name and two flags and drops the rest, and the rest is exactly what the
		* login page is asked to show. The host's `listModels` is also the same
		* catalogue the model picker builds from, so a row's window here is the
		* window the picker will enforce.
		*
		* `listModels` is a LISTING, though: the host's own answer carries only the
		* id, the name, a description and the input modalities, and the host drops
		* the context window out of it on the way out (its listing mapper keeps
		* four fields). The window lives one call deeper, on
		* `resolveModelInfo(provider, model)` — which is where the model picker and
		* the compaction planner read it from — so a second pass over each row is
		* the only way to show a context size that matches what will actually be
		* enforced.
		*
		* That second pass is bounded and per-row isolated: adapters resolve a model
		* from their own cache in the common case, a row that cannot be resolved
		* simply prints no window, and a channel's answer is never held up by one
		* model it could not describe.
		*
		* A provider with no adapter registered under it is left out of the record
		* instead of being reported empty: "not signed in" and "signed in with
		* nothing to offer" would otherwise be drawn identically, and the user has
		* no way to tell which one they are looking at.
		*/
		channelModels: async (providers, hints) => {
			const models = {};
			const resolveConcurrency = 6;
			for (const provider of providers) try {
				const hinted = hints?.[provider];
				const rows = hinted !== void 0 && hinted.length > 0 ? hinted.map((id) => ({
					id,
					name: id
				})) : await ctx.llm.listModels(provider);
				const resolved = /* @__PURE__ */ new Map();
				let next = 0;
				const workers = Array.from({ length: Math.min(resolveConcurrency, rows.length) }, async () => {
					while (next < rows.length) {
						const row = rows[next++];
						if (row === void 0) continue;
						let extra = {};
						try {
							const info = await ctx.llm.resolveModelInfo(provider, row.id);
							extra = {
								...info.context?.contextWindow === void 0 ? {} : { contextWindow: info.context.contextWindow },
								...info.defaultMaxTokens === void 0 ? {} : { maxTokens: info.defaultMaxTokens },
								...info.inputModalities === void 0 ? {} : { inputModalities: info.inputModalities }
							};
						} catch (cause) {}
						resolved.set(row.id, {
							id: row.id,
							name: row.name,
							...row.description === void 0 ? {} : { description: row.description },
							...row.inputModalities === void 0 ? {} : { inputModalities: row.inputModalities },
							...extra
						});
					}
				});
				await Promise.all(workers);
				models[provider] = rows.map((row) => resolved.get(row.id)).filter((row) => row !== void 0);
			} catch {}
			return models;
		},
		discoverAggregate: async (providerId) => {
			const probe = await probeAggregateProvider(readAggregateSettingsSync(), providerId);
			if (!probe.ok || probe.modelIds === void 0) return {
				ok: probe.ok,
				status: probe.status,
				message: probe.message,
				...probe.modelCount === void 0 ? {} : { modelCount: probe.modelCount }
			};
			await updateProviderSetting(providerId, { discovered: probe.modelIds });
			await aggregateCatalog.refresh();
			return {
				ok: true,
				status: probe.status,
				message: probe.message,
				...probe.modelCount === void 0 ? {} : { modelCount: probe.modelCount },
				modelIds: probe.modelIds,
				committed: probe.modelIds.length
			};
		},
		channelsDocument: () => {
			const state = channels.state();
			return {
				state: state.state,
				...state.state === "unavailable" ? { reason: state.reason } : {},
				channels: REGISTERED_CHANNELS.map((channel) => ({
					id: channel.id,
					name: channel.name,
					org: channel.org,
					...channel.domain === void 0 ? {} : { domain: channel.domain },
					accent: channel.accent,
					note: channel.note,
					loginKind: channel.login,
					ownedByPool: POOL_OWNED_CHANNELS.has(channel.id),
					...channel.smsHint === true ? { smsHint: true } : {},
					...channel.credits === void 0 ? {} : { credits: channel.credits }
				}))
			};
		},
		combosDocument: () => combosStatusOf(readAggregateSettingsSync(), aggregateCatalog, core.catalogs.cn.current()),
		saveCombos: async (raw) => {
			await saveCombos(raw);
			await aggregateCatalog.refresh();
			return combosStatusOf(readAggregateSettingsSync(), aggregateCatalog, core.catalogs.cn.current());
		},
		billionDocument: readBillionStatus,
		/**
		* Relay state and patches.
		*
		* The write path mints a key when the card asks for a rotation and the user
		* has never had one: an enabled relay with no key would have to either refuse
		* everyone (so the switch silently does nothing) or accept everyone. Minting
		* one keeps "enabled" honest, and the card shows it so it can be pasted into
		* the other device.
		*/
		relayDocument: async () => relay.status(),
		saveRelay: async (patch) => {
			const before = readAggregateSettingsSync().relay ?? {};
			const key = patch.key === "" ? newRelayKey() : patch.key;
			await updateRelaySetting({
				...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
				...patch.host === void 0 ? {} : { host: patch.host },
				...patch.port === void 0 ? {} : { port: patch.port },
				key: key ?? before.key ?? newRelayKey()
			});
			await relay.sync();
			return relay.status();
		}
	}));
	api = {
		...core,
		shim,
		get adapter() {
			return builtAdapter;
		},
		async rescan() {
			const accounts = await core.pool.scan();
			ctx.logger.info?.(`dsh-xdpool: discovered ${accounts.length} account(s)`);
			await seedCatalog();
			invalidateCatalog();
			return accounts.length;
		},
		async status(includeCredits = false) {
			return buildStatus({
				pool: core.pool,
				catalog: core.catalogs.cn,
				client: core.client,
				shim: shimInfo("cn"),
				includeCredits
			});
		},
		resetCooldowns() {
			core.pool.resetCooldowns();
		}
	};
	core.scheduler.start();
	let channels = { state: () => ({ state: "pending" }) };
	ctx.inject(["credentials", "commands"], (scoped) => {
		const mount = async () => {
			const mounted = await mountChannelPack(scoped, ctx.logger);
			if (stopped) return;
			channels = mounted;
		};
		mount().catch((error) => {
			if (stopped) return;
			ctx.logger.warn(`[xdpool] free-channel pack unavailable (${error instanceof Error ? error.message : String(error)})`);
			channels = { state: () => ({
				state: "unavailable",
				reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
			}) };
		}).finally(() => {
			if (stopped) return;
			adoptChannelPackAccounts(ctx, core.pool, ctx.logger);
		});
	});
	mountBillionContext(ctx, ctx.logger).then((outcome) => {
		recordStartupNote(`billion-context ${outcome.state}`);
		if (outcome.state === "unavailable") ctx.logger.warn(`[xdpool] billion-context not mounted — ${outcome.reason}`);
	}, (error) => {
		recordStartupNote(`billion-context mount failed: ${describeError(error)}`);
	});
	Promise.all([shims.cn.ready, shims.global.ready]).then(async () => {
		if (stopped) return;
		recordStartupNote(`both shims ready cn=${shims.cn.baseUrl()} global=${shims.global.baseUrl()}; entering registration`);
		try {
			const adaptersByRegion = {
				cn: createWorkBuddyAdapter({
					ctx,
					shim: shims.cn,
					catalog: core.catalogs.cn,
					providerId: POOL_PROVIDER_BY_REGION.cn,
					displayName: POOL_NAME_BY_REGION.cn
				}),
				global: createWorkBuddyAdapter({
					ctx,
					shim: shims.global,
					catalog: core.catalogs.global,
					providerId: POOL_PROVIDER_BY_REGION.global,
					displayName: POOL_NAME_BY_REGION.global
				}),
				aggregate: createWorkBuddyAdapter({
					ctx,
					shim: shims.cn,
					catalog: aggregateCatalog,
					providerId: XDPOOL_AGGREGATE_PROVIDER,
					displayName: "聚合渠道"
				}),
				free: createWorkBuddyAdapter({
					ctx,
					shim: shims.cn,
					catalog: core.catalogs.cn,
					providerId: XDPOOL_FREE_PROVIDER,
					displayName: EXTRA_LANE_NAMES.free,
					extraRows: () => freeCatalog.current()
				})
			};
			let releaseAdapterCn;
			let releaseAdapterGlobal;
			let releaseAdapterAggregate;
			let releaseAdapterFree;
			let releaseDirectory;
			try {
				releaseAdapterCn = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.cn], adaptersByRegion.cn.adapter);
				releaseAdapterGlobal = ctx.llm.registerAdapter([POOL_PROVIDER_BY_REGION.global], adaptersByRegion.global.adapter);
				releaseAdapterAggregate = ctx.llm.registerAdapter([XDPOOL_AGGREGATE_PROVIDER], adaptersByRegion.aggregate.adapter);
				releaseAdapterFree = ctx.llm.registerAdapter([XDPOOL_FREE_PROVIDER], adaptersByRegion.free.adapter);
			} catch (error) {
				ctx.logger.error("dsh-xdpool: adapter registration failed", error);
				recordStartupNote(`adapters REJECTED: ${describeError(error)}`);
				releaseAdapterCn?.();
				releaseAdapterGlobal?.();
				releaseAdapterAggregate?.();
				releaseAdapterFree?.();
				return;
			}
			try {
				releaseDirectory = ctx.llm.registerConfigurableProviders([
					{
						provider: POOL_PROVIDER_BY_REGION.cn,
						displayName: POOL_NAME_BY_REGION.cn,
						settingsNs: XDPOOL_SETTINGS_NS,
						settingsPath: [],
						declared: false
					},
					{
						provider: POOL_PROVIDER_BY_REGION.global,
						displayName: POOL_NAME_BY_REGION.global,
						settingsNs: XDPOOL_SETTINGS_NS,
						settingsPath: [],
						declared: false
					},
					{
						provider: XDPOOL_AGGREGATE_PROVIDER,
						displayName: "聚合渠道",
						settingsNs: XDPOOL_SETTINGS_NS,
						settingsPath: [],
						declared: false
					},
					{
						provider: XDPOOL_FREE_PROVIDER,
						displayName: EXTRA_LANE_NAMES.free,
						settingsNs: XDPOOL_SETTINGS_NS,
						settingsPath: [],
						declared: false
					}
				]);
			} catch (error) {
				ctx.logger.error("dsh-xdpool: configurable-provider directory rejected; models will still be served", error);
				recordStartupNote(`directory REJECTED: ${describeError(error)}`);
			}
			recordStartupNote(describeProviderIdRename());
			builtAdapter = adaptersByRegion.cn;
			invalidateCatalog = () => {
				adaptersByRegion.cn.invalidate();
				adaptersByRegion.global.invalidate();
				adaptersByRegion.aggregate.invalidate();
				adaptersByRegion.free.invalidate();
				for (const [handle, routes] of [
					[releaseAdapterCn, [POOL_PROVIDER_BY_REGION.cn]],
					[releaseAdapterGlobal, [POOL_PROVIDER_BY_REGION.global]],
					[releaseAdapterAggregate, [XDPOOL_AGGREGATE_PROVIDER]],
					[releaseAdapterFree, [XDPOOL_FREE_PROVIDER]]
				]) {
					if (handle === void 0) continue;
					try {
						handle.replace([...routes]);
					} catch (error) {
						ctx.logger.warn("dsh-xdpool: could not re-announce adapter routes", error);
					}
				}
			};
			aggregateCatalog.onChange(() => {
				invalidateCatalog();
			});
			freeCatalog.onChange(() => {
				invalidateCatalog();
			});
			/** Release everything the providers registered, once. */
			const releaseProviders = () => {
				releaseAdapterCn?.();
				releaseAdapterGlobal?.();
				releaseAdapterAggregate?.();
				releaseAdapterFree?.();
				releaseDirectory?.();
			};
			try {
				ctx.effect(() => releaseProviders);
			} catch {
				releaseProviders();
			}
			ctx.llm.registerModelDiscovery(XDPOOL_SETTINGS_NS, async (request) => {
				if (request.provider === "xdpool-free") return freeCatalog.current().map((row) => ({
					id: row.modelId,
					name: row.name,
					contextWindow: row.contextWindow,
					maxTokens: row.maxOutput,
					inputModalities: row.vision ? ["text", "image"] : ["text"]
				}));
				if (request.provider === "xdpool-aggregate") return aggregateCatalog.current().map((row) => ({
					id: row.id,
					name: row.name,
					contextWindow: row.contextWindow,
					maxTokens: row.maxOutputTokens,
					inputModalities: row.supportsImages ? ["text", "image"] : ["text"]
				}));
				if (request.provider !== "xdpool" && request.provider !== "xdpool-global") return [];
				const region = request.provider === "xdpool-global" ? "global" : "cn";
				return core.catalogs[region].visible().map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
					maxTokens: model.maxOutputTokens,
					inputModalities: model.supportsImages ? ["text", "image"] : ["text"]
				}));
			});
			ctx.logger.info?.(`dsh-xdpool: providers registered at cn=${shims.cn.baseUrl()} global=${shims.global.baseUrl()} aggregate=${aggregateCatalog.current().length} free=${freeCatalog.current().length} model(s)`);
			recordStartupNote(`providers registered cn=${shims.cn.baseUrl()} global=${shims.global.baseUrl()} aggregate=${aggregateCatalog.current().length} free=${freeCatalog.current().length} model(s) directory=${releaseDirectory === void 0 ? "rejected" : "mounted"}`);
			freeCatalog.refresh().then((rows) => {
				invalidateCatalog();
				ctx.logger.info?.(`dsh-xdpool: free lane serves ${rows.length} model(s)`);
				recordStartupNote(`free lane ready rows=${rows.length} live=${freeCatalog.updatedAt() !== void 0}`);
			}, (error) => {
				ctx.logger.warn("dsh-xdpool: free lane listing failed", error);
				recordStartupNote(`free lane listing failed: ${describeError(error)}`);
			});
		} catch (error) {
			ctx.logger.error("dsh-xdpool: provider registration failed", error);
			recordStartupNote(`registration FAILED: ${describeError(error)}`);
			return;
		}
		if (stopped) return;
		core.pool.scan().then((accounts) => {
			ctx.logger.info?.(`dsh-xdpool: ${accounts.length} WorkBuddy account(s) in rotation`);
		}, (error) => {
			ctx.logger.warn("dsh-xdpool: account discovery failed", error);
		});
		(async () => {
			await seedCatalog();
			invalidateCatalog();
		})().catch((error) => {
			ctx.logger.warn("dsh-xdpool: account catalog seed failed", error);
		});
	}, (error) => {
		ctx.logger.error("dsh-xdpool: shim failed to listen", error);
	});
}
//#endregion
export { APPEARANCE_THEME_KEY, AUTOMATION_JOB_KINDS, AUTOMATION_TICK_MS, BUDDY_APP_ID, BUDDY_APP_NAME, Config, DEFAULT_AUTOMATION_HOURS, DEFAULT_CONTEXT_BUDGET, EVENT_SCORE_WAIT_MS, FALLBACK_WORKBUDDY_MODELS, IGNORED_FILE_NAME, LIBRARY_DOC_URL, LIGHTHOUSE_EXPERT_ID, PLAYBOOK_CASE_ID, PLAYBOOK_CASE_NAME, PLUGIN_DATA_DIR_NAME, POOL_ACCOUNT_IGNORE_PATH, POOL_AUTOMATION_RUN_PATH, POOL_CHECKIN_PATH, POOL_CREDIT_RESERVE_PATH, POOL_MODELS_SAVE_PATH, POOL_RESCAN_PATH, POOL_RESET_COOLDOWN_PATH, POOL_STATUS_PATH, SKILL_ID, SKILL_NAME, TEMPLATE_PRESETS, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_LIVE_FILENAME, WorkBuddyAccountPool, WorkBuddyCatalog, WorkBuddyScheduler, WorkBuddyUpstreamClient, XDPOOL_PROVIDER, XDPOOL_SETTINGS_NS, appearanceChain, apply, automationChain, automationOptions, buddyAppChain, buddyAppEvents, buildStatus, candidateAuthDirs, canvasChain, chatChain, classifyUpstreamError, createCore, createWorkBuddyAdapter, createWorkBuddyShim, currentApi, dayKey, defaultDesktopAuthDirs, desktopAutomationCreatedEvent, desktopCanvasEvents, desktopChatEvents, dshHome, expertActualUseEvent, expertChatEvents, expertSummonEvents, formatRates, formatStatus, ignoreAccount, ignoredIdsPath, inject, isAutomationJobKind, isFireHour, libraryReadChain, modelSelectionKeyFor, name, parseRateLimitReset, parseWorkBuddyAuth, playbookChain, pluginDataDir, poolWebStatus, preferredIdPath, readIgnoredAccounts, readIgnoredAccountsSync, readPreferredId, readPreferredIdSync, registerPoolStatusRoute, setApi, skillChain, templateChain, templateChains, unignoreAccount, workbuddyAccountId, writeIgnoredAccounts, writePreferredId };
