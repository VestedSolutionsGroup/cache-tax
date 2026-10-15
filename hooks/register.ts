import type { EngineInterface, Register } from 'claude-code'
import { statusIcons } from './status-icons'

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  /** The armed window's full length, for the desktop card; 0 when unknown, as after a reload restores only the deadline. */
  window: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  drawn: string | null
}

function priceOf(model: string | null): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

// The countdown chip: how long the one-hour cache stays warm. Its glyph steps in
// 120 steps, every 30 seconds, so it redraws a few times a minute at most.
const WARN_FRACTION = 0.2
const RING_STEPS = 120
// Moon phases wane with the hour; NO_COLOR keeps monochrome ring glyphs, since emoji draw in their own colors.
const MOONS = ['🌝', '🌖', '🌗', '🌘', '🌚']
const COLD_MOON = '💀'
const GLYPHS = ['●', '◕', '◑', '◔', '○']
const COLD_GLYPH = '◌'

export type Countdown = { left: number; level: 'warm' | 'warn' | 'cold'; step: number; label: string }

/** Where the cache's one-hour clock stands, or null before the first request and after compaction. */
export function countdown(s: State, now: number): Countdown | null {
  if (!s.lastRequestAt || s.compacted) return null
  const left = s.lastRequestAt + TTL_MS - now
  const level = left <= 0 ? 'cold' : left <= TTL_MS * WARN_FRACTION ? 'warn' : 'warm'
  const step = left <= 0 ? 0 : Math.ceil(left / TTL_MS * RING_STEPS)
  const label = left <= 0 ? 'Cold' : left <= 59000 ? '0:' + String(Math.ceil(left / 1000)).padStart(2, '0') : Math.ceil(left / 60000) + 'm'
  return { left, level, step, label }
}

/** The chip's glyph: one that empties as the cache cools, a moon phase unless NO_COLOR is set. */
export function ringGlyph(c: Countdown, plain = false): string {
  if (c.level === 'cold') return plain ? COLD_GLYPH : COLD_MOON
  const set = plain ? GLYPHS : MOONS
  const emptied = 1 - c.step / RING_STEPS
  return set[Math.min(set.length - 1, Math.round(emptied * (set.length - 1)))]
}

/** Redraws when the chip's label or ring, or keepwarm's minutes left, changes, then waits for the next change: the next 30-second step, or the next second in the last minute. */
async function tick($: EngineInterface, s: State) {
  const now = await $.clock.now()
  const c = countdown(s, now)
  const key = (c ? c.level + c.label + c.step : '') + (s.deadline > now ? ':' + Math.ceil((s.deadline - now) / 60000) : '')
  if (key !== s.drawn) {
    s.drawn = key
    $.ui.invalidate('ui.render')
  }
  const unit = c && c.left > 0 && c.left <= 60000 ? 1000 : 30000
  $.clock.after(c && c.left > 0 ? c.left % unit || unit : unit, () => { void tick($, s) })
}

/** Minutes and hours as the desktop card spells them: `2h 51m`, `6h`, `39m`. */
function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`
}

/** The desktop hover card: the cache's time left, then keepwarm's window. */
export function cardLines(s: State, c: Countdown, now: number): { title: string; detail: string } {
  const secs = Math.ceil(c.left / 1000)
  const mins = Math.ceil(c.left / 60000)
  const ttl = c.level === 'cold' ? 'expired' : c.left <= 59000 ? `${secs} second${secs === 1 ? '' : 's'}` : `${mins} minute${mins === 1 ? '' : 's'}`
  const armed = s.deadline > now
  const warm = !armed ? 'off' : s.window ? `${fmtSpan(s.deadline - now)} / ${fmtSpan(s.window)}` : `${fmtSpan(s.deadline - now)} left`
  return { title: `Context Cache TTL · ${ttl}`, detail: `Keep Warm · ${warm}` }
}

// The desktop chip's hover colors, sampled from the app's own usage popup in its dark theme.
const desktopDark = { hover: '#262626', card: '#20201f', border: '#373736' }
const desktopLight = { hover: '#ebe9e4', card: '#ffffff', border: '#d9d7d2' }

function drawsBand(surface: string | null): boolean {
  return surface === 'terminal' || surface === 'desktop'
}

/** Moves from the plain status text to the band and chip once a surface that draws them is here; answers the display preferences. */
async function bandOn($: EngineInterface, s: State): Promise<{ light: boolean; noColor: boolean }> {
  s.hasBand = true
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  const noColor = Boolean(await $.env.get('NO_COLOR'))
  $.ui.status(undefined)
  // A reload starts the session again; one ticker is enough.
  if (s.drawn === null) {
    s.drawn = ''
    void tick($, s)
  }
  $.ui.invalidate('ui.render')
  return { light: typeof theme === 'string' && theme.startsWith('light'), noColor }
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(statusText(s, now))
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.window = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  updateStatus($, s, await $.clock.now())
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) return
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.window = windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next session start, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, window: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null, drawn: null,
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  // The label stays in the footer's dim gray until the last fifth of the hour.
  const chipStyle = (c: Countdown) => c.level === 'warn' ? (noColor ? { bold: true } : { color: 'warning' }) : { dimColor: true }

  // The footer, terminal and desktop alike: the countdown chip after Claude Code's mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!drawsBand(e.surface)) return next(e)
    const now = await $.clock.now()
    const c = countdown(s, now)
    if (!c) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const glyph = ringGlyph(c, noColor)
    // On desktop the glyph stands alone and the time left moves into a card that the pointer reveals,
    // drawn like the app's own usage popup: the chip lights under the pointer and the card sits above it.
    const chip = e.surface !== 'desktop' ? Text({ ...chipStyle(c), children: [`${glyph} ${c.label}`] }) : (() => {
      const { title, detail } = cardLines(s, c, now)
      const palette = light ? desktopLight : desktopDark
      const card = Box({
        position: 'absolute', bottom: 1, right: 0, display: 'none', hover: { display: 'flex' },
        flexDirection: 'column', minWidth: Math.max(title.length, detail.length) + 4, paddingX: 1,
        backgroundColor: palette.card, borderStyle: 'round', borderColor: palette.border,
        children: [
          Text({ bold: true, ...(c.level === 'warn' ? chipStyle(c) : {}), children: [title] }),
          Text({ dimColor: true, children: [detail] }),
        ],
      })
      return Box({ key: 'cache-tax-chip', position: 'relative', paddingX: 1, hover: { backgroundColor: palette.hover }, children: [Text({ children: [glyph] }), card] })
    })()
    // A column of space keeps the glyph off whatever the footer draws to its left.
    if (e.props.modes.length === 0) return Box({ marginLeft: 1, children: [chip] })
    const theirs = await next(e)
    return Box({ flexDirection: 'row', alignItems: 'center', children: [theirs, Text({ dimColor: true, children: [' · '] }), chip] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const text = statusText(s, now)
    let row = null
    if (text && !(s.deadline && now >= s.deadline)) {
      const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
      const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
      const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
      const icon = noColor ? Text({ bold: true, children: ['[>]'] })
        : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
        : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Tax' })
        : Text({ color, bold: true, children: ['[>]'] })
      row = Box({ flexDirection: 'row', alignItems: 'center', children: [
        Box({ flexShrink: 0, children: [icon] }),
        Text({ children: [
          ' cache-tax · ',
          Text({ color, bold: true, children: [state] }),
          ` · ${text}`,
        ] }),
      ] })
    }
    return row ? Box({ flexDirection: 'column', children: [rest, row] }) : rest
  })

  // The desktop app hosts the session through the SDK, so session.start sees no surface;
  // the app arrives afterwards as an attached client.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (drawsBand(e.surface) && !s.hasBand) ({ light, noColor } = await bandOn($, s))
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // A reload while the desktop is attached starts with no surface of its own; the roster still names it.
    s.hasBand = false
    if (drawsBand(e.surface) || (await $.session.surfaces()).some(drawsBand)) ({ light, noColor } = await bandOn($, s))
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-tax, the Mod)',
      argumentHint: '[status | guard warn | guard refuse]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session starts with a ${fmtDuration(DEFAULT_WINDOW_MS)} window; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (window == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
        every = period
      }
      await startWindow($, s, window, every)
      return { text: armedText(s, now, window) }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-tax guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    if (s.guard === 'warn') {
      $.ui.log(`${guardText(s, now)} Sending anyway; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(AUTO_WARM_MS)}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) s.lastRequestAt = await $.clock.now()
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.ackedAt = 0
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel)
        const usd = price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        if (s.deadline < now + AUTO_WARM_MS) {
          await startWindow($, s, AUTO_WARM_MS, s.every)
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    await arm($, s)
    // The countdown chip restarts with every turn, armed or not.
    if (s.hasBand) $.ui.invalidate('ui.render')
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      disarm(s)
      await arm($, s)
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return r
  })
}
