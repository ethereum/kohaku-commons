export enum ErrorType {
  /** Error due to network connectivity issues when making HTTP requests */
  ConnectivityError = 'ConnectivityError',
  /** Reference, Type, Syntax and Range errors (JS/TS) */
  CodeError = 'CodeError',
  /** Error due to contract reverting, identified by prefix 0x08c379a0 */
  RevertError = 'RevertError',
  /** Error due to contract panic, identified by prefix 0x4e487b71 */
  PanicError = 'PanicError',
  /** Error originating from a relayer call */
  RelayerError = 'RelayerError',
  /** Error originating from the Paymaster (our Relayer) */
  PaymasterError = 'PaymasterError',
  /** Error during bundler estimation or broadcast */
  BundlerError = 'BundlerError',
  /** Custom contract errors */
  CustomError = 'CustomError',
  /** Error from an RPC call */
  RpcError = 'RPCError',
  /** Error that cannot be decoded */
  UnknownError = 'UnknownError',
  /** Error due to the user rejecting a transaction */
  UserRejectionError = 'UserRejectionError',
  /** Error due to an inner call failure during estimation */
  InnerCallFailureError = 'InnerCallFailureError'
}

export type DecodedError = {
  type: ErrorType
  reason: string | null
  data: string | null
}

export type ErrorHandler = {
  matches: (data: string, error: Error) => boolean
  handle: (data: string, error: Error) => DecodedError
}
