/**
 * xdpool 修复的真机验证：改写后的 body 走真实 CN 网关。
 *
 * 用一个最小 shim 无关路径——直接取池里第一个可用账号的凭据，构造与 DSH 同形态的
 * 报文，经 `WorkBuddyUpstreamClient.prepareChatBody` 归一化后发出。对照组是同一份
 * 未归一化的报文，应当仍被 11128 拦下。
 *
 * 用法：node scripts/verify-harness-identity-fix.mjs [model]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkBuddyUpstreamClient } from '../lib/index.js'

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash'
const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'

function credential() {
  const vault = join(homedir(), '.dsh', 'workbuddy-vault', 'cn')
  if (!existsSync(vault)) throw new Error(`no vault at ${vault}`)
  const nowSec = Math.floor(Date.now() / 1000)
  for (const file of readdirSync(vault).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(vault, file), 'utf8'))
    const token = doc?.auth?.accessToken
    if (typeof token !== 'string') continue
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    if (typeof payload.exp === 'number' && payload.exp <= nowSec) continue
    return {
      accessToken: token,
      refreshToken: doc?.auth?.refreshToken ?? '',
      expiresAt: doc?.auth?.expiresAt ?? payload.exp,
      refreshExpiresAt: doc?.auth?.refreshExpiresAt,
      domain: doc?.auth?.domain ?? 'www.workbuddy.cn',
      uid: doc?.account?.uid ?? '',
      uin: doc?.account?.uin,
      nickname: doc?.account?.nickname,
      source: 'dsh',
    }
  }
  throw new Error('no unexpired credential in the vault')
}

const PROMPT = `${PHRASE}\n\n`
  + 'You are operating in a workspace and may call tools.\n\n'
  + '<available_skills>\n- humanizer: rewrite AI-sounding text\n</available_skills>'

const raw = JSON.stringify({
  model: MODEL,
  stream: true,
  messages: [
    { role: 'developer', content: PROMPT },
    { role: 'user', content: 'Reply with the single word: ok' },
  ],
  max_tokens: 8,
})

const client = new WorkBuddyUpstreamClient()
const prepared = client.prepareChatBody(raw)
const cred = credential()

console.log(`account       : ${cred.nickname ?? '(unnamed)'}  model=${MODEL}`)
console.log(`raw carries   : ${raw.includes(PHRASE)}`)
console.log(`prepared carries: ${prepared.includes(PHRASE)}`)
console.log(`raw role[0]   : ${JSON.parse(raw).messages[0].role}`)
console.log(`prepared role[0]: ${JSON.parse(prepared).messages[0].role}`)
console.log('')

/**
 * The chat-completion headers this pool sends, reproduced from
 * `chatCompletionHeaders` (which the bundle keeps internal). Field-for-field the
 * same shape the pool's real requests carry, so a pass here is a pass on the
 * pool's own wire.
 */
function chatHeaders(cred) {
  const origin = cred.domain === '' || !cred.domain.includes('workbuddy.ai')
    ? 'https://www.codebuddy.cn'
    : 'https://www.workbuddy.ai'
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cred.accessToken}`,
    'X-User-Id': cred.uid,
    'X-No-Enterprise-Id': '1',
    'X-Domain': cred.domain,
    'X-Product': 'SaaS',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'acp-connection-id': randomUUID(),
    'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Private-Data': 'true',
    'x-codebuddy-request': '1',
  }
}

const headers = chatHeaders(cred)

async function send(label, body) {
  const response = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let detail = ''
  try {
    const parsed = JSON.parse(text)
    detail = `code=${parsed.code} ${parsed.msg}`
  } catch {
    detail = `streamed bytes=${text.length}`
  }
  console.log(`${label.padEnd(26)} http=${response.status}  ${detail}`)
}

await send('prepared (fixed)', prepared)
await send('raw (control)', raw)
