import { AMBIRE_ACCOUNT_FACTORY } from '../../consts/deploy'
import { networks } from '../../consts/networks'
import { Account, AccountStates } from '../../interfaces/account'
import { Network } from '../../interfaces/network'
import { getBaseAccount } from '../../libs/account/getBaseAccount'
import { getAccountState } from '../../libs/accountState/accountState'
import { getRpcProvider } from '../provider'
import { BundlerSwitcher } from './bundlerSwitcher'
import { DevBundlerSwitcher } from './DevBundlerSwitcher'

const base = networks.find((n) => n.chainId === 8453n)!
const avalanche = networks.find((n) => n.chainId === 43114n)!

const smartAccDeployed: Account = {
  addr: '0x8E5F6c1F0b134657A546932C3eC9169E1633a39b',
  initialPrivileges: [
    [
      '0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ]
  ],
  creation: {
    factoryAddr: AMBIRE_ACCOUNT_FACTORY,
    bytecode:
      '0x7f00000000000000000000000000000000000000000000000000000000000000027ff33cc417366b7e38d2706a67ab46f85465661c28b864b521441180d15df82251553d602d80604d3d3981f3363d3d373d3d3d363d731cde6a53e9a411eaaf9d11e3e8c653a3e379d5355af43d82803e903d91602b57fd5bf3',
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000'
  },
  associatedKeys: ['0xBd84Cc40a5b5197B5B61919c22A55e1c46d2A3bb'],
  preferences: {
    label: 'test',
    pfp: '0x8E5F6c1F0b134657A546932C3eC9169E1633a39b'
  }
}
const providers = Object.fromEntries(
  networks.map((network) => [network.chainId, getRpcProvider(network)])
)
const getAccountsInfo = async (accounts: Account[]): Promise<AccountStates> => {
  const result = await Promise.all(
    networks.map((network) =>
      getAccountState(providers[network.chainId.toString()], network, accounts)
    )
  )
  const states = accounts.map((acc: Account, accIndex: number) => {
    return [
      acc.addr,
      Object.fromEntries(
        networks.map((network: Network, netIndex: number) => {
          return [network.chainId, result[netIndex][accIndex]]
        })
      )
    ]
  })
  return Object.fromEntries(states)
}

describe('bundler switcher: switch cases', () => {
  it('should switch when sign account op is in a ready to sign state and there are extra bundlers to switch to', async () => {
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const switcher = new BundlerSwitcher(base, () => {
      return false
    })
    expect(switcher.hasControllerForbiddenUpdates()).toBe(false)
    expect(switcher.canSwitch(baseAcc)).toBe(true)
  })
})

describe('bundler switcher: no switch cases', () => {
  it('should not switch when sign account op is in a signing state', async () => {
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const switcher = new BundlerSwitcher(base, () => {
      return true
    })
    expect(switcher.hasControllerForbiddenUpdates()).toBe(true)
    expect(switcher.canSwitch(baseAcc)).toBe(false)
  })
  it('should not switch when there is no extra bundler to switch to', async () => {
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const switcher = new BundlerSwitcher(avalanche, () => {
      return false
    })
    expect(switcher.hasControllerForbiddenUpdates()).toBe(false)
    expect(switcher.canSwitch(baseAcc)).toBe(false)
  })
  it('should not switch when there is no available bundler to switch to', async () => {
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const switcher = new DevBundlerSwitcher(
      base,
      () => {
        return false
      },
      true
    )
    expect(switcher.hasControllerForbiddenUpdates()).toBe(false)
    expect(switcher.canSwitch(baseAcc)).toBe(false)
  })
  it('should switch on an estimation error if there is a bundler available', async () => {
    const accountStates = await getAccountsInfo([smartAccDeployed])
    const accountState = accountStates[smartAccDeployed.addr][base.chainId.toString()]
    const baseAcc = getBaseAccount(smartAccDeployed, accountState, [], base)
    const switcher = new DevBundlerSwitcher(base, () => {
      return false
    })
    expect(switcher.hasControllerForbiddenUpdates()).toBe(false)
    expect(switcher.canSwitch(baseAcc)).toBe(true)
  })
})
