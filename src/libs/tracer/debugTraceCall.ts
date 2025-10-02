import { getAddress, Interface, JsonRpcProvider, toQuantity } from 'ethers'

import { RPCProvider } from 'interfaces/provider'
import AmbireAccount from '../../../contracts/compiled/AmbireAccount.json'
import AmbireFactory from '../../../contracts/compiled/AmbireFactory.json'
import BalanceGetter from '../../../contracts/compiled/BalanceGetter.json'
import NFTGetter from '../../../contracts/compiled/NFTGetter.json'
import { DEPLOYLESS_SIMULATION_FROM } from '../../consts/deploy'
import { EOA_SIMULATION_NONCE } from '../../consts/deployless'
import { Account, AccountOnchainState } from '../../interfaces/account'
import { getAccountDeployParams, getSpoof, isBasicAccount } from '../account/account'
import { AccountOp, callToTuple, getSignableCalls } from '../accountOp/accountOp'
import { DeploylessMode, fromDescriptor } from '../deployless/deployless'
import { getDeploylessOpts } from '../portfolio/getOnchainBalances'

const NFT_COLLECTION_LIMIT = 100
// if using EOA, use the first and only call of the account op
// if it's SA, make the data execute or deployAndExecute,
// set the spoof+addr and pass all the calls
function getFunctionParams(account: Account, op: AccountOp, accountState: AccountOnchainState) {
  if (isBasicAccount(account, accountState) && op.calls.length === 1) {
    const call = op.calls[0]
    return {
      to: call.to,
      value: toQuantity(call.value.toString()),
      data: call.data,
      from: op.accountAddr
    }
  }

  if (isBasicAccount(account, accountState)) {
    const saAbi = new Interface(AmbireAccount.abi)
    const callData = saAbi.encodeFunctionData('execute', [getSignableCalls(op), getSpoof(account)])
    return {
      to: account.addr,
      value: 0,
      data: callData,
      from: DEPLOYLESS_SIMULATION_FROM
    }
  }

  const saAbi = new Interface(AmbireAccount.abi)
  const factoryAbi = new Interface(AmbireFactory.abi)
  const callData = accountState.isDeployed
    ? saAbi.encodeFunctionData('execute', [getSignableCalls(op), getSpoof(account)])
    : factoryAbi.encodeFunctionData('deployAndExecute', [
        account.creation!.bytecode,
        account.creation!.salt,
        getSignableCalls(op),
        getSpoof(account)
      ])

  return {
    from: DEPLOYLESS_SIMULATION_FROM,
    to: accountState.isDeployed ? account.addr : account.creation!.factoryAddr,
    value: 0,
    data: callData
  }
}

export async function debugTraceCall(
  account: Account,
  op: AccountOp,
  provider: RPCProvider,
  accountState: AccountOnchainState,
  supportsStateOverride: boolean,
  overrideData?: any
): Promise<{ tokens: string[]; nfts: [string, bigint[]][] }> {
  const opts = {
    blockTag: 'latest',
    from: DEPLOYLESS_SIMULATION_FROM,
    mode: DeploylessMode.ProxyContract,
    isEOA: isBasicAccount(account, accountState),
    simulation: {
      accountOps: [op],
      account,
      state: accountState
    }
  }
  const deploylessOpts = getDeploylessOpts(account.addr, supportsStateOverride, opts)
  const [factory, factoryCalldata] = getAccountDeployParams(account)
  const simulationOps = [
    [
      !isBasicAccount(account, accountState) ? op.nonce : BigInt(EOA_SIMULATION_NONCE),
      op.calls.map(callToTuple)
    ]
  ]

  const params = getFunctionParams(account, op, accountState)
  const results: ({ erc: 20; address: string } | { erc: 721; address: string; tokenId: string })[] =
    await provider.send('debug_traceCall', [
      {
        to: params.to,
        value: toQuantity(params.value.toString()),
        data: params.data,
        from: params.from
      },
      'latest',
      {
        tracer: `{
          discovered: [],
          fault: function (log) {},
          step: function (log) {
            const found = this.discovered.map(ob => ob.address)
            if (log.contract && log.contract.getAddress() && found.indexOf(toHex(log.contract.getAddress())) === -1) {
              this.discovered.push({
                erc: 20,
                address: toHex(log.contract.getAddress())
              })
            }
            if (log.op.toString() === 'LOG4') {
              this.discovered.push({
                erc: 721,
                address: toHex(log.contract.getAddress()),
                tokenId: '0x' + log.stack.peek(5).toString(16)
              })
            }
          },
          result: function () {
            return this.discovered
          }
        }`,

        enableMemory: false,
        enableReturnData: true,
        disableStorage: true,
        stateOverrides: supportsStateOverride
          ? {
              // TODO: if it's an EOA, add the EOA state override data
              [params.from]: {
                balance: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
              },
              ...overrideData
            }
          : {}
      }
    ])

  const foundTokens = [
    ...new Set(results.filter((i) => i?.erc === 20).map((i) => getAddress(i.address)))
  ]
  const foundNftTransfersObject = results
    .filter((i) => i?.erc === 721)
    .reduce((res: { [address: string]: Set<bigint> }, i: any) => {
      if (!res[i?.address]) res[i?.address] = new Set()
      res[i.address].add(i.tokenId)
      return res
    }, {})
  const foundNftTransfers: [string, bigint[]][] = Object.entries(foundNftTransfersObject).map(
    ([address, id]) => [getAddress(address), Array.from(id).map((i) => BigInt(i))]
  )

  // we set the 3rd param to "true" as we don't need state override
  const deploylessTokens = fromDescriptor(provider, BalanceGetter, true)
  const deploylessNfts = fromDescriptor(provider, NFTGetter, true)

  const getNftsPromise = deploylessNfts.call(
    'simulateAndGetAllNFTs',
    [
      op.accountAddr,
      account.associatedKeys,
      foundNftTransfers.map(([address]) => address),
      foundNftTransfers.map(([, x]) => x),
      NFT_COLLECTION_LIMIT,
      factory,
      factoryCalldata,
      simulationOps
    ],
    deploylessOpts
  )

  const [[tokensWithErr], [before, after, , , , deltaAddressesMapping]] = await Promise.all([
    deploylessTokens.call('getBalances', [op.accountAddr, foundTokens], deploylessOpts),
    getNftsPromise
  ])

  const beforeNftCollections = before[0]
  const afterNftCollections = after[0]
  return {
    tokens: foundTokens.filter((addr, i) => tokensWithErr[i].error === '0x'),
    nfts: foundNftTransfers.filter((nft, i) => {
      if (beforeNftCollections[i][3] === '0x') return true
      const foundAfterToken = afterNftCollections.find(
        (t: any, j: number) =>
          deltaAddressesMapping[j].toLowerCase() === foundNftTransfers[i][0].toLowerCase()
      )
      if (!foundAfterToken || !foundAfterToken[0]) return false

      return foundAfterToken[0][3] === '0x'
    })
  }
}
