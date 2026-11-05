const mark = '[REDACTED]'
const local = 'A-Za-z0-9._%+-'
const domain = 'A-Za-z0-9.-'

const email = `[${local}]{1,64}@[${domain}]{1,240}\\.[A-Za-z]{2,24}`
const ssn = '(?<!\\d)\\d{3}-\\d{2}-\\d{4}(?!\\d)'
const card = '(?<!\\d)\\d(?:[ -]?\\d){12,18}(?!\\d)'
const pii = new RegExp(`${email}|${ssn}|${card}`, 'g')

// end of the buffer that could still grow into a match, or a match that could still get longer.
// ssn prefixes have the same shape as card prefixes, so the digit branch covers both
const tail = new RegExp(`(?:[${local}]{1,64}(?:@[${domain}]{0,265})?|(?<!\\d)\\d(?:[ -]?\\d){0,18}[ -]?)$`, 'g')
const maxTail = 64 + 1 + 265

function redactFrom(text: string, from: number) {
  let out = ''
  let pos = from
  pii.lastIndex = from
  for (let m; (m = pii.exec(text)); pos = pii.lastIndex) out += text.slice(pos, m.index) + mark
  return out + text.slice(pos)
}

export const redact = (text: string) => redactFrom(text, 0)

// streaming version: push() returns what is safe to send now and holds back only a possible
// match at the end, so the output always equals redact() of the whole text however it was chunked
export function createRedactor() {
  let buf = ''
  let ctx = 0

  return {
    push(chunk: string) {
      buf += chunk
      let pos = ctx
      let out = ''
      for (;;) {
        pii.lastIndex = pos
        const m = pii.exec(buf)
        tail.lastIndex = Math.max(pos, buf.length - maxTail)
        const hold = tail.exec(buf)?.index ?? buf.length
        if (!m || m.index >= hold) {
          out += buf.slice(pos, hold)
          pos = hold
          break
        }
        out += buf.slice(pos, m.index) + mark
        pos = m.index + m[0].length
      }

      // keep one already sent char so the (?<!\d) lookbehinds still see it
      ctx = Math.min(pos, 1)
      buf = buf.slice(pos - ctx)
      return out
    },

    end() {
      const out = redactFrom(buf, ctx)
      buf = ''
      ctx = 0
      return out
    },
  }
}
