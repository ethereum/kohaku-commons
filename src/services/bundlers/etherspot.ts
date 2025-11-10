/* eslint-disable class-methods-use-this */
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { BUNDLER, ETHERSPOT } from '../../consts/bundlers'
import { Network } from '../../interfaces/network'
import { Bundler } from './bundler'
import { GasSpeeds, UserOpStatus } from './types'

export class Etherspot extends Bundler {
  public shouldReestimateBeforeBroadcast(network: Network): boolean {
    throw new Error('Method not implemented.')
  }

  protected getUrl(network: Network): string {
    return `https://rpc.etherspot.io/v2/${network.chainId.toString()}?api-key=${
      process.env.REACT_APP_ETHERSPOT_API_KEY
    }`
  }

  protected async getGasPrice(network: Network): Promise<GasSpeeds> {
    const provider = this.getProvider(network, true)
    const prices: any = await provider.send('skandha_getGasPrice', [])
    return {
      slow: {
        maxFeePerGas: prices.maxFeePerGas,
        maxPriorityFeePerGas: prices.maxPriorityFeePerGas
      },
      medium: {
        maxFeePerGas: prices.maxFeePerGas,
        maxPriorityFeePerGas: prices.maxPriorityFeePerGas
      },
      fast: {
        maxFeePerGas: prices.maxFeePerGas,
        maxPriorityFeePerGas: prices.maxPriorityFeePerGas
      },
      ape: {
        maxFeePerGas: prices.maxFeePerGas,
        maxPriorityFeePerGas: prices.maxPriorityFeePerGas
      }
    }
  }

  public async getStatus(network: Network, userOpHash: string): Promise<UserOpStatus> {
    const provider = this.getProvider(network, true)

    const status = await provider.send('eth_getUserOperationByHash', [userOpHash]).catch((e) => {
      console.log('etherspot eth_getUserOperationByHash returned an error')
      console.log(e)

      return null
    })

    if (!status) {
      return {
        status: 'not_found'
      }
    }

    return {
      status: 'found',
      transactionHash: status.transactionHash
    }
  }

  public getName(): BUNDLER {
    return ETHERSPOT
  }
}
