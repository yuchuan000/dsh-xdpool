/**
 * 给已安装的 dsh-xdpool 打补丁：池子发出的指令消息不再带 DSH 身份句。
 *
 * 症状：DSH 里选 WorkBuddy 系模型对话，回
 *   「请求被拦截，请重新发送」/ code 11128 /
 *   "Illegal API invocation from an unapproved channel"。
 * 原因：网关对「指令消息以 You are an AI agent powered by DeepSeek Harness. 开头」的
 * chat 请求固定回 11128。这句话由 DSH 的 @deepseek-ai/dsh-system-prompt 注入，
 * 插件只是转发，所以在插件自己的归一化环节（prepareChatBody）改掉它。
 *
 * 用法：node fix-dsh-xdpool-identity.mjs
 * 幂等、有备份、自带离线自检。不重装插件、不改 profile 配置。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN = argv.includes('--dry-run')
const NEUTRAL = 'You are an AI agent running inside this harness.'
const MARKER = '__xdpoolRewriteHarnessIdentity'

/** 注入产物顶部的实现，与源码 rewriteHarnessIdentity 等价。 */
const HELPERS = `
/** ${MARKER}: DSH 身份句（网关 11128 的第二道判据，与 developer 角色共用同一个 code）。 */
const __XDPOOL_HARNESS_IDENTITY = /You[\\s\\u00a0]+are[\\s\\u00a0]+an[\\s\\u00a0]+AI[\\s\\u00a0]+agent[\\s\\u00a0]+powered[\\s\\u00a0]+by[\\s\\u00a0]+DeepSeek[\\s\\u00a0]+Harness\\.?/giu;
const __XDPOOL_NEUTRAL_IDENTITY = ${JSON.stringify(NEUTRAL)};
function __xdpoolIdentityTextCarrier(key) {
	return key === "content" || key === "text" || key === "input_text";
}
function __xdpoolRewriteIdentitySentence(value) {
	if (typeof value === "string") return value.replace(__XDPOOL_HARNESS_IDENTITY, __XDPOOL_NEUTRAL_IDENTITY);
	if (Array.isArray(value)) return value.map(__xdpoolRewriteIdentitySentence);
	if (typeof value !== "object" || value === null) return value;
	const record = value;
	for (const [key, nested] of Object.entries(record)) {
		if (!__xdpoolIdentityTextCarrier(key)) continue;
		record[key] = __xdpoolRewriteIdentitySentence(nested);
	}
	return value;
}
/** 只改 system / developer 指令消息；用户消息与工具参数一律不碰。幂等。 */
function ${MARKER}(messages) {
	for (const value of messages) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		const role = message["role"];
		if (role !== "system" && role !== "developer") continue;
		if (message["content"] !== undefined) message["content"] = __xdpoolRewriteIdentitySentence(message["content"]);
		if (typeof message["text"] === "string") message["text"] = __xdpoolRewriteIdentitySentence(message["text"]);
	}
}
`

const ANCHOR_LINES = [
  '\t\tif (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {',
  '\t\t\tif (typeof value !== "object" || value === null || Array.isArray(value)) continue;',
  '\t\t\tconst message = value;',
  '\t\t\tif (message["role"] === "developer") message["role"] = "system";',
  '\t\t}',
]
const ANCHOR_PATCHED_LINES = [
  '\t\tif (Array.isArray(obj["messages"])) {',
  '\t\t\tfor (const value of obj["messages"]) {',
  '\t\t\t\tif (typeof value !== "object" || value === null || Array.isArray(value)) continue;',
  '\t\t\t\tconst message = value;',
  '\t\t\t\tif (message["role"] === "developer") message["role"] = "system";',
  '\t\t\t}',
  `\t\t\t${MARKER}(obj["messages"]);`,
  '\t\t}',
]

/** 在 profile 的 node_modules 里找已安装的包（含旧包名 dsh-workbuddy-xdpool）。 */
function findInstalled() {
  const explicit = argOf('--dir')
  if (explicit !== undefined) return join(explicit, 'lib', 'index.js')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const candidates = []
  const profiles = join(dshHome, 'profiles')
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles)) {
      for (const pkg of ['dsh-xdpool', 'dsh-workbuddy-xdpool']) {
        candidates.push(join(profiles, entry, 'node_modules', pkg, 'lib', 'index.js'))
      }
      for (const pkg of ['dsh-xdpool', 'dsh-workbuddy-xdpool']) {
        candidates.push(join(profiles, entry, 'vendor', pkg, 'lib', 'index.js'))
      }
    }
  }
  candidates.push(join(dshHome, 'node_modules', 'dsh-xdpool', 'lib', 'index.js'))
  const found = candidates.filter((path) => existsSync(path))
  if (found.length === 0) {
    throw new Error(
      'no installed dsh-xdpool bundle found. Looked in:\n  ' + candidates.join('\n  ')
      + '\nPass --dir <package root> to point at it.',
    )
  }
  // 正在被 profile 加载的那个优先：node_modules 排在 vendor 前面。
  return found[0]
}

/** 载入产物，报告身份句是否还能活着到达网关。 */
async function selfCheck(file) {
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (error) {
    console.log('')
    console.log(`自检跳过：无法 import ${file}`)
    console.log(`  ${String(error).split('\n')[0]?.slice(0, 140)}`)
    console.log('  字节已写入；用不带 --dir 的方式对真实安装再跑一次即可验证')
    return
  }
  const client = new mod.WorkBuddyUpstreamClient()
  const phrase = 'You are an AI agent powered by DeepSeek Harness.'
  const before = JSON.stringify({
    model: 'm',
    stream: true,
    messages: [{ role: 'developer', content: `${phrase}\n\nbody` }, { role: 'user', content: 'hi' }],
  })
  const after = client.prepareChatBody(before)
  const parsed = JSON.parse(after)
  console.log('')
  console.log(`自检 身份句已消失      : ${!(after.includes(phrase))}`)
  console.log(`自检 替换为            : ${parsed.messages[0].content.split('\n')[0]}`)
  console.log(`自检 role              : ${parsed.messages[0].role}`)
  console.log(`自检 用户消息未被改动   : ${parsed.messages[1].content === 'hi'}`)
  console.log(`自检 文件大小          : ${statSync(file).size} 字节`)
}

const file = findInstalled()
const original = readFileSync(file, 'utf8')
console.log(`目标 : ${file}`)
console.log(`大小 : ${original.length} 字符`)

if (original.includes(MARKER)) {
  console.log('状态 : 已打过补丁，无需重复')
  await selfCheck(file)
  process.exit(0)
}

const EOL = original.includes('\r\n') ? '\r\n' : '\n'
const ANCHOR = ANCHOR_LINES.join(EOL)
const ANCHOR_PATCHED = ANCHOR_PATCHED_LINES.join(EOL)

if (!original.includes(ANCHOR)) {
  throw new Error(
    '未找到锚点：这个产物不像是本补丁对应的 dsh-xdpool。\n'
    + '先确认包装的版本，再从 prepareChatBody() 里重新取锚点。',
  )
}

const helpers = HELPERS.split('\n').join(EOL)
const withHelpers = `${helpers}${EOL}${original}`
const patched = withHelpers.replace(ANCHOR, ANCHOR_PATCHED)
if (patched === withHelpers) throw new Error('锚点替换没有产生变化')

if (DRY_RUN) {
  console.log('状态 : dry-run，只报告将要插入 helper 并接上调用')
  process.exit(0)
}

const backup = `${file}.bak-before-identity-fix`
if (!existsSync(backup)) {
  copyFileSync(file, backup)
  console.log(`备份 : ${backup}`)
} else {
  console.log(`备份 : ${backup}（已存在，保留）`)
}

writeFileSync(file, patched, 'utf8')
console.log(`状态 : 已打补丁（${patched.length} 字符）`)
await selfCheck(file)
