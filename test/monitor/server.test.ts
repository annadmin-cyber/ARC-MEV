import { afterEach, describe, expect, it } from 'vitest'
import { renderPage, startMonitorServer, type MonitorServer } from '../../src/monitor/server.js'
import { BotStats } from '../../src/monitor/stats.js'

describe('startMonitorServer', () => {
  let server: MonitorServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function start(stats = new BotStats()): Promise<MonitorServer> {
    server = await startMonitorServer(stats, { port: 0 })
    return server
  }

  it('listens on a free port of 127.0.0.1 and reports its URL', async () => {
    const s = await start()
    expect(s.port).toBeGreaterThan(0)
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`)
  })

  it('serves the page, the status JSON, the metrics and 404s elsewhere', async () => {
    const stats = new BotStats()
    stats.setStatic({ chainId: 5042, dryRun: true, executor: null, trackedPools: 3, cycles: 4, probePools: 0 })
    stats.onBlock({ block: 42n, timings: { logs: 1, eval: 2, sim: 3, send: 0 }, touched: 1, opportunities: 0, candidates: 0 })
    const s = await start(stats)

    const page = await fetch(`${s.url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('/api/status')
    expect(html).toContain('https://explorer.arc.io')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)

    const status = await fetch(`${s.url}/api/status`)
    expect(status.status).toBe(200)
    expect(status.headers.get('content-type')).toContain('application/json')
    const body = (await status.json()) as { lastBlock: string; blocksProcessed: number; static: { chainId: number } }
    expect(body.lastBlock).toBe('42')
    expect(body.blocksProcessed).toBe(1)
    expect(body.static.chainId).toBe(5042)

    const metrics = await fetch(`${s.url}/metrics`)
    expect(metrics.status).toBe(200)
    expect(metrics.headers.get('content-type')).toContain('text/plain')
    const text = await metrics.text()
    expect(text).toContain('arcmev_blocks_processed_total 1')
    expect(text).toContain('arcmev_last_block 42')

    const missing = await fetch(`${s.url}/nope`)
    expect(missing.status).toBe(404)
    const post = await fetch(`${s.url}/api/status`, { method: 'POST' })
    expect(post.status).toBe(405)
    expect((await fetch(`${s.url}/api/status?x=1`)).status).toBe(200)
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200)
  })

  it('stops accepting connections once closed', async () => {
    const s = await start()
    const url = s.url
    await s.close()
    server = undefined
    await expect(fetch(`${url}/api/status`)).rejects.toThrow()
  })

  it('embeds the explorer URL safely', () => {
    const html = renderPage('https://example.org/</script>')
    expect(html).not.toContain('</script>"')
    expect(html).toContain('"https://example.org/\\u003c/script>"')
  })
})
