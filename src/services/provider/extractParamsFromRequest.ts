import { PerformActionRequest } from 'ethers'

/**
 * Safely extracts parameters from a PerformActionRequest based on the method type.
 * This replaces the unsafe Object.values(req).slice(1) approach.
 */
export function extractParamsFromRequest(req: PerformActionRequest): unknown[] {
  switch (req.method) {
    case 'broadcastTransaction':
      return [req.signedTransaction]
    case 'call':
      return [req.transaction, req.blockTag]
    case 'chainId':
      return []
    case 'estimateGas':
      return [req.transaction]
    case 'getBalance':
      return [req.address, req.blockTag]
    case 'getBlock':
      if ('blockHash' in req) {
        return [req.blockHash, req.includeTransactions]
      }
      return [req.blockTag, req.includeTransactions]
    case 'getBlockNumber':
      return []
    case 'getCode':
      return [req.address, req.blockTag]
    case 'getGasPrice':
      return []
    case 'getLogs':
      return [req.filter]
    case 'getStorage':
      return [req.address, req.position, req.blockTag]
    case 'getTransaction':
      return [req.hash]
    case 'getTransactionCount':
      return [req.address, req.blockTag]
    case 'getTransactionReceipt':
      return [req.hash]
    case 'getTransactionResult':
      return [req.hash]
    default:
      // This should never happen with proper typing, but provides a fallback
      throw new Error(`Unknown method: ${(req as any).method}`)
  }
}
