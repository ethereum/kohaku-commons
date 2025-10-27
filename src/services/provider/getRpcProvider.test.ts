/* eslint-disable @typescript-eslint/no-use-before-define */

import { describe, expect, test } from '@jest/globals'
import { JsonRpcProvider } from 'ethers'
import { networks } from '../../consts/networks'
import { BrowserProvider } from './BrowserProvider'

function getConfigByName(name: string) {
  const config = networks.find((n) => n.name === name)

  if (!config) {
    throw new Error(`Network ${JSON.stringify(name)} not found in networks`)
  }

  return config
}

/**
 * For these tests, we need to use the real getRpcProvider function, not the globally mocked one.
 */
function getRpcProvider(config: any) {
  const { getRpcProvider: realGetRpcProvider } = jest.requireActual('./getRpcProvider')
  return realGetRpcProvider(config)
}

describe('getRpcProvider', () => {
  test('should return JsonRpcProvider when useHelios is false', () => {
    const provider = getRpcProvider({
      ...getConfigByName('Ethereum'),
      useHelios: false
    })
    expect(provider).toBeInstanceOf(JsonRpcProvider)
  })

  test('should return BrowserProvider when useHelios is true', () => {
    const provider = getRpcProvider({
      ...getConfigByName('Ethereum'),
      useHelios: true
    })
    expect(provider).toBeInstanceOf(BrowserProvider)
  })
})
