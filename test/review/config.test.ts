import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

/** Regression for: `WS_URL=` / `PRIVATE_KEY=` / `EXECUTOR_ADDRESS=` in .env (dotenv yields '') failed validation although the settings are optional. */
describe('loadConfig with empty optional .env values', () => {
  it('treats WS_URL= as unset (polling, no WebSocket endpoints)', () => {
    const cfg = loadConfig({ WS_URL: '', WS_URLS: '' })
    expect(cfg.WS_URL).toBeUndefined()
    expect(cfg.wsUrls).toEqual([])
  })
  it('treats PRIVATE_KEY= / EXECUTOR_ADDRESS= as unset in DRY_RUN', () => {
    const cfg = loadConfig({ PRIVATE_KEY: '', EXECUTOR_ADDRESS: '', SEND_RPC_URLS: '', DRY_RUN: 'true' })
    expect(cfg.PRIVATE_KEY).toBeUndefined()
    expect(cfg.EXECUTOR_ADDRESS).toBeUndefined()
    expect(cfg.sendRpcUrls).toEqual([cfg.RPC_URL])
  })
  it('still requires them when DRY_RUN=false and still rejects malformed values', () => {
    expect(() => loadConfig({ PRIVATE_KEY: '', DRY_RUN: 'false' })).toThrow(/PRIVATE_KEY/)
    expect(() => loadConfig({ WS_URL: 'not a url' })).toThrow()
    expect(() => loadConfig({ EXECUTOR_ADDRESS: '0x12' })).toThrow()
  })
  it('bounds GAS_LIMIT to [21000, 16777216]', () => {
    expect(loadConfig({ GAS_LIMIT: '21000' }).GAS_LIMIT).toBe(21_000)
    expect(loadConfig({ GAS_LIMIT: '16777216' }).GAS_LIMIT).toBe(16_777_216)
    expect(() => loadConfig({ GAS_LIMIT: '20999' })).toThrow()
    expect(() => loadConfig({ GAS_LIMIT: '16777217' })).toThrow()
  })
})
