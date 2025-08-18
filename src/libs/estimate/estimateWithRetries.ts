import wait from '../../utils/wait'

export async function estimateWithRetries<T>(
  fetchRequests: () => Promise<any>[],
  timeoutType: string,
  errorCallback: Function,
  timeoutInMill: number = 10000,
  counter: number = 0
): Promise<T | Error> {
  // stop the execution on 5 fails;
  if (counter >= 5)
    return new Error(
      'Estimation failure, retrying in a couple of seconds. If this issue persists, please check your internet connection, change your RPC provider or contact Ambire support'
    )

  const santinelTimeoutErr = {}
  const estimationTimeout = new Promise((resolve) => {
    setTimeout(() => {
      resolve(santinelTimeoutErr)
    }, timeoutInMill)
  })

  const result = await Promise.race([Promise.all(fetchRequests()), estimationTimeout])

  // retry on a timeout
  if (result === santinelTimeoutErr) {
    const incremented = counter + 1

    // display a timeout error only on the first try

    switch (timeoutType) {
      case 'estimation-deployless':
        errorCallback({
          level: 'major',
          message: 'Estimating gas limits from the RPC timed out.',
          error: new Error('Estimation.sol deployless timeout')
        })
        break

      case 'estimation-bundler':
        errorCallback({
          level: 'major',
          message: 'Estimating gas limits from the bundler timed out.',
          error: new Error('Budler gas limit estimation timeout')
        })
        break
      case 'estimation-eoa':
        errorCallback({
          level: 'major',
          message: 'Estimating gas limits for EOA account from the RPC timed out.',
          error: new Error('Budler gas limit estimation timeout')
        })
        break

      default:
        break
    }

    return estimateWithRetries(
      fetchRequests,
      timeoutType,
      errorCallback,
      timeoutInMill,
      incremented
    )
  }

  // if one of the calls returns an error and the error is a connectivity error, retry
  // Otherwise return the error
  const error = Array.isArray(result) ? result.find((res) => res instanceof Error) : null

  if (error) {
    if (error.cause === 'ConnectivityError') {
      errorCallback({
        level: 'expected',
        message: 'Estimating the transaction failed because of a network error.',
        error
      })

      await wait(5000)

      return estimateWithRetries(
        fetchRequests,
        timeoutType,
        errorCallback,
        timeoutInMill,
        counter + 1
      )
    }
  }

  return result as T
}
