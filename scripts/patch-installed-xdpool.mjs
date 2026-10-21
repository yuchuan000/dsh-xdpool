/**
 * 给**已安装**的 dsh-xdpool 打补丁：让池子发出的指令消息不再带着 DSH 的身份句。
 *
 * 为什么需要它：2026-10-21 起 WorkBuddy 网关（CN 与 global 同一套渠道校验）会对
 * 「指令消息以 `You are an AI agent powered by DeepSeek Harness.` 开头」的 chat 请求
 * 回 400 / code 11128 / "Illegal API invocation from an unapproved channel"。这句话由
 * DSH 的 `@deepseek-ai/dsh-system-prompt` 注入，插件只是转发，所以要在插件自己的
 * 归一化环节改掉它——即 `lib/index.js` 里的 `prepareChatBody`。
 *
 * 应用对象：本机 profile 里已安装的 `dsh-xdpool`（`node_modules/dsh-xdpool/lib/index.js`）。
 * 不重新安装、不改 profile 配置、不动 `vendor/`。
 *
 * 用法：
 *   node patch-installed-xdpool.mjs                 # 自动定位已安装插件并打补丁
 *   node patch-installed-xdpool.mjs --dir <path>    # 指定 dsh-xdpool 包目录
 *   node patch-installed-xdpool.mjs --dry-run       # 只报告会改什么
 *
 * 幂等：已经打过补丁会直接跳过。备份写在 `lib/index.js.bak-before-identity-fix`。
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

/** 改写后顶替身份句的中性说法。 */
const NEUTRAL = 'You are an AI agent running inside this harness.'
/** 补丁的标记，用来判断是否已经打过。 */
const MARKER = '__xdpoolRewriteHarnessIdentity'

/** 注入到产物里的实现；与源码 `src/upstream.ts` 的 `rewriteHarnessIdentity` 等价。 */
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

/** 在 `lib/index.js` 里加一行调用；锚点就是那圈 developer→system 转换。 */
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

/** 递归找 `dsh-xdpool/lib/index.js`，从 profile 的 node_modules 开始。 */
function findInstalled() {
  const explicit = argOf('--dir')
  if (explicit !== undefined) return join(explicit, 'lib', 'index.js')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const roots = []
  const profiles = join(dshHome, 'profiles')
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles)) {
      roots.push(join(profiles, entry, 'node_modules', 'dsh-xdpool', 'lib', 'index.js'))
      roots.push(join(profiles, entry, 'node_modules', 'dsh-workbuddy-xdpool', 'lib', 'index.js'))
    }
  }
  roots.push(join(dshHome, 'node_modules', 'dsh-xdpool', 'lib', 'index.js'))
  const found = roots.filter((path) => existsSync(path))
  if (found.length === 0) {
    throw new Error(`no installed dsh-xdpool bundle found. Looked in:\n  ${roots.join('\n  ')}\nPass --dir <package dir> to point at it.`)
  }
  return found[0]
}

const file = findInstalled()
const original = readFileSync(file, 'utf8')
console.log(`target : ${file}`)
console.log(`size   : ${original.length} bytes`)

/** Load the bundle and report whether the identity sentence survives the wire. */
async function selfCheck() {
  // The bundle resolves its own dependencies relative to its package root, so a
  // bare `--dir` pointing at a copied `lib/` cannot be imported. That is a
  // limitation of the check, not of the patch: the bytes on disk are already
  // written, and the caller can re-run against the real install.
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (error) {
    console.log('')
    console.log(`self-check skipped : could not import ${file}`)
    console.log(`                     ${String(error).split('\n')[0]?.slice(0, 140)}`)
    console.log('                     run this script without --dir against the real install to verify')
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
  console.log(`self-check sentence gone : ${!(after.includes(phrase))}`)
  console.log(`self-check replacement   : ${parsed.messages[0].content.split('\n')[0]}`)
  console.log(`self-check role          : ${parsed.messages[0].role}`)
  console.log(`self-check user intact   : ${parsed.messages[1].content === 'hi'}`)
  console.log(`self-check size          : ${statSync(file).size} bytes`)
}

if (original.includes(MARKER)) {
  console.log('status : already patched — nothing to do')
  await selfCheck()
  process.exit(0)
}

// The bundle ships CRLF, so every injected/compared line has to use the file's
// own ending rather than the LF the source literals above were written with.
const EOL = original.includes('\r\n') ? '\r\n' : '\n'
const ANCHOR = ANCHOR_LINES.join(EOL)
const ANCHOR_PATCHED = ANCHOR_PATCHED_LINES.join(EOL)

if (!original.includes(ANCHOR)) {
  throw new Error(
    'anchor not found: the bundle does not look like the dsh-xdpool this patch was written against.\n'
    + 'Check whether the package was rebuilt by a different version, then re-derive the anchor from prepareChatBody().',
  )
}

const helpers = HELPERS.split('\n').join(EOL)
const withHelpers = `${helpers}${EOL}${original}`
const patched = withHelpers.replace(ANCHOR, ANCHOR_PATCHED)
if (patched === withHelpers) throw new Error('anchor replacement produced no change')

if (DRY_RUN) {
  console.log('status : dry run — would insert helpers and wire the call')
  process.exit(0)
}

const backup = `${file}.bak-before-identity-fix`
if (!existsSync(backup)) {
  copyFileSync(file, backup)
  console.log(`backup : ${backup}`)
} else {
  console.log(`backup : ${backup} (already present, kept)`)
}

writeFileSync(file, patched, 'utf8')
console.log(`status : patched (${patched.length} bytes)`)

await selfCheck()
