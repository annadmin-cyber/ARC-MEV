import pino from 'pino'

const level = process.env['LOG_LEVEL'] ?? 'info'
const pretty = process.env['LOG_PRETTY'] !== 'false' && process.stdout.isTTY

export const log = pino({
  level,
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
    : {}),
  serializers: {
    err: pino.stdSerializers.err,
  },
})

/** JSON.stringify replacer that renders bigint as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
