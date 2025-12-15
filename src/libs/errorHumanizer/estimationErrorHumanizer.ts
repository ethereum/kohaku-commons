import EmittableError from '../../classes/EmittableError'
import ErrorHumanizerError from '../../classes/ErrorHumanizerError'
import ExternalSignerError from '../../classes/ExternalSignerError'
import { decodeError } from '../errorDecoder'
import { truncateReason } from '../errorDecoder/helpers'
import { DecodedError } from '../errorDecoder/types'
import { ESTIMATION_ERRORS, noPrefixReasons } from './errors'
import { getGenericMessageFromType, getHumanReadableErrorMessage } from './helpers'
import { humanizeEstimationOrBroadcastError } from './humanizeCommonCases'

export const MESSAGE_PREFIX = 'Transaction cannot be sent because'

const LAST_RESORT_ERROR_MESSAGE =
  'Transaction cannot be sent because of an unknown error. Please try again or contact Ambire support for assistance.'

function getPrefix(reason: string | null): string {
  if (!reason) return MESSAGE_PREFIX
  const hasNoPrefix = noPrefixReasons.filter((noPrefix) => reason.includes(noPrefix)).length
  return hasNoPrefix === 0 ? MESSAGE_PREFIX : ''
}

export function getHumanReadableEstimationError(e: Error | DecodedError) {
  console.log('[getHumanReadableEstimationError] START - Processing error', {
    errorType: e instanceof Error ? 'Error' : 'DecodedError',
    errorMessage: e instanceof Error ? e.message : (e as DecodedError).reason,
    errorName: e instanceof Error ? e.name : undefined,
    errorString: String(e)
  })

  // These errors should be thrown as they are
  // as they are already human-readable
  if (e instanceof EmittableError || e instanceof ExternalSignerError) {
    console.log('[getHumanReadableEstimationError] Emittable/ExternalSigner error - returning as-is')
    return new ErrorHumanizerError(e.message, {
      cause: typeof e.cause === 'string' ? e.cause : null,
      isFallbackMessage: false
    })
  }

  let isFallbackMessage = false
  const decodedError = e instanceof Error ? decodeError(e as Error) : (e as DecodedError)
  console.log('[getHumanReadableEstimationError] Decoded error', {
    type: decodedError.type,
    reason: decodedError.reason,
    origin: decodedError.origin
  })

  const commonError = humanizeEstimationOrBroadcastError(
    decodedError,
    getPrefix(decodedError.reason),
    e
  )
  let errorMessage = getHumanReadableErrorMessage(
    commonError,
    ESTIMATION_ERRORS,
    MESSAGE_PREFIX,
    decodedError,
    e
  )

  if (!errorMessage) {
    console.log('[getHumanReadableEstimationError] No specific error message found - using generic')
    isFallbackMessage = true
    errorMessage = getGenericMessageFromType(
      decodedError.type,
      decodedError.reason,
      MESSAGE_PREFIX,
      LAST_RESORT_ERROR_MESSAGE,
      e,
      false
    )
  }

  const result = new ErrorHumanizerError(errorMessage, {
    cause: decodedError.reason || (e instanceof Error ? truncateReason(e?.message) : ''),
    isFallbackMessage
  })

  console.log('[getHumanReadableEstimationError] Returning humanized error', {
    message: result.message,
    cause: result.cause,
    isFallbackMessage: result.isFallbackMessage
  })

  return result
}
