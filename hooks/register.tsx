import type { Register } from 'claude-code'

// Piper (a Python venv) and its voices live outside the mod so mod edits never
// touch them. Set READ_ALOUD_PIPER_DIR to keep them elsewhere; without Piper the
// mod falls back to the built-in Windows voice.
const PIPER_DIR_PS = "$(if ($env:READ_ALOUD_PIPER_DIR) { $env:READ_ALOUD_PIPER_DIR } else { Join-Path $env:USERPROFILE '.claude\\read-aloud-piper' })"

// Reads the answer from stdin, speaks it chunk by chunk: the next chunk is
// synthesized while the current one plays.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$text = [Console]::In.ReadToEnd()',
  '$root = ' + PIPER_DIR_PS,
  "$exe = Join-Path $root 'venv\\Scripts\\python.exe'",
  "$model = Join-Path $root ('voices\\' + $env:READ_ALOUD_VOICE + '.onnx')",
  "if (-not ((Test-Path $exe) -and (Test-Path $model))) {",
  '  Add-Type -AssemblyName System.Speech',
  '  $v = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  $v.Rate = [int]$env:READ_ALOUD_RATE',
  '  $v.Speak($text)',
  '  exit',
  '}',
  "$tmp = Join-Path $env:TEMP ('read-aloud-' + $PID)",
  'New-Item -ItemType Directory -Force $tmp | Out-Null',
  '$chunks = New-Object System.Collections.Generic.List[string]',
  "$cur = ''",
  "foreach ($s in [regex]::Split($text, '(?<=[.!?])\\s+')) {",
  "  if ($cur.Length -gt 0 -and ($cur.Length + $s.Length) -gt 300) { $chunks.Add($cur); $cur = '' }",
  "  $cur = ($cur + ' ' + $s).Trim()",
  '}',
  'if ($cur.Length -gt 0) { $chunks.Add($cur) }',
  'function Synth($i) {',
  '  $in = "$tmp\\$i.txt"',
  '  [IO.File]::WriteAllText($in, $chunks[$i], (New-Object Text.UTF8Encoding $false))',
  '  Start-Process $exe -ArgumentList @(\'-m\', \'piper\', \'-m\', "`"$model`"", \'--length-scale\', $env:READ_ALOUD_LENGTH, \'-f\', "`"$tmp\\$i.wav`"") -RedirectStandardInput $in -RedirectStandardError "$tmp\\$i.err" -WindowStyle Hidden -PassThru',
  '}',
  'try {',
  '  if ($chunks.Count -gt 0) { $p = Synth 0 }',
  '  for ($i = 0; $i -lt $chunks.Count; $i++) {',
  '    $p.WaitForExit()',
  '    $next = $null',
  '    if ($i + 1 -lt $chunks.Count) { $next = Synth ($i + 1) }',
  '    (New-Object System.Media.SoundPlayer "$tmp\\$i.wav").PlaySync()',
  '    $p = $next',
  '  }',
  '} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }',
].join('\n')

const MAX_CHARS = 3000
// Speaking rate: -10 (slowest) to 10 (fastest), 0 is normal.
const DEFAULT_RATE = 3
const RATE_KEY = 'rate'
const DEFAULT_VOICE = 'en_US-mike-medium'
const VOICE_KEY = 'voice'
const LAST_KEY = 'last'

const clampRate = (n: number): number => Math.max(-10, Math.min(10, Math.round(n)))
// Piper stretches time by length_scale: below 1 is faster.
const lengthScale = (rate: number): string => (0.93 ** rate).toFixed(2)

// Turn markdown into something that sounds right when spoken, and keep
// secrets, paths and links out of the speaker.
const clean = (md: string): string =>
  md
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, ' secret omitted ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, 'secret omitted')
    .replace(/\b[0-9a-fA-F]{64,}\b/g, 'secret omitted')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\b[A-Za-z]:\\[^\s]*/g, 'a file path')
    .replace(/(?:^|[\s(])\/(?:Users|home|etc|var|opt|usr|tmp)\/\S*/g, ' a file path')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// Cut to the last sentence end inside the limit rather than mid-word.
const truncate = (text: string): string => {
  if (text.length <= MAX_CHARS) return text
  const head = text.slice(0, MAX_CHARS)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  return end > MAX_CHARS / 2 ? head.slice(0, end + 1) : head
}

// The `$` a hook receives.
type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]

async function readRate($: Engine): Promise<number> {
  const stored = await $.store.get(RATE_KEY)
  return typeof stored === 'number' ? clampRate(stored) : DEFAULT_RATE
}

async function readVoice($: Engine): Promise<string> {
  const stored = await $.store.get(VOICE_KEY)
  return typeof stored === 'string' && /^[\w.-]+$/.test(stored) ? stored : DEFAULT_VOICE
}

// What to say when a dialog needs the person: tools that ask rather than
// request permission get their own wording.
const announcement = (tool: string, input: unknown): string => {
  if (tool === 'AskUserQuestion') {
    const questions = (input as { questions?: { question?: unknown }[] } | null)?.questions ?? []
    const asked = questions.map(q => (typeof q.question === 'string' ? clean(q.question) : '')).filter(Boolean)
    return truncate(['Claude has a question for you.', ...asked].join(' '))
  }
  if (tool === 'ExitPlanMode') return 'Claude has a plan for you to review.'
  return 'Claude needs your permission.'
}

let isEnabled = true
let stopSpeech: (() => void) | undefined
let lastPermissionAt = 0

// Speaks `text`, replacing anything already being spoken.
async function speak($: Engine, text: string): Promise<void> {
  stopSpeech?.()
  await $.store.set(LAST_KEY, text)
  const rate = await readRate($)
  const env = {
    READ_ALOUD_VOICE: await readVoice($),
    READ_ALOUD_LENGTH: lengthScale(rate),
    READ_ALOUD_RATE: String(rate),
  }
  const iterator = $.process
    .spawn({ argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], input: text, env })
    [Symbol.asyncIterator]()
  const stop = () => {
    void iterator.return?.(undefined as never)
    if (stopSpeech === stop) stopSpeech = undefined
  }
  stopSpeech = stop
  void (async () => {
    try {
      while (!(await iterator.next()).done) {}
    } catch {
      // speech is best effort
    } finally {
      if (stopSpeech === stop) stopSpeech = undefined
    }
  })()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speak',
      description: 'Toggle reading answers aloud; "stop", "replay", "selected", "rate <-10..10>", "voice [name]"',
    })
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const args = e.args?.trim() ?? ''
    if (args.startsWith('rate')) {
      const value = args.slice(4).trim()
      if (value === '') return { text: `Speech rate is ${await readRate($)} (-10 slowest to 10 fastest; 0 is normal).` }
      const n = Number(value)
      if (!Number.isFinite(n)) return { text: 'Usage: /speak rate <-10..10>' }
      const rate = clampRate(n)
      await $.store.set(RATE_KEY, rate)
      return { text: `Speech rate set to ${rate}.` }
    }
    if (args.startsWith('voice')) {
      const name = args.slice(5).trim()
      const listing = await $.process.run([
        'powershell', '-NoProfile', '-NonInteractive', '-Command',
        `$root = ${PIPER_DIR_PS}; (Get-ChildItem (Join-Path $root 'voices') -Filter *.onnx -ErrorAction SilentlyContinue).BaseName`,
      ])
      const voices = listing.stdout.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
      if (name === '') {
        return { text: `Voice is ${await readVoice($)}. Installed: ${voices.join(', ') || 'none'}.` }
      }
      if (!voices.includes(name)) return { text: `No voice "${name}". Installed: ${voices.join(', ') || 'none'}.` }
      await $.store.set(VOICE_KEY, name)
      return { text: `Voice set to ${name}.` }
    }
    if (args === 'selected') {
      const selection = await $.ui.selection()
      const text = selection ? truncate(clean(selection.text)) : ''
      if (!text) return { text: 'Nothing is selected. Highlight text with the mouse, then run /speak selected.' }
      await speak($, text)
      return { text: 'Reading the selected text.' }
    }
    if (args === 'replay') {
      const last = await $.store.get(LAST_KEY)
      if (typeof last !== 'string' || last === '') return { text: 'Nothing has been spoken yet.' }
      await speak($, last)
      return { text: 'Replaying the last thing spoken.' }
    }
    if (args === 'stop') {
      stopSpeech?.()
      return { text: 'Stopped speaking.' }
    }
    isEnabled = !isEnabled
    if (!isEnabled) stopSpeech?.()
    return { text: `Read-aloud is ${isEnabled ? 'on' : 'off'}.` }
  })

  // A new prompt means the old answer is stale: silence it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) stopSpeech?.()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!isEnabled || e.agentId !== undefined || e.reason !== 'answer') return result

    const text = truncate(clean(e.answer))
    if (text) await speak($, text)
    return result
  })

  // Heard, never decided: the dialog is the engine's. Skipped while speech is
  // playing, and at most once every ten seconds when requests come in a burst.
  on('classic.PermissionRequest', async ($, e, next) => {
    const now = Date.now()
    if (isEnabled && stopSpeech === undefined && now - lastPermissionAt > 10_000) {
      lastPermissionAt = now
      await speak($, announcement(e.tool_name, e.tool_input))
    }
    return next(e)
  })

  on('session.end', async (_$, e, next) => {
    stopSpeech?.()
    return next(e)
  })
}
