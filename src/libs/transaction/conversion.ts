import { formatUnits, parseUnits } from 'ethers'
import { convertTokenPriceToBigInt } from '../../utils/numbers/formatters'
import { FromToken } from '../../interfaces/swapAndBridge'
import { getSanitizedAmount } from '../transfer/amount'

const CONVERSION_PRECISION = 16
const CONVERSION_PRECISION_POW = BigInt(10 ** CONVERSION_PRECISION)

export interface ConversionResult {
  tokenAmount: string
  fiatAmount: string
}

const handleFiatToTokenConversion = (
  amount: string,
  amountFormatted: string,
  tokenPrice: string,
  fromSelectedToken: FromToken | null
): ConversionResult => {
  if (typeof fromSelectedToken?.decimals !== 'number') {
    return { tokenAmount: '', fiatAmount: amount }
  }

  const amountInFiatDecimals = amount.split('.')[1]?.length || 0
  const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(Number(tokenPrice))

  const amountInFiatBigInt = parseUnits(amountFormatted, amountInFiatDecimals)

  const tokenAmount = formatUnits(
    (amountInFiatBigInt * CONVERSION_PRECISION_POW) / tokenPriceBigInt,
    amountInFiatDecimals + CONVERSION_PRECISION - tokenPriceDecimals
  )

  return { tokenAmount, fiatAmount: amount }
}

const handleTokenToFiatConversion = (
  amount: string,
  amountFormatted: string,
  tokenPrice: string,
  fromSelectedToken: FromToken | null
): ConversionResult => {
  if (!fromSelectedToken) {
    return { tokenAmount: amount, fiatAmount: '' }
  }

  const sanitizedFieldValue = getSanitizedAmount(amountFormatted, fromSelectedToken.decimals)
  const formattedAmount = parseUnits(sanitizedFieldValue, fromSelectedToken.decimals)

  if (!formattedAmount) {
    return { tokenAmount: amount, fiatAmount: '' }
  }

  const { tokenPriceBigInt, tokenPriceDecimals } = convertTokenPriceToBigInt(Number(tokenPrice))

  const fiatAmount = formatUnits(
    formattedAmount * tokenPriceBigInt,
    fromSelectedToken.decimals + tokenPriceDecimals
  )

  return { tokenAmount: amount, fiatAmount }
}

export const handleAmountConversion = (
  amount: string,
  amountFormatted: string,
  fromSelectedToken: FromToken | null,
  isInFiatMode: boolean,
  hardCodedCurrency: string
): ConversionResult => {
  if (amount === '') {
    return { tokenAmount: '', fiatAmount: '' }
  }

  const tokenPrice = fromSelectedToken?.priceIn.find(
    (p) => p.baseCurrency === hardCodedCurrency
  )?.price

  if (!tokenPrice) {
    return { tokenAmount: amount, fiatAmount: '' }
  }

  if (isInFiatMode) {
    return handleFiatToTokenConversion(
      amount,
      amountFormatted,
      String(tokenPrice),
      fromSelectedToken
    )
  }

  return handleTokenToFiatConversion(amount, amountFormatted, String(tokenPrice), fromSelectedToken)
}
