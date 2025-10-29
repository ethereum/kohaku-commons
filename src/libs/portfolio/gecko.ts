import { geckoIdMapper } from '../../consts/coingecko'
import { Network } from '../../interfaces/network'
import { QueueElement, Request } from './batcher'
import { paginate } from './pagination'

// max tokens per request; we seem to have faster results when it's lower
const BATCH_LIMIT = 40

export function geckoResponseIdentifier(tokenAddr: string, network: Network): string {
  return geckoIdMapper(tokenAddr, network) || tokenAddr.toLowerCase()
}

export function geckoRequestBatcher(queue: QueueElement[]): Request[] {
  const segments: { [key: string]: any[] } = {}

  // eslint-disable-next-line no-restricted-syntax
  for (const queueItem of queue) {
    const geckoId = geckoIdMapper(queueItem.data.address, queueItem.data.network)
    // If we can't determine the Gecko platform ID, we shouldn't make a request to price (cena.ambire.com)
    // since it would return nothing.
    // This can happen when adding a custom network that doesn't have a CoinGecko platform ID.
    // eslint-disable-next-line no-continue
    if (!geckoId && !queueItem.data.network.platformId) continue

    let segmentId: string = queueItem.data.baseCurrency

    if (geckoId) segmentId += ':natives'
    else segmentId += `:${queueItem.data.network.chainId}`

    if (!segments[segmentId]) segments[segmentId] = []
    segments[segmentId].push(queueItem)
  }
  // deduplicating is OK because we use a key-based mapping (responseIdentifier) to map the responses
  // @TODO deduplication should happen BEFORE the pagination but without dropping items from queueSegment
  const pages = Object.entries(segments)
    .map(([key, queueSegment]) =>
      paginate(queueSegment, BATCH_LIMIT).map((page) => ({ key, queueSegment: page }))
    )
    .flat(1)
  const dedup = (x: any[]) => x.filter((y, i) => x.indexOf(y) === i)
  return pages.map(({ key, queueSegment }) => {
    // This is OK because we're segmented by baseCurrency
    const baseCurrency = queueSegment[0]!.data.baseCurrency
    const geckoPlatform = queueSegment[0]!.data.network.platformId

    const mainApiUrl = 'https://cena.ambire.com'

    let url
    if (key.endsWith('natives'))
      url = `${mainApiUrl}/api/v3/simple/price?ids=${dedup(
        queueSegment.map((x) => geckoIdMapper(x.data.address, x.data.network))
      ).join('%2C')}&vs_currencies=${baseCurrency}`
    else
      url = `${mainApiUrl}/api/v3/simple/token_price/${geckoPlatform}?contract_addresses=${dedup(
        queueSegment.map((x) => x.data.address)
      ).join('%2C')}&vs_currencies=${baseCurrency}`
    return { url, queueSegment }
  })
}
