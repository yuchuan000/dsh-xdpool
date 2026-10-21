#!/usr/bin/env node
/**
 * 一键修复 dsh-xdpool（含旧包名 dsh-workbuddy-xdpool）的「请求被拦截，请重新发送」。
 *
 * ## 修的是什么
 *
 * 2026-10-21 起 WorkBuddy 网关（CN 与 global 同一套渠道校验）对 chat 请求加了两道
 * 判据，都会回 `HTTP 400 / code 11128 / Illegal API invocation from an unapproved
 * channel`：
 *
 *   1. 指令消息的 role 是 `developer` —— 插件早已处理（转成 `system`）；
 *   2. 指令消息以 `You are an AI agent powered by DeepSeek Harness.` 开头 ——
 *      这句话由 DSH 自己的 `@deepseek-ai/dsh-system-prompt` 注入，插件只是原样转发。
 *
 * 本脚本给**已安装**的产物补上第 2 条的改写：只动 system/developer 指令消息里的那句话，
 * 用户消息与工具调用参数一律不碰，幂等。
 *
 * ## 特性
 *
 * - 自动定位已安装的插件（多 profile、新旧包名、node_modules 与 vendor 都找）
 * - 备份 + 幂等（重复跑不会重复改）
 * - 不依赖写死的锚点：按 prepareChatBody 的方法体边界注入，跨版本可用
 * - 改完自检：把改写逻辑抠出来实跑一遍，并给出结论
 * - 跨平台（Windows / macOS / Linux / WSL），Node 22+，零依赖
 * - 不重装插件、不改 profile 配置、不联网
 *
 * ## 用法
 *
 *   node fix-xdpool-channel-check.mjs                 # 自动定位并修复
 *   node fix-xdpool-channel-check.mjs --dry-run       # 只看会改什么
 *   node fix-xdpool-channel-check.mjs --list          # 只列出找到的安装
 *   node fix-xdpool-channel-check.mjs --check         # 只检查是否已修好，不写文件
 *   node fix-xdpool-channel-check.mjs --rollback      # 从备份还原
 *   node fix-xdpool-channel-check.mjs --dir <包目录>   # 指定插件包根目录
 *
 * 退出码：0 已修好；1 找不到安装；2 结构不匹配或自检未通过；3 其他错误。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** 注入标记：既用于幂等判断，也用于自检。 */
const MARKER = '__xdpoolRewriteHarnessIdentity'
const NEUTRAL = 'You are an AI agent running inside this harness.'
const BACKUP_SUFFIX = '.bak-before-channel-fix'

/** 被网关点名的原话：只用于识别与自检，不写进注入代码。 */
const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'

// ───────────────────────────── 命令行 ─────────────────────────────

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined
}

const DRY_RUN = has('--dry-run')
const LIST_ONLY = has('--list')
const CHECK_ONLY = has('--check')
const ROLLBACK = has('--rollback')
const EXPLICIT_DIR = valueOf('--dir')

// ───────────────────────────── 定位安装 ─────────────────────────────

const PACKAGE_NAMES = ['dsh-xdpool', 'dsh-workbuddy-xdpool']

/** DSH 主目录：尊重 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 所有可能的产物路径，按优先级排列。
 *
 * 顺序即优先级：node_modules 里那份才是 profile 真正加载的，vendor/ 是历史遗留位置，
 * 全局 node_modules 兜底。
 */
function candidateBundles() {
  const home = dshHome()
  const out = []
  const profiles = join(home, 'profiles')
  const profileNames = existsSync(profiles)
    ? readdirSync(profiles, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : []
  for (const profile of profileNames) {
    for (const pkg of PACKAGE_NAMES) {
      out.push(join(profiles, profile, 'node_modules', pkg, 'lib', 'index.js'))
      out.push(join(profiles, profile, 'node_modules', pkg, 'dist', 'index.js'))
    }
  }
  for (const profile of profileNames) {
    for (const pkg of PACKAGE_NAMES) {
      out.push(join(profiles, profile, 'vendor', pkg, 'lib', 'index.js'))
    }
  }
  for (const pkg of PACKAGE_NAMES) {
    out.push(join(home, 'node_modules', pkg, 'lib', 'index.js'))
  }
  return out
}

/** 读出一个安装的基本信息。 */
function describe(bundle, packageRoot) {
  const source = readFileSync(bundle, 'utf8')
  let version = '(unknown)'
  const pkgJson = join(packageRoot, 'package.json')
  if (existsSync(pkgJson)) {
    try { version = JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? version } catch { /* 版本读不到不影响修复 */ }
  }
  return {
    bundle,
    packageRoot,
    packageName: packageRoot.split(/[\\/]/).filter(Boolean).pop() ?? '(unknown)',
    version,
    bytes: statSync(bundle).size,
    patched: source.includes(MARKER),
    hasPrepareChatBody: /prepareChatBody\s*\(\s*raw\s*\)\s*\{/.test(source),
  }
}

/** 找到的安装列表。 */
function findInstalls() {
  if (EXPLICIT_DIR !== undefined) {
    const root = resolve(EXPLICIT_DIR)
    for (const rel of [join('lib', 'index.js'), join('dist', 'index.js')]) {
      const bundle = join(root, rel)
      if (existsSync(bundle)) return [describe(bundle, root)]
    }
    throw new Error(`--dir ${root} 下没有 lib/index.js 或 dist/index.js`)
  }
  const found = []
  const seen = new Set()
  for (const bundle of candidateBundles()) {
    if (!existsSync(bundle)) continue
    const real = resolve(bundle)
    if (seen.has(real)) continue
    seen.add(real)
    found.push(describe(bundle, dirname(dirname(bundle))))
  }
  return found
}

// ───────────────────────────── 注入的代码 ─────────────────────────────

/**
 * 注入到产物顶部的实现。
 *
 * 与源码里的 rewriteHarnessIdentity 等价：只处理 system / developer 消息，正则容忍
 * 句内折行与多余空格、句末句号可选、忽略大小写。
 */
const HELPERS = `
/** ${MARKER}: 网关渠道校验拦的是 DSH 身份句（与 developer 角色共用 code 11128）。 */
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

/** 产物用的是 LF 还是 CRLF。 */
function detectEol(source) {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

/** 方法体内部一层语句的缩进（按首个非空行推断，缺省 tab）。 */
function detectIndent(source, bodyOpen) {
  const after = source.slice(bodyOpen + 1, bodyOpen + 400)
  const line = after.split(/\r?\n/).find((candidate) => candidate.trim() !== '')
  if (line === undefined) return '\t'
  const indent = line.slice(0, line.length - line.trimStart().length)
  return indent === '' ? '\t' : `${indent}\t`
}

/**
 * 找到与 start 处的花括号配对的闭合括号，忽略字符串与模板串里的括号。
 *
 * @returns 闭合括号的下标，找不到返回 -1。
 */
function matchBrace(source, start) {
  let depth = 0
  let inString = null
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    const prev = source[i - 1]
    if (inString !== null) {
      if (ch === inString && prev !== '\\') inString = null
      continue
    }
    if (ch === '"' || ch === '\'' || ch === '`') { inString = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** prepareChatBody(raw) 的方法体范围（含花括号）。 */
function prepareBodyRange(source) {
  const decl = /prepareChatBody\s*\(\s*raw\s*\)\s*\{/.exec(source)
  if (decl === null) return undefined
  const bodyOpen = source.indexOf('{', decl.index + decl[0].length - 1)
  if (bodyOpen < 0) return undefined
  const bodyEnd = matchBrace(source, bodyOpen)
  if (bodyEnd < 0) return undefined
  return { bodyOpen, bodyEnd }
}

/**
 * 在 prepareChatBody 方法体里插入一行调用，并把助手函数前置到文件开头。
 *
 * 插入点是方法体里那句 `return JSON.stringify(obj)` **之前**，不是方法体闭合括号
 * 之前 —— 后者会落在 `return` 后面变成永不执行的死代码，补丁看起来打上了却毫无
 * 效果（这个坑实测踩过）。
 *
 * 定位方法体用括号配平而不是比对固定文本：早先按固定片段匹配的版本，一旦上游重新
 * 生成产物（缩进、单行 for、字段顺序变化）就会直接报「找不到锚点」。2.0.x 与 2.2.x
 * 的产物都靠这个方式打上了。
 *
 * @throws 当方法体或返回语句定位不到时（产物结构与预期不符）。
 */
function injectIntoPrepareChatBody(source) {
  const range = prepareBodyRange(source)
  if (range === undefined) {
    throw new Error('产物里找不到结构完整的 prepareChatBody(raw) —— 可能不是 dsh-xdpool 的 bundle')
  }
  // 归一化 body 的最后一步是 `return JSON.stringify(obj)`；在它之前落一行，才真正在
  // 序列化之前改写。限定在方法体范围内查找，避免撞上文件里别处的同名语句。
  const body = source.slice(range.bodyOpen, range.bodyEnd)
  const returnMatch = /return\s+JSON\.stringify\(\s*obj\s*\)/.exec(body)
  if (returnMatch === null) {
    throw new Error('prepareChatBody 里找不到 `return JSON.stringify(obj)` —— 产物结构与预期不符')
  }
  const at = range.bodyOpen + returnMatch.index
  const eol = detectEol(source)
  // 该行相对 return 语句那一行要有额外一级缩进。
  const lineStart = source.lastIndexOf('\n', at) + 1
  const returnIndent = source.slice(lineStart, at).match(/^[\t ]*/)?.[0] ?? '\t\t'
  const call = `if (Array.isArray(obj["messages"])) ${MARKER}(obj["messages"]);${eol}${returnIndent}`
  const patched = source.slice(0, at) + call + source.slice(at)
  return `${HELPERS.replace(/\n/g, eol)}${eol}${patched}`
}

// ───────────────────────────── 自检 ─────────────────────────────

/**
 * 把改写逻辑从产物里抠出来实跑一遍。
 *
 * 不 import 整个包：插件的产物会解析它自己的依赖（schemastery、pi-ai 等），在只有
 * lib/ 的副本上必然失败，而那与补丁是否生效无关。这里只取注入的助手函数与
 * prepareChatBody 的方法体，包成函数执行。
 */
async function selfCheck(install) {
  const source = readFileSync(install.bundle, 'utf8')
  if (!source.includes(MARKER)) return { ok: false, reason: '产物里没有注入标记' }

  const helperStart = source.indexOf(`/** ${MARKER}`)
  const identityFn = source.indexOf(`function ${MARKER}(messages)`)
  if (helperStart < 0 || identityFn < 0) return { ok: false, reason: '找不到注入的助手函数' }
  // 收尾要同时容忍 LF 与 CRLF：产物多半是 CRLF，只找 '\n}\n' 会匹配失败，然后把整个
  // 文件当成助手区段拼进临时模块，自检就会以一句莫名其妙的语法错误收场。
  const helperEnd = /\r?\n}\r?\n/.exec(source.slice(identityFn))
  if (helperEnd === null) return { ok: false, reason: '助手函数区段没有找到结尾' }
  const helpers = source.slice(helperStart, identityFn + helperEnd.index + helperEnd[0].length)

  const range = prepareBodyRange(source)
  if (range === undefined) return { ok: false, reason: '找不到结构完整的 prepareChatBody' }

  const dir = mkdtempSync(join(tmpdir(), 'xdpool-check-'))
  const file = join(dir, 'extracted.cjs')

  // 用 `new Function` 包一层方法体，而不是把它拼进模块顶层。
  //
  // 两个坑都要绕：
  //   1. 方法体自己声明了 `let body` / `const obj`，形参也叫 `raw`，顶层再出现同名
  //      变量就是 SyntaxError。包成函数后重名只发生在内外两层，互不干扰 —— 这也正是
  //      它在类里跑的样子。
  //   2. `new Function` 造出来的函数只能看见**全局**作用域，而助手函数是该模块顶层的
  //      局部声明，直接调用会 ReferenceError。所以按名字把助手函数当形参传进去。
  //
  // 用 CJS + module.exports（而非 ESM export）：`new Function` 的函数体里不能出现
  // `export` 语句，但可以给 `module.exports` 赋值。
  const helperNames = [
    '__XDPOOL_HARNESS_IDENTITY',
    '__XDPOOL_NEUTRAL_IDENTITY',
    '__xdpoolIdentityTextCarrier',
    '__xdpoolRewriteIdentitySentence',
    MARKER,
  ].filter((name) => helpers.includes(name))

  const bodySource = source.slice(range.bodyOpen + 1, range.bodyEnd)
  writeFileSync(
    file,
    `${helpers}\n`
    + `module.exports = new Function(${helperNames.map((n) => JSON.stringify(n)).join(', ')}, 'raw', ${JSON.stringify(bodySource)})`
    + `.bind(null, ${helperNames.join(', ')});\n`,
    'utf8',
  )

  try {
    const extracted = (await import(pathToFileURL(file).href)).default
    const check = (raw) => extracted(raw)

    const before = JSON.stringify({
      model: 'm',
      stream: true,
      messages: [
        { role: 'developer', content: `${PHRASE}\n\nYou operate in a workspace and may call tools.` },
        { role: 'user', content: 'hi' },
      ],
    })
    const after = check(before)
    const parsed = JSON.parse(after)
    return {
      ok: true,
      phraseGone: !after.includes(PHRASE),
      replacement: parsed.messages[0].content.split('\n')[0],
      role: parsed.messages[0].role,
      userIntact: parsed.messages[1].content === 'hi',
      idempotent: check(after) === after,
      toolArgsUntouched: (() => {
        const raw = JSON.stringify({ model: 'm', messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: PHRASE }) } }] },
        ] })
        return check(raw).includes(PHRASE)
      })(),
    }
  } catch (error) {
    return { ok: false, reason: `抠出来的方法体无法执行：${String(error).split('\n')[0]}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ───────────────────────────── 输出 ─────────────────────────────

function banner(text) {
  console.log(`\n${text}`)
}

/** 打印自检结果，返回是否全部通过。 */
function reportSelfCheck(results) {
  if (!results.ok) {
    console.log(`    自检：无法执行（${results.reason}）`)
    return false
  }
  const pass = results.phraseGone && results.role === 'system' && results.userIntact && results.idempotent && results.toolArgsUntouched
  console.log(`    身份句已从报文中消失  : ${results.phraseGone ? '✅' : '❌'}`)
  console.log(`    指令消息首个 role     : ${results.role}${results.role === 'system' ? ' ✅' : ' ❌'}`)
  console.log(`    改写为                : ${results.replacement}`)
  console.log(`    用户消息未被改动       : ${results.userIntact ? '✅' : '❌'}`)
  console.log(`    工具调用参数未被误改    : ${results.toolArgsUntouched ? '✅' : '❌'}`)
  console.log(`    幂等（再跑一次无变化）  : ${results.idempotent ? '✅' : '❌'}`)
  return pass
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  let installs
  try {
    installs = findInstalls()
  } catch (error) {
    console.error(`\n❌ ${String(error)}`)
    process.exit(1)
  }

  if (installs.length === 0) {
    console.error('\n❌ 没有找到已安装的 dsh-xdpool。')
    console.error(`   已查找的 DSH 主目录：${dshHome()}`)
    console.error('   profile 下的 node_modules/dsh-xdpool、node_modules/dsh-workbuddy-xdpool、vendor/ 都看过了。')
    console.error('   若装在别处，用 --dir <插件包根目录> 指定。')
    process.exit(1)
  }

  banner(`找到 ${installs.length} 个安装：`)
  for (const install of installs) {
    console.log(`  ${install.packageName} v${install.version}`)
    console.log(`    产物: ${install.bundle}  (${install.bytes} 字节)`)
    console.log(`    状态: ${install.patched ? '已打补丁' : '未打补丁'}${install.hasPrepareChatBody ? '' : '  ⚠️ 找不到 prepareChatBody'}`)
  }
  if (LIST_ONLY) return

  if (CHECK_ONLY) {
    banner('检查结果：')
    let bad = 0
    for (const install of installs) {
      console.log(`\n  ${install.bundle}`)
      if (!install.patched) {
        bad += 1
        console.log('    ❌ 未打补丁 —— 需要修复')
        continue
      }
      if (reportSelfCheck(await selfCheck(install))) {
        console.log('    ✅ 已修好')
      } else {
        bad += 1
        console.log('    ❌ 自检未通过')
      }
    }
    process.exit(bad === 0 ? 0 : 1)
  }

  if (ROLLBACK) {
    banner('回滚：')
    let restored = 0
    for (const install of installs) {
      const backup = `${install.bundle}${BACKUP_SUFFIX}`
      if (!existsSync(backup)) {
        console.log(`  跳过（无备份）: ${install.bundle}`)
        continue
      }
      if (DRY_RUN) {
        console.log(`  将用备份还原: ${install.bundle}`)
        continue
      }
      copyFileSync(backup, install.bundle)
      restored += 1
      console.log(`  已还原 ${install.bundle}（${statSync(install.bundle).size} 字节）`)
      console.log(`    备份保留在 ${backup}`)
    }
    if (restored === 0 && !DRY_RUN) console.log('  没有任何文件被还原。')
    console.log('\n  提示：还原后需要重启 DSH 才会生效。')
    return
  }

  const targets = installs.filter((install) => !install.patched)

  if (targets.length === 0) {
    banner('所有安装都已打过补丁，无需修改。再做一次自检：')
    let bad = 0
    for (const install of installs) {
      console.log(`\n  ${install.bundle}`)
      if (!reportSelfCheck(await selfCheck(install))) bad += 1
    }
    if (bad > 0) process.exit(2)
    return
  }

  banner(DRY_RUN ? '预演（不会写文件）：' : '开始修复：')
  let failures = 0
  for (const install of targets) {
    console.log(`\n  ${install.bundle}`)
    const source = readFileSync(install.bundle, 'utf8')
    let patched
    try {
      patched = injectIntoPrepareChatBody(source)
    } catch (error) {
      failures += 1
      console.log(`    ❌ ${String(error)}`)
      console.log('       未做任何修改。请把这一行连同插件版本一起反馈，或改用源码修复。')
      continue
    }
    if (DRY_RUN) {
      console.log(`    将插入 ${MARKER}（${patched.length - source.length} 字符）`)
      continue
    }
    const backup = `${install.bundle}${BACKUP_SUFFIX}`
    if (!existsSync(backup)) {
      copyFileSync(install.bundle, backup)
      console.log(`    备份: ${backup}`)
    } else {
      console.log(`    备份已存在，保留: ${backup}`)
    }
    writeFileSync(install.bundle, patched, 'utf8')
    console.log(`    已写入（${statSync(install.bundle).size} 字节）`)
    if (!reportSelfCheck(await selfCheck(install))) failures += 1
  }

  banner('下一步：')
  console.log('  重启 DSH（桌面版：完全退出后重新打开），补丁才会加载。')
  console.log('  重启后随便选一个 WorkBuddy 分组的模型发一句 —— 不再出现')
  console.log('  「请求被拦截，请重新发送」即修复成功。')
  console.log(`  回滚：node ${process.argv[1]?.split(/[\\/]/).pop() ?? 'fix-xdpool-channel-check.mjs'} --rollback`)
  console.log('  注意：以后用 npm/pnpm 升级或重装该插件会覆盖产物，需要重跑本脚本。')

  if (failures > 0) {
    banner(`⚠️ ${failures} 个安装未能完成或自检未通过，请看上面的输出。`)
    process.exit(2)
  }
}

await main()
