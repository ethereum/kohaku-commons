import { ErrorHumanizerError } from '../../libs/errorHumanizer/types'

export const MAYAN_BRIDGE = 'mayan'

export const HUMANIZED_ERRORS: ErrorHumanizerError[] = [
  {
    reasons: ['could not find token'],
    message:
      'The token you are trying to swap is not supported by our service provider. Please select another token.'
  },
  {
    reasons: ['The same token cannot be used as both the source and destination'],
    message: 'The same token cannot be used as both the source and destination.'
  },
  {
    reasons: ['is invalid or in deny list'],
    message: 'This token is not supported by our service provider.'
  }
]
