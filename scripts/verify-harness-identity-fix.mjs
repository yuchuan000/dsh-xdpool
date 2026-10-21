/**
 * xdpool 修复的真机验证：改写后的 body 走真实 CN 网关。
 *
 * 用一个最小 shim 无关路径——直接取一个可用账号的凭据，构造与 DSH 同形态的报文，
 * 经 `WorkBuddyUpstreamClient.prepareChatBody` 归一化后发出。对照组是同一份未
 * 归一化的报文，应当仍被 11128 拦下。
 *
 * 用法：
 *   node scripts/verify-harness-identity-fix.mjs [model]
 *   WORKBUDDY_AUTH_FILE=<info 文件路径> node scripts/verify-harness-identity-fix.mjs
 *
 * 凭据来源与环境变量拼写沿用插件本体（`WORKBUDDY_AUTH_FILE` / 桌面 App 的
 * `CodeBuddyExtension` 目录），不假定任何插件私有目录：那个布局属于具体安装，
 * 写死进公开脚本会让别人的机器直接找不到凭据。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkBuddyUpstreamClient } from '../lib/index.js'

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash'
const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'

/** 桌面 App 写凭据的目录，各安装位置按序探测（Windows 有 Local / Roaming 两处）。 */
function authDirs() {
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return [
    join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    join(appData, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    '/Applications/WorkBuddy.app/Contents/Resources/auth',
  ].filter((dir) => dir !== '' && existsSync(dir))
}

/** 读出第一份未过期的凭据文档，或给出可执行的下一步提示。 */
function credential() {
  const explicit = process.env.WORKBUDDY_AUTH_FILE
  const candidates = []
  if (explicit !== undefined && explicit !== '') {
    candidates.push(explicit)
  } else {
    for (const dir of authDirs()) {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.info') || file.endsWith('.json')) candidates.push(join(dir, file))
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      'no WorkBuddy credential document found.\n'
      + 'Set WORKBUDDY_AUTH_FILE to the desktop app\'s auth .info file, e.g.\n'
      + '  WORKBUDDY_AUTH_FILE="%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info"',
    )
  }
  const nowSec = Math.floor(Date.now() / 1000)
  for (const file of candidates) {
    let doc
    try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    const token = doc?.auth?.accessToken
    if (typeof token !== 'string' || token === '') continue
    let exp
    try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp } catch { continue }
    if (typeof exp === 'number' && exp <= nowSec) continue
    return {
      accessToken: token,
      refreshToken: doc?.auth?.refreshToken ?? '',
      expiresAt: doc?.auth?.expiresAt ?? exp,
      refreshExpiresAt: doc?.auth?.refreshExpiresAt,
      domain: doc?.auth?.domain ?? 'www.workbuddy.cn',
      uid: doc?.account?.uid ?? '',
      uin: doc?.account?.uin,
      nickname: doc?.account?.nickname,
      source: 'dsh',
    }
  }
  throw new Error(`no unexpired credential in ${candidates.length} candidate document(s)`)
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
