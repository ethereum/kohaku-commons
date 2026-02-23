/* eslint-disable no-underscore-dangle */
import { Network } from '../../interfaces/network'
import { RPCProviders } from '../../interfaces/provider'
import { getRpcProvider } from '../../services/provider'
import EventEmitter from '../eventEmitter/eventEmitter'
import { NetworksController } from '../networks/networks'

/**
 * The ProvidersController manages RPC providers, enabling the extension to communicate with the blockchain.
 * Each network requires an initialized JsonRpcProvider, and the provider must be reinitialized whenever network.selectedRpcUrl changes.
 */
export class ProvidersController extends EventEmitter {
  #networks: NetworksController

  providers: RPCProviders = {}

  // Holds the initial load promise, so that one can wait until it completes
  initialLoadPromise: Promise<void>

  constructor(networks: NetworksController) {
    super()

    this.#networks = networks
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.initialLoadPromise = this.#load()
  }

  get isInitialized() {
    return this.#networks.isInitialized && !!Object.keys(this.providers).length
  }

  async #load() {
    await this.#networks.initialLoadPromise
    this.#networks.allNetworks.forEach((n) => this.setProvider(n))
    this.emitUpdate()
  }

  setProvider(network: Network) {
    const provider = this.providers[network.chainId.toString()]
    const desiredProviderKind = network.rpcProvider ?? 'rpc'

    // Update provider when RPC URL or provider kind changes (or if missing).
    if (!provider ||
      provider?._getConnection().url !== network.selectedRpcUrl ||
      provider?.rpcProvider !== desiredProviderKind
    ) {
      const oldRPC = this.providers[network.chainId.toString()]

      // If an RPC fails once it will try to reconnect every second. If we don't destroy the old RPC it will keep trying to reconnect forever.
      try {
        if (oldRPC) oldRPC.destroy()
      } catch (e) {
        // no need to do anything; try/catch is just in case a double destroy is attempted
      }

      const newProvider = getRpcProvider(network)

      // If the provider supports checkpoint updates, subscribe and persist in network config
      if ('onCheckpointUpdate' in newProvider) {
        newProvider.onCheckpointUpdate(async (heliosCheckpoint: string) => {
          await this.#networks.updateNetwork({ heliosCheckpoint }, network.chainId)
        })
      }

      this.providers[network.chainId.toString()] = newProvider
    }
  }

  updateProviderIsWorking(chainId: bigint, isWorking: boolean) {
    if (!this.providers[chainId.toString()]) return
    if (this.providers[chainId.toString()].isWorking === isWorking) return

    this.providers[chainId.toString()].isWorking = isWorking
    this.emitUpdate()
  }

  removeProvider(chainId: bigint) {
    if (!this.providers[chainId.toString()]) return

    this.providers[chainId.toString()]?.destroy()
    delete this.providers[chainId.toString()]
    this.emitUpdate()
  }

  toJSON() {
    return {
      ...this,
      ...super.toJSON(),
      isInitialized: this.isInitialized
    }
  }
}
