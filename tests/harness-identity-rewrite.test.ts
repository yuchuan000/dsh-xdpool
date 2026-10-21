/**
 * 网关 11128 的第二道判据：DSH 的身份句。
 *
 * 2026-10-21 在 CN chat 端（`/v2/chat/completions`）实测确认：同一个
 * `code 11128` / `msg: "Illegal API invocation from an unapproved channel"` 之后
 * 还藏着一个独立成因——指令消息**以 DSH 的身份句开头**。与已在处理的
 * `developer` 角色共用同一个 code，所以两者只能各自单独守住。
 *
 * 这里把实测矩阵固化成离线断言：改写落到 `prepareChatBody`（因此
 * `buildChatBody`、compact、链式重试也都带上），且只动指令文本。
 */

import { describe, expect, it } from 'vitest'
import {
  carriesHarnessIdentity,
  rewriteHarnessIdentity,
  WorkBuddyUpstreamClient,
} from '../src/upstream.ts'

const PHRASE = 'You are an AI agent powered by DeepSeek Harness.'
const NEUTRAL = 'You are an AI agent running inside this harness.'

const client = new WorkBuddyUpstreamClient()

/** 一条 pi-ai 形态的请求：系统提示作为单条指令消息。 */
function bodyWith(content: unknown, role = 'developer'): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: false,
    messages: [
      { role, content },
      { role: 'user', content: 'hello' },
    ],
  })
}

/** 解析归一化后的 body。 */
function parse(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>
}

/** 归一化后 body 的第一条消息。 */
function firstMessage(body: string): Record<string, unknown> {
  const messages = parse(body)['messages'] as Array<Record<string, unknown>>
  return messages[0] as Record<string, unknown>
}

describe('prepareChatBody 抹掉 DSH 身份句', () => {
  it('改写 developer 指令消息里的身份句，其余内容原样保留', () => {
    const prompt = `${PHRASE}\n\nYou operate in a workspace and may call tools.`
    const prepared = client.prepareChatBody(bodyWith(prompt))
    const first = firstMessage(prepared)

    expect(carriesHarnessIdentity(prepared)).toBe(false)
    // developer → system 的既有规则仍然生效（上游同样以 11128 拒绝该角色）。
    expect(first['role']).toBe('system')
    expect(first['content']).toBe(`${NEUTRAL}\n\nYou operate in a workspace and may call tools.`)
    const messages = parse(prepared)['messages'] as Array<Record<string, unknown>>
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(parse(prepared)['model']).toBe('deepseek-v4.1-flash')
    expect(parse(prepared)['stream']).toBe(true)
  })

  it('system 角色的指令消息同样改写', () => {
    const prepared = client.prepareChatBody(bodyWith(PHRASE, 'system'))
    expect(carriesHarnessIdentity(prepared)).toBe(false)
    expect(firstMessage(prepared)['content']).toBe(NEUTRAL)
  })

  it('身份句夹在长 prompt 中间也改写', () => {
    const prompt = [
      'You are a coding agent.',
      '',
      'The harness introduces itself as follows:',
      PHRASE,
      '',
      'Follow the user instructions.',
    ].join('\n')
    const prepared = client.prepareChatBody(bodyWith(prompt))
    const content = firstMessage(prepared)['content'] as string

    expect(carriesHarnessIdentity(prepared)).toBe(false)
    expect(content).toContain('You are a coding agent.')
    expect(content).toContain('Follow the user instructions.')
    expect(content).toContain(NEUTRAL)
  })

  it('分段 content 数组里的文本段也改写，分段结构不变', () => {
    const prepared = client.prepareChatBody(bodyWith([{ type: 'text', text: `${PHRASE}\nbody` }]))
    const content = firstMessage(prepared)['content'] as Array<Record<string, unknown>>

    expect(carriesHarnessIdentity(prepared)).toBe(false)
    expect(content[0]?.['text']).toBe(`${NEUTRAL}\nbody`)
    expect(content[0]?.['type']).toBe('text')
  })

  it('容忍句内折行与不同大小写', () => {
    for (const variant of [
      'You are an AI agent\npowered by DeepSeek Harness.',
      'You are an AI agent powered by DeepSeek Harness',
      'you are an ai agent powered by deepseek harness.',
    ]) {
      const prepared = client.prepareChatBody(bodyWith(variant))
      expect(prepared).not.toContain('DeepSeek Harness')
      expect(prepared).toContain(NEUTRAL)
    }
  })

  it('幂等：重复归一化不再产生变化', () => {
    const once = client.prepareChatBody(bodyWith(PHRASE))
    expect(client.prepareChatBody(once)).toBe(once)
  })

  it('用户消息里引用了这句话时保持原样', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: `what does "${PHRASE}" mean?` },
      ],
    })
    const prepared = client.prepareChatBody(raw)

    expect(carriesHarnessIdentity(prepared)).toBe(true)
    const messages = parse(prepared)['messages'] as Array<Record<string, unknown>>
    expect(messages[1]?.['content']).toBe(`what does "${PHRASE}" mean?`)
  })

  it('不动工具调用的参数与 id', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'grep', arguments: JSON.stringify({ pattern: PHRASE }) },
          }],
        },
      ],
    })
    expect(carriesHarnessIdentity(client.prepareChatBody(raw))).toBe(true)
  })

  it('非 JSON body 原样返回', () => {
    expect(client.prepareChatBody('not json')).toBe('not json')
  })
})

describe('rewriteHarnessIdentity 直接调用的契约', () => {
  it('只处理指令角色，位置无关', () => {
    const messages: unknown[] = [
      { role: 'developer', content: PHRASE },
      { role: 'user', content: PHRASE },
      { role: 'system', content: PHRASE },
      { role: 'tool', content: PHRASE },
    ]
    rewriteHarnessIdentity(messages)

    expect((messages[0] as Record<string, unknown>)['content']).toBe(NEUTRAL)
    expect((messages[1] as Record<string, unknown>)['content']).toBe(PHRASE)
    expect((messages[2] as Record<string, unknown>)['content']).toBe(NEUTRAL)
    expect((messages[3] as Record<string, unknown>)['content']).toBe(PHRASE)
  })

  it('对非对象元素与缺失 content 不抛错', () => {
    const messages: unknown[] = [null, 'text', 42, { role: 'system' }, { role: 'system', text: PHRASE }]
    expect(() => rewriteHarnessIdentity(messages)).not.toThrow()
    expect((messages[4] as Record<string, unknown>)['text']).toBe(NEUTRAL)
  })
})
