import { describe, expect, it } from 'vitest'

import { getTrustedOrigin } from '../origin'

describe('origin utils', () => {
  it('allows localhost origins', () => {
    expect(getTrustedOrigin('http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('allows https localhost origins', () => {
    expect(getTrustedOrigin('https://localhost:5273')).toBe('https://localhost:5273')
    expect(getTrustedOrigin('https://127.0.0.1:5273')).toBe('https://127.0.0.1:5273')
  })

  it('allows the production AIRI origin', () => {
    expect(getTrustedOrigin('https://airi.moeru.ai')).toBe('https://airi.moeru.ai')
  })

  it('rejects private LAN Vite dev origins unless explicitly listed', () => {
    expect(getTrustedOrigin('https://10.0.0.129:5273')).toBe('')
    expect(getTrustedOrigin('https://198.18.0.1:5273')).toBe('')
    expect(getTrustedOrigin('https://192.168.1.5:5273')).toBe('')

    const extra = ['https://10.0.0.129:5273', 'https://198.18.0.1:5273', 'https://192.168.1.5:5273']
    expect(getTrustedOrigin('https://10.0.0.129:5273', extra)).toBe('https://10.0.0.129:5273')
    expect(getTrustedOrigin('https://198.18.0.1:5273', extra)).toBe('https://198.18.0.1:5273')
    expect(getTrustedOrigin('https://192.168.1.5:5273', extra)).toBe('https://192.168.1.5:5273')
  })

  it('rejects untrusted origins', () => {
    expect(getTrustedOrigin('https://example.com')).toBe('')
  })
})
