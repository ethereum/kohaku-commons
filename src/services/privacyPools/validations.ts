import { formatUnits, parseUnits } from 'viem'
import { getTokenAmount } from '../../libs/portfolio/helpers'
import { getSanitizedAmount } from '../../libs/transfer/amount'

type ValidateReturnType = {
  success: boolean
  message: string
}

/**
 * Validates the deposit amount for privacy pools
 * Checks:
 * 1. Amount is greater than 0
 * 2. Amount meets the minimum deposit requirement
 * 3. Amount doesn't exceed the maximum deposit limit
 * 4. User has sufficient balance
 */
export const validatePrivacyPoolsDepositAmount = (
  amount: string,
  selectedAsset: any, // TokenResult type
  minDeposit: bigint,
  maxDeposit: bigint
): ValidateReturnType => {
  const sanitizedAmount = getSanitizedAmount(amount, selectedAsset.decimals)

  if (!(sanitizedAmount && sanitizedAmount.length)) {
    return {
      success: false,
      message: ''
    }
  }

  if (!(sanitizedAmount && Number(sanitizedAmount) > 0)) {
    // The user has entered an amount that is outside of the valid range.
    if (Number(amount) > 0 && selectedAsset.decimals && selectedAsset.decimals > 0) {
      return {
        success: false,
        message: `The amount must be greater than 0.${'0'.repeat(selectedAsset.decimals - 1)}1.`
      }
    }

    return {
      success: false,
      message: 'The amount must be greater than 0.'
    }
  }

  try {
    if (sanitizedAmount && selectedAsset && selectedAsset.decimals) {
      if (Number(sanitizedAmount) < 1 / 10 ** selectedAsset.decimals)
        return {
          success: false,
          message: 'Token amount too low.'
        }

      const currentAmount: bigint = parseUnits(sanitizedAmount, selectedAsset.decimals)

      // Check minimum deposit requirement
      if (currentAmount < minDeposit) {
        const minDepositFormatted = formatUnits(minDeposit, selectedAsset.decimals)
        return {
          success: false,
          message: `Minimum deposit is ${minDepositFormatted} ${selectedAsset.symbol || 'tokens'}.`
        }
      }

      // Check maximum deposit limit
      if (currentAmount > maxDeposit) {
        const maxDepositFormatted = formatUnits(maxDeposit, selectedAsset.decimals)
        return {
          success: false,
          message: `Maximum deposit is ${maxDepositFormatted} ${selectedAsset.symbol || 'tokens'}.`
        }
      }

      // Check user has sufficient balance
      if (currentAmount > getTokenAmount(selectedAsset)) {
        return {
          success: false,
          message: 'Insufficient amount.'
        }
      }
    }
  } catch (e) {
    console.error(e)

    return {
      success: false,
      message: 'Invalid amount.'
    }
  }

  return { success: true, message: '' }
}
