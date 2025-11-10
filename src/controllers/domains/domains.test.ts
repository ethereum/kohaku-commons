import { expect, jest } from '@jest/globals'

import { networks } from '../../consts/networks'
import { getRpcProvider } from '../../services/provider'
import { DomainsController } from './domains'

const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network)])
)

const ENS = {
  address: '0xC2E6dFcc2C6722866aD65F211D5757e1D2879337',
  name: 'elmoto.eth'
}

const ENS2 = {
  address: '0xf9D6794F16CDbdC5b4873AEdeF4dC69d8D5edcaD',
  name: 'josh.eth'
}

const NO_DOMAINS_ADDRESS = '0x1b9B9813C5805A60184091956F8b36E752272a93'

describe('Domains', () => {
  const domainsController = new DomainsController(providers)

  it('should reverse lookup (ENS)', async () => {
    await domainsController.reverseLookup(ENS.address)

    expect(domainsController.domains[ENS.address].ens).toBe(ENS.name)
  })
  it('should save resolved reverse lookup', () => {
    const { name, address } = ENS2
    const type = 'ens'

    domainsController.saveResolvedReverseLookup({ address, name, type })

    expect(domainsController.domains[address].ens).toBe(name)
  })
  it('reverse lookup should expire after 24 hours', async () => {
    const { address, name } = ENS2

    await domainsController.reverseLookup(address)

    expect(domainsController.domains[address].ens).toBe(name)

    const timestampForwardInTime = new Date(Date.UTC(2028, 1, 1)).valueOf()

    Date.now = jest.fn(() => timestampForwardInTime)

    await domainsController.reverseLookup(address)

    expect(domainsController.domains[address].savedAt).toBe(timestampForwardInTime)
  })
  it('should not reverse lookup if already resolved', async () => {
    const { address } = ENS2

    await domainsController.reverseLookup(address)

    const savedAtFirstCall = domainsController.domains[address].savedAt

    expect(domainsController.domains[address].savedAt).toBe(savedAtFirstCall)

    await domainsController.reverseLookup(address)

    expect(domainsController.domains[address].savedAt).toBe(savedAtFirstCall)
  })
  it('should set ens to null if no domain is found', async () => {
    await domainsController.reverseLookup(NO_DOMAINS_ADDRESS)

    expect(domainsController.domains[NO_DOMAINS_ADDRESS].ens).toBe(null)
  })
  it('should reverse multiple addresses', async () => {
    domainsController.domains = {}

    expect(Object.keys(domainsController.domains).length).toBe(0)

    await domainsController.batchReverseLookup([ENS.address, ENS2.address])

    expect(domainsController.domains[ENS.address].ens).toBe(ENS.name)
    expect(domainsController.domains[ENS2.address].ens).toBe(ENS2.name)
  })
})
