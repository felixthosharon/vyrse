/**
 * Echo → VYRSE: what the Alexa skill answers, separated from HTTP, verification and tunnelling
 * (alexa-skill.ts) so it can be tested on its own.
 */

/** Question words Alexa's carrier phrases swallow ("ask my pc what time it is" → query "time it is"). */
export const QUESTION_WORDS = [
  'what', 'how', 'who', 'why', 'where', 'when', 'which', 'is', 'are', 'can', 'should',
  // Commands too, so "ask my pc open spotify" works without "to" (Alexa needs a word before the free text).
  'open', 'close', 'play', 'pause', 'turn', 'set', 'check', 'show', 'search', 'find', 'remind', 'lock', 'start',
  'make', 'send', 'read', 'summarise', 'summarize', 'type', 'take', 'give', 'mute', 'switch', 'put', 'write',
] as const

export interface SkillDeps {
  /** the user's name from VYRSE's settings, for the greeting ("" = none) */
  userName?: string
  /** the skill ID this gateway accepts (required) */
  skillId: string
  /** Amazon user locked to this VYRSE; null = not linked yet (the first verified user gets linked) */
  lockedUserId: string | null
  lockUser(userId: string): void
  /** ask VYRSE; resolves with the reply text (already made speakable) */
  ask(text: string): Promise<string>
  /** time Alexa gets before VYRSE answers "on it" and finishes on the Echo later */
  quickMs: number
  /** a slow answer, delivered later (spoken on the Echo through the sign-in, if connected) */
  late(answer: string): void
  /** a late answer can be spoken on the Echo (Amazon sign-in connected); otherwise it only lands on the PC */
  canSpeakLater: boolean
}

interface Envelope {
  session?: { application?: { applicationId?: string }; user?: { userId?: string } }
  context?: { System?: { application?: { applicationId?: string }; user?: { userId?: string } } }
  request?: { type?: string; intent?: { name?: string; slots?: Record<string, { value?: string }> } }
}

export interface SkillResult {
  status: number
  body: unknown
}

const speech = (text: string, endSession = true) => ({
  status: 200,
  body: {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: text.slice(0, 7000) },
      shouldEndSession: endSession,
      ...(endSession ? {} : { reprompt: { outputSpeech: { type: 'PlainText', text: 'What do you need?' } } }),
    },
  },
})

const reject = (status: number, reason: string): SkillResult => ({ status, body: { error: reason } })

/** The question as the user said it: AskIntent keeps its slot, question-word intents get the word back. */
export function questionFrom(intentName: string, slot: string): string {
  const q = slot.trim()
  if (!q) return ''
  const m = /^(\w+)Intent$/.exec(intentName)
  const word = m ? m[1]!.toLowerCase() : ''
  return (QUESTION_WORDS as readonly string[]).includes(word) ? `${word} ${q}` : q
}

export async function handleSkillRequest(envelope: Envelope, deps: SkillDeps): Promise<SkillResult> {
  const appId = envelope.context?.System?.application?.applicationId ?? envelope.session?.application?.applicationId
  const userId = envelope.context?.System?.user?.userId ?? envelope.session?.user?.userId
  if (!deps.skillId || appId !== deps.skillId) return reject(403, 'wrong skill')
  if (!userId) return reject(403, 'no user')
  if (deps.lockedUserId && userId !== deps.lockedUserId) return reject(403, 'not the linked Amazon user')
  if (!deps.lockedUserId) deps.lockUser(userId)

  const type = envelope.request?.type
  if (type === 'SessionEndedRequest') return { status: 200, body: { version: '1.0', response: {} } }
  if (type === 'LaunchRequest') return speech(deps.userName ? `Hey ${deps.userName}, what’s up?` : 'Hey, what’s up?', false)
  if (type !== 'IntentRequest') return speech('Sorry, I didn’t get that.')

  const intent = envelope.request?.intent?.name ?? ''
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent' || intent === 'AMAZON.NavigateHomeIntent')
    return speech('Later!')
  if (intent === 'AMAZON.HelpIntent') return speech('Ask me anything, like: ask my pc what’s on my screen, or ask my pc to set a reminder.', false)

  const question = questionFrom(intent, envelope.request?.intent?.slots?.['query']?.value ?? '')
  if (!question) return speech('Try something like: ask my pc what’s my CPU usage.', false)

  const answer = deps.ask(question)
  let timer: ReturnType<typeof setTimeout> | undefined
  const quick = await Promise.race([
    answer.then(text => ({ text }), err => ({ text: `Sorry, that didn’t work: ${String((err as Error)?.message ?? err)}` })),
    new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), deps.quickMs)
    }),
  ])
  clearTimeout(timer)
  if (quick) return speech(quick.text || 'Done.')
  // Alexa only waits about 8 seconds; finish the answer later on the Echo (and it's on the PC anyway).
  void answer.then(text => text && deps.late(text)).catch(() => {})
  return speech(deps.canSpeakLater ? 'On it. I’ll tell you in a moment.' : 'That one’s taking a bit. The answer will be on your PC.')
}

/** Interaction model to paste into the Alexa developer console (JSON Editor) for the en-IN locale. */
// Alexa's recogniser only knows real words ("Vyse" came out as "wise"), so the skill is "my pc"; Amazon
// requires acronyms spelled as letters ("p. c.") in invocation names.
export function interactionModel(invocationName = 'my p. c.'): unknown {
  const questionIntents = QUESTION_WORDS.map(word => ({
    name: `${word[0]!.toUpperCase()}${word.slice(1)}Intent`,
    slots: [{ name: 'query', type: 'AMAZON.SearchQuery' }],
    samples: [`${word} {query}`],
  }))
  return {
    interactionModel: {
      languageModel: {
        invocationName,
        intents: [
          {
            name: 'AskIntent',
            slots: [{ name: 'query', type: 'AMAZON.SearchQuery' }],
            samples: ['to {query}', 'for {query}', 'about {query}', 'please {query}', 'tell me {query}', 'i want to {query}', 'could you {query}', 'do {query}'],
          },
          ...questionIntents,
          { name: 'AMAZON.CancelIntent', samples: [] },
          { name: 'AMAZON.HelpIntent', samples: [] },
          { name: 'AMAZON.StopIntent', samples: [] },
          { name: 'AMAZON.NavigateHomeIntent', samples: [] },
          { name: 'AMAZON.FallbackIntent', samples: [] },
        ],
        types: [],
      },
    },
  }
}
