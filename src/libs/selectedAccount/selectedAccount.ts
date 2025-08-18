import { getAddress } from 'ethers'

import {
  SelectedAccountPortfolio,
  SelectedAccountPortfolioByNetworks,
  SelectedAccountPortfolioByNetworksNetworkState,
  SelectedAccountPortfolioState,
  SelectedAccountPortfolioTokenResult
} from '../../interfaces/selectedAccount'
import { safeTokenAmountAndNumberMultiplication } from '../../utils/numbers/formatters'
import {
  AccountState as DefiPositionsAccountState,
  AssetType,
  NetworkState as DefiPositionsNetworkState,
  PositionsByProvider
} from '../defiPositions/types'
import {
  AccountState,
  CollectionResult,
  NetworkSimulatedAccountOp,
  NetworkState,
  TokenResult
} from '../portfolio/interfaces'

const isTokenPriceWithinHalfPercent = (price1: number, price2: number): boolean => {
  const diff = Math.abs(price1 - price2)
  const threshold = 0.005 * Math.max(Math.abs(price1), Math.abs(price2))
  return diff <= threshold
}

/**
 * Adds the defi positions tokens that aren't handled by the portfolio.
 * Also calculates the total balance of the defi positions so it can be added to the total balance.
 */
export const calculateDefiPositions = (
  chainId: string,
  portfolioTokens: (TokenResult & {
    latestAmount?: bigint
    pendingAmount?: bigint
  })[],
  defiPositionsAccountState?: DefiPositionsAccountState
): {
  defiPositionsBalance: number
  tokens: (TokenResult & {
    latestAmount?: bigint
    pendingAmount?: bigint
  })[]
} | null => {
  const areDefiPositionsNotInitialized =
    !defiPositionsAccountState || Object.keys(defiPositionsAccountState).length === 0

  const isInternalChain = chainId === 'gasTank' || chainId === 'rewards'

  if (isInternalChain || areDefiPositionsNotInitialized) {
    return null
  }

  const defiPositionsNetworkState = defiPositionsAccountState[chainId]

  const tokens = portfolioTokens
  let networkBalance = 0
  const positions = defiPositionsNetworkState || {}

  positions.positionsByProvider?.forEach((posByProv: PositionsByProvider) => {
    posByProv.positions.forEach((pos) => {
      if (pos.additionalData?.pool?.controller) {
        const tokenInPortfolio = tokens.find((t) => {
          return (
            t.address.toLowerCase() ===
              (pos.additionalData?.pool?.controller || '').toLowerCase() &&
            t.chainId.toString() === chainId &&
            !t.flags.rewardsType &&
            !t.flags.onGasTank
          )
        })

        // Skip if the controller token is already in the portfolio and has a price in USD
        // (custom tokens with no price can be added. In that case add the pos to the total balance)
        if (
          tokenInPortfolio &&
          tokenInPortfolio.amount !== 0n &&
          tokenInPortfolio.priceIn.find((p) => p.baseCurrency === 'usd' && p.price !== 0) &&
          !tokenInPortfolio.flags.isHidden
        )
          return
      }

      let shouldAddPositionUSDAmountToTheTotalBalance = true

      pos.assets.filter(Boolean).forEach((a) => {
        // if this "if" is ever removed, ensure that the defiTokenType flag is set correctly
        // for these asset types
        if (a.type === AssetType.Liquidity || a.type === AssetType.Reward) return

        if (a.protocolAsset && a.protocolAsset?.name) {
          const protocolTokenInPortfolio = tokens.find((t) => {
            return (
              t.address.toLowerCase() === (a.protocolAsset?.address || '').toLowerCase() &&
              t.chainId.toString() === chainId &&
              !t.flags.rewardsType &&
              !t.flags.onGasTank
            )
          })
          if (!protocolTokenInPortfolio) {
            const positionAsset: SelectedAccountPortfolioTokenResult = {
              amount: a.amount,
              latestAmount: a.amount,
              // Only list the borrowed asset with no price
              priceIn: a.type === AssetType.Collateral ? [a.priceIn] : [],
              decimals: Number(a.protocolAsset!.decimals),
              address: a.protocolAsset!.address,
              symbol: a.protocolAsset!.symbol,
              name: a.protocolAsset!.name,
              chainId: BigInt(chainId),
              flags: {
                canTopUpGasTank: false,
                isFeeToken: false,
                onGasTank: false,
                rewardsType: null,
                defiTokenType: a.type
                // @BUG: defi positions tokens can't be hidden and can be added as custom
                // because processTokens is called in the portfolio
                // Issue: https://github.com/AmbireTech/ambire-app/issues/3971
              }
            }
            const tokenBalanceUSD = positionAsset.priceIn[0]?.price
              ? Number(
                  safeTokenAmountAndNumberMultiplication(
                    BigInt(positionAsset.amount),
                    positionAsset.decimals,
                    positionAsset.priceIn[0].price
                  )
                )
              : undefined

            networkBalance += tokenBalanceUSD || 0
            tokens.push(positionAsset)
          } else if (
            // If the asset isn't of type Borrow and has no price in USD
            // we get the price from defi positions
            a.type !== AssetType.Borrow &&
            (!protocolTokenInPortfolio.priceIn.length ||
              protocolTokenInPortfolio.priceIn[0]?.price === 0)
          ) {
            // Add a price.
            // IMPORTANT: This must be done before calculating the token balance USD
            protocolTokenInPortfolio.priceIn = [a.priceIn]
            protocolTokenInPortfolio.flags.defiTokenType = a.type

            const tokenBalanceUSD = protocolTokenInPortfolio.priceIn[0]?.price
              ? Number(
                  safeTokenAmountAndNumberMultiplication(
                    BigInt(
                      protocolTokenInPortfolio.amountPostSimulation ||
                        protocolTokenInPortfolio.amount
                    ),
                    protocolTokenInPortfolio.decimals,
                    protocolTokenInPortfolio.priceIn[0].price
                  )
                )
              : undefined

            networkBalance += tokenBalanceUSD || 0
          }
        }

        // search the asset in the portfolio tokens
        const tokenInPortfolio = tokens.find((t) => {
          const priceUSD = t.priceIn.find(
            ({ baseCurrency }: { baseCurrency: string }) => baseCurrency.toLowerCase() === 'usd'
          )?.price

          const tokenBalanceUSD = priceUSD
            ? Number(
                safeTokenAmountAndNumberMultiplication(
                  BigInt(t.amountPostSimulation || t.amount),
                  t.decimals,
                  priceUSD
                )
              )
            : undefined

          if (a.protocolAsset?.symbol && a.protocolAsset.address) {
            return (
              t.chainId.toString() === chainId &&
              !t.flags.rewardsType &&
              !t.flags.onGasTank &&
              t.address === getAddress(a.protocolAsset.address)
            )
          }

          // If the token or asset don't have a value we MUST! not compare them
          // by value as that would lead to false positives
          if (!tokenBalanceUSD || !a.value) return false

          // If there is no protocol asset we have to fallback to finding the token
          // by symbol and chainId. In that case we must ensure that the value of the two
          // assets is similar
          return (
            // chains should match
            t.chainId.toString() === chainId &&
            !t.flags.rewardsType &&
            !t.flags.onGasTank &&
            // the portfolio token should contain the original asset symbol
            t.symbol.toLowerCase().includes(a.symbol.toLowerCase()) &&
            // but should be a different token symbol
            t.symbol.toLowerCase() !== a.symbol.toLowerCase() &&
            // and prices should have no more than 0.5% diff
            isTokenPriceWithinHalfPercent(tokenBalanceUSD || 0, a.value || 0)
          )
        })

        if (!tokenInPortfolio || tokenInPortfolio?.flags.isHidden) return

        // Note: There is an edge case where only one of the assets is handled
        // by the portfolio, but we flip the flag, which means that we won't
        // add the value of the position to the total balance. This will make the
        // displayed balance (REAL BALANCE - the value of the missing asset).
        if (a.type === AssetType.Collateral) shouldAddPositionUSDAmountToTheTotalBalance = false
        // Remove the price of borrow tokens and ensure that the token is marked as Borrow
        else if (a.type === AssetType.Borrow) {
          tokenInPortfolio.priceIn = []
          tokenInPortfolio.flags.defiTokenType = AssetType.Borrow
        }
      })

      // We differ from wallets like Rabby in the way we add the value of
      // positions to the total balance - we don't deduct the value of borrowed
      // assets. Instead we use the collateral of positions or the position value in USD if
      // the collateral is not available.
      // Knowing that, it's confusing why we add the value of the position here. That is because
      // we add the collateral value by adding the tokens to the portfolio and flipping this flag
      // to false. If the portfolio doesn't have the token and we don't know the protocol asset
      // there is no way to add the value of the collateral tokens to the total balance.
      // In that case we add the value of the position to the total balance in order to not confuse the user.
      if (shouldAddPositionUSDAmountToTheTotalBalance) {
        networkBalance += pos.additionalData.positionInUSD || 0
      }
    })
  })

  return {
    tokens,
    defiPositionsBalance: networkBalance
  }
}

export const stripPortfolioState = (portfolioState: AccountState) => {
  const strippedState: SelectedAccountPortfolioState = {}

  Object.keys(portfolioState).forEach((chainId) => {
    const networkState = portfolioState[chainId]
    if (!networkState) return

    if (!networkState.result) {
      strippedState[chainId] = networkState
      return
    }

    // A trick to exclude specific keys
    const { tokens, collections, tokenErrors, priceCache, hintsFromExternalAPI, ...result } =
      networkState.result

    strippedState[chainId] = { ...networkState, result }
  })

  return strippedState
}

export const isNetworkReady = (networkData: NetworkState | undefined) => {
  return networkData && (networkData.isReady || networkData?.criticalError)
}

/**
 * Adds the latest and pending amount to the tokens array.
 * Also returns a flag indicating whether there is a token with an amount > 0
 */
export const calculateTokensArray = (
  chainId: string,
  latestTokens: TokenResult[],
  pendingTokens: TokenResult[],
  isPendingValid: boolean
): {
  tokens: SelectedAccountPortfolioTokenResult[]
  hasTokenWithAmount: boolean
} => {
  let hasTokenWithAmount = false

  if (chainId === 'gasTank' || chainId === 'rewards') {
    return {
      tokens: latestTokens,
      hasTokenWithAmount: false
    }
  }
  // If the pending state is older or there are no pending tokens
  // we shouldn't trust it to build the tokens array
  if (isPendingValid && pendingTokens.length) {
    const tokenList = pendingTokens.map((pendingToken) => {
      let latestAmount: bigint | undefined

      const latestToken = latestTokens.find((latest) => {
        return latest.address === pendingToken.address
      })

      if (!hasTokenWithAmount && !!(latestAmount || pendingToken.amount)) hasTokenWithAmount = true

      return {
        ...pendingToken,
        latestAmount: latestToken?.amount,
        pendingAmount: pendingToken.amount
      }
    })

    return {
      tokens: tokenList,
      hasTokenWithAmount
    }
  }

  const tokenList = latestTokens.map((token) => {
    if (!hasTokenWithAmount && !!token.amount) hasTokenWithAmount = true

    return {
      ...token,
      // Add only latestAmount to the tokens
      latestAmount: token.amount
    }
  })

  return {
    tokens: tokenList,
    hasTokenWithAmount
  }
}

/**
 * calculateSelectedAccountPortfolio is called after every portfolio update and we don't want to recalculate
 * the same network data if it hasn't changed.
 */
export const getIsRecalculationNeeded = (
  pastAccountPortfolioWithDefiPositionsNetworkState: SelectedAccountPortfolioByNetworksNetworkState,
  latestNetworkData: NetworkState | undefined,
  pendingNetworkData: NetworkState | undefined,
  // Can be pending or selected
  selectedNetworkData: NetworkState | undefined,
  defiPositionsNetworkState: DefiPositionsNetworkState | undefined
): boolean => {
  if (
    !latestNetworkData ||
    !pendingNetworkData ||
    !selectedNetworkData ||
    !pastAccountPortfolioWithDefiPositionsNetworkState ||
    !defiPositionsNetworkState
  ) {
    return true
  }

  // Never recalculate if either the portfolio or defi positions are loading
  // as that would reset isAllReady to false
  if (
    latestNetworkData?.isLoading ||
    pendingNetworkData.isLoading ||
    defiPositionsNetworkState.isLoading
  ) {
    return false
  }

  const pastAccountOp = pastAccountPortfolioWithDefiPositionsNetworkState.simulatedAccountOp
  const networkDataAccountOp = selectedNetworkData?.accountOps?.[0]

  // If there is or was an account op we must recalculate the portfolio
  // on every update to ensure that the simulations are correct
  if (pastAccountOp || networkDataAccountOp) return true

  const hasPortfolioUpdated =
    pastAccountPortfolioWithDefiPositionsNetworkState.blockNumber !==
    selectedNetworkData.result?.blockNumber

  const areDefiPositionsUpdated =
    pastAccountPortfolioWithDefiPositionsNetworkState.defiPositionsUpdatedAt !==
    defiPositionsNetworkState?.updatedAt

  return hasPortfolioUpdated || areDefiPositionsUpdated
}

/**
 * Calculates the selected account portfolio (divided by networks).
 * It combines the latest and pending states, checks the status of the networks-
 * whether they are ready or not, loading etc.
 * It also updates the portfolio with defi positions.
 * It's optimized to avoid unnecessary recalculations by comparing the new portfolio/defi positions state
 * with the previous one. (by nonce, block number, simulation status, defi positions updated at timestamp)
 */
export function calculateSelectedAccountPortfolioByNetworks(
  latestStateSelectedAccount: AccountState,
  pendingStateSelectedAccount: AccountState,
  pastAccountPortfolioWithDefiPositions: SelectedAccountPortfolioByNetworks,
  portfolioStartedLoadingAtTimestamp: number | null,
  defiPositionsAccountState: DefiPositionsAccountState,
  isLoadingFromScratch: boolean
): {
  selectedAccountPortfolioByNetworks: SelectedAccountPortfolioByNetworks
  isAllReady: boolean
  isReadyToVisualize: boolean
} {
  const now = Date.now()
  const shouldShowPartialResult =
    portfolioStartedLoadingAtTimestamp && now - portfolioStartedLoadingAtTimestamp > 5000
  const newAccountPortfolioWithDefiPositions: SelectedAccountPortfolioByNetworks =
    pastAccountPortfolioWithDefiPositions

  const hasLatest = latestStateSelectedAccount && Object.keys(latestStateSelectedAccount).length
  const hasPending = pendingStateSelectedAccount && Object.keys(pendingStateSelectedAccount).length
  let isAllReady = !!hasLatest
  let isReadyToVisualize = false
  let hasTokensWithAmount = false

  if (!hasLatest && !hasPending) {
    return {
      selectedAccountPortfolioByNetworks: {},
      isAllReady: false,
      isReadyToVisualize: false
    }
  }

  let selectedAccountData = latestStateSelectedAccount

  /**
   * Replaces the latest state if the following conditions are true:
   * - There is no critical error in the pending state.
   * - The pending block number is newer than the latest OR we have a signed acc op (because of simulation).
   */
  const validSelectedAccountPendingState: AccountState = {}
  const simulatedAccountOps: NetworkSimulatedAccountOp = {}

  Object.keys(pendingStateSelectedAccount).forEach((network) => {
    const pendingNetworkData = pendingStateSelectedAccount[network]
    const latestNetworkData = latestStateSelectedAccount[network]

    // Compare the block numbers to determine if the pending state is newer
    if (latestNetworkData?.result?.blockNumber && pendingNetworkData?.result?.blockNumber) {
      const isPendingNewer =
        pendingNetworkData.result.blockNumber! >= latestNetworkData.result.blockNumber!

      if (
        !pendingNetworkData.criticalError &&
        (isPendingNewer || !!pendingNetworkData.accountOps?.length)
      ) {
        validSelectedAccountPendingState[network] = pendingNetworkData
      }
    }

    // Store the simulated account op
    const accountOp = pendingNetworkData?.accountOps?.[0]

    if (accountOp) {
      simulatedAccountOps[network] = accountOp
    }
  })

  if (hasPending && Object.keys(validSelectedAccountPendingState).length > 0) {
    selectedAccountData = {
      ...selectedAccountData,
      ...validSelectedAccountPendingState
    }
  }

  Object.keys(selectedAccountData).forEach((network: string) => {
    const networkData = selectedAccountData[network]

    const defiPositionsNetworkState = defiPositionsAccountState[network]
    const pastAccountPortfolioWithDefiPositionsNetworkState =
      pastAccountPortfolioWithDefiPositions[network]

    const shouldRecalculateState = getIsRecalculationNeeded(
      pastAccountPortfolioWithDefiPositionsNetworkState,
      latestStateSelectedAccount[network],
      pendingStateSelectedAccount[network],
      networkData,
      defiPositionsNetworkState
    )

    if (!shouldRecalculateState) {
      newAccountPortfolioWithDefiPositions[network] =
        pastAccountPortfolioWithDefiPositionsNetworkState

      if (!hasTokensWithAmount) {
        hasTokensWithAmount = pastAccountPortfolioWithDefiPositionsNetworkState.tokens.some(
          ({ amount }) => amount > 0n
        )
      }

      return
    }

    const result = networkData?.result
    let tokensArray: SelectedAccountPortfolioTokenResult[] = []
    let collectionsArray: CollectionResult[] = []
    let networkTotal = 0

    if (
      networkData &&
      // The network must be ready
      isNetworkReady(networkData) &&
      !networkData?.isLoading &&
      !defiPositionsNetworkState?.isLoading
    ) {
      networkTotal = networkData?.result?.total?.usd || 0

      const latestTokens = latestStateSelectedAccount[network]?.result?.tokens || []
      const pendingTokens = pendingStateSelectedAccount[network]?.result?.tokens || []
      collectionsArray = result?.collections || []

      const { tokens, hasTokenWithAmount: hasTokensWithAmountOnNetwork } = calculateTokensArray(
        network,
        latestTokens,
        pendingTokens,
        !!validSelectedAccountPendingState[network]
      )
      tokensArray = tokens

      if (!hasTokensWithAmount && hasTokensWithAmountOnNetwork) {
        hasTokensWithAmount = true
      }

      const defiPositions = calculateDefiPositions(network, tokensArray, defiPositionsAccountState)

      // Replace the token list with the token list that has the defi tokens
      if (defiPositions?.tokens.length) {
        tokensArray = defiPositions?.tokens
      }

      // Add the defi positions balance to the total balance
      networkTotal += defiPositions?.defiPositionsBalance || 0

      // Update the cached network state when the network is completely loaded
      newAccountPortfolioWithDefiPositions[network] = {
        totalBalance: networkTotal,
        tokens: tokensArray,
        collections: collectionsArray,
        blockNumber: result?.blockNumber,
        defiPositionsUpdatedAt: defiPositionsAccountState[network]?.updatedAt,
        simulatedAccountOp: simulatedAccountOps[network]
      }
    } else if (isLoadingFromScratch) {
      isAllReady = false
    }
  })

  if ((shouldShowPartialResult && hasTokensWithAmount && !isAllReady) || isAllReady) {
    // Allow the user to operate with the tokens that have loaded
    isReadyToVisualize = true
  }

  return {
    isReadyToVisualize,
    isAllReady,
    selectedAccountPortfolioByNetworks: newAccountPortfolioWithDefiPositions
  }
}

/**
 * Calculates the selected account portfolio that is used by the UI and a
 * selected account portfolio divided by networks.
 * For more info see calculateSelectedAccountPortfolioByNetworks.
 */
export function calculateSelectedAccountPortfolio(
  latestStateSelectedAccount: AccountState,
  pendingStateSelectedAccount: AccountState,
  pastAccountPortfolioWithDefiPositions: SelectedAccountPortfolioByNetworks,
  portfolioStartedLoadingAtTimestamp: number | null,
  defiPositionsAccountState: DefiPositionsAccountState,
  isLoadingFromScratch: boolean
): {
  selectedAccountPortfolio: SelectedAccountPortfolio
  selectedAccountPortfolioByNetworks: SelectedAccountPortfolioByNetworks
} {
  const { selectedAccountPortfolioByNetworks, isAllReady, isReadyToVisualize } =
    calculateSelectedAccountPortfolioByNetworks(
      latestStateSelectedAccount,
      pendingStateSelectedAccount,
      pastAccountPortfolioWithDefiPositions,
      portfolioStartedLoadingAtTimestamp,
      defiPositionsAccountState,
      isLoadingFromScratch
    )

  const selectedAccountPortfolio: SelectedAccountPortfolio = {
    tokens: [],
    collections: [],
    totalBalance: 0,
    balancePerNetwork: {},
    isReadyToVisualize,
    isAllReady,
    networkSimulatedAccountOp: {},
    latest: stripPortfolioState(latestStateSelectedAccount),
    pending: stripPortfolioState(pendingStateSelectedAccount)
  }

  Object.keys(selectedAccountPortfolioByNetworks).forEach((chainId) => {
    const networkData = selectedAccountPortfolioByNetworks[chainId]
    if (!networkData) return

    if (networkData.simulatedAccountOp) {
      selectedAccountPortfolio.networkSimulatedAccountOp[chainId] = networkData.simulatedAccountOp
    }
    selectedAccountPortfolio.tokens.push(...networkData.tokens)
    selectedAccountPortfolio.collections.push(...networkData.collections)
    selectedAccountPortfolio.totalBalance += networkData.totalBalance || 0
    selectedAccountPortfolio.balancePerNetwork[chainId] = networkData.totalBalance || 0
  })

  return {
    selectedAccountPortfolio,
    selectedAccountPortfolioByNetworks
  }
}
