import { ZeroAddress } from 'ethers'

import { RPCProvider } from 'interfaces/provider'
import AmbireFactory from '../../../contracts/compiled/AmbireFactory.json'
import { AMBIRE_ACCOUNT_FACTORY, DEPLOYLESS_SIMULATION_FROM } from '../../consts/deploy'
import { getSmartAccount, getSpoof } from '../account/account'
import { callToTuple } from '../accountOp/accountOp'
import { getActivatorCall } from '../userOperation/userOperation'
import { DeploylessMode, fromDescriptor } from './deployless'

// simulate a deployless call to the given provider.
// if the call is successful, it means Ambire smart accounts are supported
// on the given network
export async function getSASupport(
  provider: RPCProvider
): Promise<{ addressMatches: boolean; supportsStateOverride: boolean }> {
  const smartAccount = await getSmartAccount(
    [
      {
        addr: DEPLOYLESS_SIMULATION_FROM,
        hash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      }
    ],
    []
  )
  const deploylessOptions = {
    blockTag: 'latest',
    from: DEPLOYLESS_SIMULATION_FROM,
    // very important to send to the AMBIRE_ACCOUNT_FACTORY
    // or else the SA address won't match
    to: AMBIRE_ACCOUNT_FACTORY,
    mode: DeploylessMode.StateOverride
  }
  const deployless = fromDescriptor(provider, AmbireFactory, true)
  let supportsStateOverride = true
  const result = await deployless
    .call(
      'deployAndExecute',
      [
        smartAccount.creation!.bytecode,
        smartAccount.creation!.salt,
        [callToTuple(getActivatorCall(smartAccount.addr))],
        getSpoof(smartAccount)
      ],
      deploylessOptions
    )
    .catch((e: any) => {
      if (e.message.includes('no response')) {
        throw new Error('no response')
      }

      // if there's an error, return the zero address indicating that
      // our smart accounts will most likely not work on this chain
      supportsStateOverride = false
      return [ZeroAddress]
    })

  return {
    addressMatches: result[0] === smartAccount.addr,
    supportsStateOverride
  }
}
