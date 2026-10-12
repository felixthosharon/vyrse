import crypto, { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { handleSkillRequest, interactionModel, questionFrom, type SkillDeps } from '../src/main/alexa-skill-logic'
import { checkChain, checkSignature, checkTimestamp, parseChain, validCertUrl, verifyAmazonRequest } from '../src/main/amazon-verify'

const SKILL = 'amzn1.ask.skill.test'
const USER = 'amzn1.ask.account.user1'

function envelope(request: Record<string, unknown>, opts: { skill?: string; user?: string } = {}) {
  return {
    context: { System: { application: { applicationId: opts.skill ?? SKILL }, user: { userId: opts.user ?? USER } } },
    request,
  }
}

const ask = (intent: string, query?: string) =>
  envelope({ type: 'IntentRequest', intent: { name: intent, slots: query === undefined ? {} : { query: { value: query } } } })

function deps(overrides: Partial<SkillDeps> = {}): SkillDeps & { locked: string[]; late: ReturnType<typeof vi.fn> } {
  const locked: string[] = []
  const late = vi.fn()
  return {
    skillId: SKILL,
    lockedUserId: USER,
    lockUser: u => locked.push(u),
    ask: async q => `answer to: ${q}`,
    quickMs: 50,
    late,
    canSpeakLater: true,
    locked,
    ...overrides,
  } as SkillDeps & { locked: string[]; late: ReturnType<typeof vi.fn> }
}

const said = (r: { body: unknown }) => (r.body as { response: { outputSpeech?: { text: string } } }).response.outputSpeech?.text

describe('Echo → VYRSE skill', () => {
  it('rejects other skills and other Amazon users', async () => {
    expect((await handleSkillRequest(ask('AskIntent', 'hi'), deps({ skillId: '' }))).status).toBe(403)
    expect((await handleSkillRequest(envelope({ type: 'LaunchRequest' }, { skill: 'amzn1.ask.skill.other' }), deps())).status).toBe(403)
    expect((await handleSkillRequest(envelope({ type: 'LaunchRequest' }, { user: 'someone-else' }), deps())).status).toBe(403)
  })

  it('links the first verified user, then only that user', async () => {
    const d = deps({ lockedUserId: null })
    expect((await handleSkillRequest(envelope({ type: 'LaunchRequest' }), d)).status).toBe(200)
    expect(d.locked).toEqual([USER])
  })

  it('puts the swallowed question word back', () => {
    expect(questionFrom('WhatIntent', 'is my cpu usage')).toBe('what is my cpu usage')
    expect(questionFrom('AskIntent', 'set a timer')).toBe('set a timer')
  })

  it('answers quickly when VYRSE is quick', async () => {
    const r = await handleSkillRequest(ask('WhatIntent', 'time is it'), deps())
    expect(said(r)).toBe('answer to: what time is it')
  })

  it('says "on it" and finishes on the Echo when VYRSE is slow', async () => {
    let finish: (t: string) => void = () => {}
    const d = deps({ ask: () => new Promise(resolve => (finish = resolve)) })
    const r = await handleSkillRequest(ask('AskIntent', 'summarise my screen'), d)
    expect(said(r)).toMatch(/On it/)
    finish('Your screen shows VS Code.')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(d.late).toHaveBeenCalledWith('Your screen shows VS Code.')
  })

  it("doesn't promise an Echo answer it can't deliver", async () => {
    const d = deps({ ask: () => new Promise(() => {}), canSpeakLater: false })
    expect(said(await handleSkillRequest(ask('AskIntent', 'summarise my screen'), d))).toMatch(/on your PC/)
  })

  it('handles stop, help and empty questions without asking VYRSE', async () => {
    const d = deps({ ask: vi.fn() })
    expect(said(await handleSkillRequest(ask('AMAZON.StopIntent'), d))).toBe('Later!')
    expect(said(await handleSkillRequest(ask('AskIntent', ''), d))).toMatch(/Try something/)
    expect(d.ask).not.toHaveBeenCalled()
  })

  it('model has the invocation name and a SearchQuery intent per question word', () => {
    const model = interactionModel() as { interactionModel: { languageModel: { invocationName: string; intents: { name: string }[] } } }
    expect(model.interactionModel.languageModel.invocationName).toBe('my p. c.')
    expect(model.interactionModel.languageModel.intents.map(i => i.name)).toContain('WhatIntent')
  })
})

describe('Amazon request verification (Node crypto, no third-party crypto)', () => {
  const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'amazon', f), 'utf8')
  const root = new X509Certificate(fx('root.pem'))
  const leafChain = parseChain(fx('leaf.pem') + fx('root.pem'))
  const body = JSON.stringify({ ...ask('AskIntent', 'what time is it'), request: { type: 'IntentRequest', timestamp: new Date().toISOString() } })
  const sign = (key: string, data: string) => crypto.sign('sha256', Buffer.from(data), key).toString('base64')

  it('accepts only Amazon’s certificate location', () => {
    for (const ok of [
      'https://s3.amazonaws.com/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem',
      'https://S3.AMAZONAWS.COM/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com/echo.api/../echo.api/echo-api-cert.pem',
    ])
      expect(validCertUrl(ok), ok).toBe(true)
    for (const bad of [
      'http://s3.amazonaws.com/echo.api/echo-api-cert.pem',
      'https://notamazon.com/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem',
      'https://s3.amazonaws.com/invalid.path/echo-api-cert.pem',
      'https://s3.amazonaws.com:563/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com.evil.com/echo.api/x.pem',
      undefined,
    ])
      expect(validCertUrl(bad), String(bad)).toBe(false)
  })

  it('accepts a genuine signed request and rejects tampering', () => {
    checkChain(leafChain, Date.now(), [root])
    const sig = sign(fx('leaf.key'), body)
    expect(() => checkSignature(body, sig, leafChain[0]!)).not.toThrow()
    expect(() => checkSignature(body.replace('IntentRequest', 'LaunchRequest'), sig, leafChain[0]!)).toThrow()
    expect(() => checkSignature(body, sign(fx('wrongname.key'), body), leafChain[0]!)).toThrow()
    expect(() => checkSignature(body, undefined, leafChain[0]!)).toThrow()
  })

  it('rejects certificates that aren’t Amazon’s, untrusted chains and expired ones', () => {
    expect(() => checkChain(parseChain(fx('wrongname.pem') + fx('root.pem')), Date.now(), [root])).toThrow(/echo-api/)
    expect(() => checkChain(leafChain, Date.now(), [])).toThrow(/trusted root/)
    expect(() => checkChain(leafChain, Date.now() + 20 * 365 * 86_400_000, [root])).toThrow(/expired/)
    expect(() => checkChain([], Date.now(), [root])).toThrow()
  })

  it('rejects stale and missing timestamps', () => {
    expect(() => checkTimestamp(body)).not.toThrow()
    expect(() => checkTimestamp(JSON.stringify({ request: { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() } }))).toThrow()
    expect(() => checkTimestamp(JSON.stringify({ request: {} }))).toThrow()
    expect(() => checkTimestamp('not json')).toThrow()
  })

  it('a forged request with no signature never gets through', async () => {
    await expect(verifyAmazonRequest(body, {})).rejects.toThrow()
    await expect(
      verifyAmazonRequest(body, { signaturecertchainurl: 'https://evil.example.com/echo.api/cert.pem', 'signature-256': 'AAAA' }),
    ).rejects.toThrow(/certificate URL/)
  })
})

describe('commands without "to"', () => {
  it('puts the command word back', () => {
    expect(questionFrom('OpenIntent', 'spotify')).toBe('open spotify')
    expect(questionFrom('TurnIntent', 'the volume down')).toBe('turn the volume down')
  })
})
