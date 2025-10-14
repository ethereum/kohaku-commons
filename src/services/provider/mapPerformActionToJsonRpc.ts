import { PerformActionRequest } from 'ethers'

type JsonRpcTuple = [method: string, params: any[]]

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkType<T>(x: T) {}

function toHexQuantity(v: bigint | number | `0x${string}`): `0x${string}` {
  if (typeof v === 'bigint') return `0x${v.toString(16)}`
  if (typeof v === 'number') return `0x${v.toString(16)}`
  if (typeof v === 'string') {
    if (!v.startsWith('0x')) throw new Error(`Expected 0x-prefixed hex, got: ${v}`)
    return v as `0x${string}`
  }
  throw new Error(`Unsupported quantity type: ${typeof v}`)
}

export function mapPerformActionToJsonRpc(req: PerformActionRequest): JsonRpcTuple {
  switch (req.method) {
    case 'broadcastTransaction':
      // ethers non-standard -> standard send raw tx
      return ['eth_sendRawTransaction', [req.signedTransaction]]

    case 'call':
      // Helios: eth_call(tx, blockTag)
      return ['eth_call', [req.transaction, req.blockTag]]

    case 'chainId':
      return ['eth_chainId', []]

    case 'estimateGas':
      return ['eth_estimateGas', [req.transaction]]

    case 'getBalance':
      return ['eth_getBalance', [req.address, req.blockTag]]

    case 'getBlock':
      if ('blockTag' in req) {
        // by number/tag
        return ['eth_getBlockByNumber', [req.blockTag, req.includeTransactions]]
      }
      if ('blockHash' in req) {
        // by hash
        return ['eth_getBlockByHash', [req.blockHash, req.includeTransactions]]
      }
      // Should be unreachable because of the union, but keep defensive:
      throw new Error('getBlock request missing blockTag or blockHash')

    case 'getBlockNumber':
      return ['eth_blockNumber', []]

    case 'getCode':
      return ['eth_getCode', [req.address, req.blockTag]]

    case 'getGasPrice':
      return ['eth_gasPrice', []]

    case 'getLogs':
      return ['eth_getLogs', [req.filter]]

    case 'getStorage':
      // JSON-RPC expects the slot index as a hex *quantity* (no zero padding required)
      return ['eth_getStorageAt', [req.address, toHexQuantity(req.position), req.blockTag]]

    case 'getTransaction':
      return ['eth_getTransactionByHash', [req.hash]]

    case 'getTransactionCount':
      return ['eth_getTransactionCount', [req.address, req.blockTag]]

    case 'getTransactionReceipt':
      return ['eth_getTransactionReceipt', [req.hash]]

    case 'getTransactionResult':
      // ethers defines this helper, but there is no standard JSON-RPC "getTransactionResult".
      // Some stacks emulate it via tracing or post-mortem call semantics; Helios does not expose such an endpoint.
      // Throw so callers can decide how to handle (e.g., fall back to getTransactionReceipt + status).
      throw new Error(
        'getTransactionResult is not a standard JSON-RPC method and is not supported by Helios'
      )

    default: {
      checkType<never>(req) // ensures switch is exhaustive

      // Future-proof explicit failure so you notice new ethers actions
      // and can add a mapping if Helios supports the corresponding RPC.
      // (Also helps catch typos in upstream calls.)
      throw new Error(`Unsupported PerformActionRequest method: ${(req as any).method}`)
    }
  }
}
