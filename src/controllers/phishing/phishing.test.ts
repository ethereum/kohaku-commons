import fetch from 'node-fetch'

import { expect } from '@jest/globals'

import { produceMemoryStore } from '../../../test/helpers'
import { mockWindowManager } from '../../../test/helpers/window'
import { Storage } from '../../interfaces/storage'
import { StorageController } from '../storage/storage'
import { PhishingController } from './phishing'

const storage: Storage = produceMemoryStore()
const storageCtrl = new StorageController(storage)

const windowManager = mockWindowManager().windowManager

let phishing: PhishingController
const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000
describe('PhishingController', () => {
  beforeEach(async () => {
    await storageCtrl.set('phishingDetection', {
      timestamp: twentyFourHoursAgo,
      // actual blacklisted domains by MetaMask/eth-phishing-detect
      metamaskBlacklist: [
        'go-blast2l.xyz',
        'insta-dapp.net',
        'l2blast-check.xyz',
        'lihea.build',
        'lidofinance.one',
        'owlto-v2.online',
        'swlifi.org',
        'pndlifi.com'
      ],
      phantomBlacklist: []
    })
    phishing = new PhishingController({ storage: storageCtrl, fetch, windowManager })
    await phishing.initialLoadPromise
  })
  test.skip('should initialize', async () => {
    expect(phishing).toBeDefined()
  })
  test('should fetch lists from github', async () => {
    const storedPhishingDetection = await storageCtrl.get('phishingDetection', {
      timestamp: null,
      metamaskBlacklist: [],
      phantomBlacklist: []
    })
    expect(storedPhishingDetection).not.toBe(null)
    expect(phishing.lastStorageUpdate).not.toBe(null)
    if ((phishing.lastStorageUpdate as number) > twentyFourHoursAgo) {
      expect(phishing.blacklistLength).toBeGreaterThan(
        storedPhishingDetection!.metamaskBlacklist.length
      )
    } else {
      expect(phishing.blacklistLength).toEqual(storedPhishingDetection!.metamaskBlacklist.length)
    }
  })
  test.skip('should load and update blacklists and correctly check for blacklisted urls', async () => {
    expect(await phishing.getIsBlacklisted('https://elisium.it')).toBe(true)
    expect(await phishing.getIsBlacklisted('https://lihea.build')).toBe(true)
    expect(await phishing.getIsBlacklisted('https://safe.com')).toBe(false)
  })
  test.skip('should send correct url status to the UI', async () => {
    const sendWindowUiMessageSpy = jest.spyOn(windowManager, 'sendWindowUiMessage')
    await phishing.sendIsBlacklistedToUi('https://elisium.it')
    expect(sendWindowUiMessageSpy).toHaveBeenCalledWith({ hostname: 'BLACKLISTED' })
    sendWindowUiMessageSpy.mockClear()
    await phishing.sendIsBlacklistedToUi('https://lihea.build')
    expect(sendWindowUiMessageSpy).toHaveBeenCalledWith({ hostname: 'BLACKLISTED' })
    sendWindowUiMessageSpy.mockClear()
    await phishing.sendIsBlacklistedToUi('https://safe.com')
    expect(sendWindowUiMessageSpy).toHaveBeenCalledWith({ hostname: 'NOT_BLACKLISTED' })
  })
})
