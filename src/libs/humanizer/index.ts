import humanizerInfo from '../../consts/humanizer/humanizerInfo.json'
import { Message } from '../../interfaces/userRequest'
import { AccountOp } from '../accountOp/accountOp'
import { parse, stringify } from '../richJson/richJson'
import {
  HumanizerCallModule,
  HumanizerMeta,
  HumanizerOptions,
  IrCall,
  IrMessage
} from './interfaces'
import {
  eip7702AuthorizationModule,
  ensMessageModule,
  entryPointModule,
  erc20Module,
  erc721Module,
  legendsMessageModule,
  openseaMessageModule,
  permit2Module,
  snapshotModule,
  zealyMessageModule
} from './messageModules'
import OneInchModule from './modules/1Inch'
import { aaveHumanizer } from './modules/Aave'
import AcrossModule from './modules/Across'
import { airdropsModule } from './modules/Airdrops'
import asciiModule from './modules/AsciiModule'
import curveModule from './modules/Curve'
import { deploymentModule } from './modules/Deployment'
import { embeddedAmbireOperationHumanizer } from './modules/embeddedAmbireOperationHumanizer'
import { ensModule } from './modules/ENS'
import fallbackHumanizer from './modules/FallbackHumanizer'
import gasTankModule from './modules/GasTankModule'
import GuildModule from './modules/Guild'
import KyberSwap from './modules/KyberSwap'
import legendsModule from './modules/Legends'
import { LidoModule } from './modules/Lido'
import { LifiModule } from './modules/Lifi'
import { openSeaModule } from './modules/OpenSea'
import PancakeModule from './modules/Pancake'
import { postProcessing } from './modules/PostProcessing/postProcessModule'
import preProcessHumanizer from './modules/PreProcess'
import privilegeHumanizer from './modules/Privileges'
import recoveryManagerHumanizer from './modules/RecoveryManager'
import singletonFactory from './modules/SingletonFactory'
import { SocketModule } from './modules/Socket'
import sushiSwapModule from './modules/Sushiswap'
import { genericErc20Humanizer, genericErc721Humanizer } from './modules/Tokens'
import traderJoeModule from './modules/TraderJoe'
import { uniswapHumanizer } from './modules/Uniswap'
import { WALLETModule } from './modules/WALLET'
import wrappingModule from './modules/Wrapping'

// from most generic to least generic
// the final humanization is the final triggered module
export const humanizerCallModules: HumanizerCallModule[] = [
  preProcessHumanizer,
  embeddedAmbireOperationHumanizer,
  deploymentModule,
  genericErc721Humanizer,
  genericErc20Humanizer,
  LidoModule,
  gasTankModule,
  airdropsModule,
  uniswapHumanizer,
  curveModule,
  traderJoeModule,
  KyberSwap,
  SocketModule,
  LifiModule,
  AcrossModule,
  OneInchModule,
  PancakeModule,
  wrappingModule,
  aaveHumanizer,
  WALLETModule,
  privilegeHumanizer,
  recoveryManagerHumanizer,
  sushiSwapModule,
  legendsModule,
  singletonFactory,
  ensModule,
  GuildModule,
  openSeaModule,
  asciiModule,
  fallbackHumanizer,
  postProcessing
]

// from least generic to most generic
// the final visualization and warnings are from the first triggered module
const humanizerTMModules = [
  erc20Module,
  erc721Module,
  permit2Module,
  entryPointModule,
  legendsMessageModule,
  ensMessageModule,
  openseaMessageModule,
  zealyMessageModule,
  eip7702AuthorizationModule,
  snapshotModule
]

const humanizeAccountOp = (_accountOp: AccountOp, options: HumanizerOptions): IrCall[] => {
  const accountOp = parse(stringify(_accountOp))
  const humanizerOptions: HumanizerOptions = {
    ...options,
    chainId: accountOp.chainId
  }

  let currentCalls: IrCall[] = accountOp.calls
  humanizerCallModules.forEach((hm) => {
    try {
      currentCalls = hm(accountOp, currentCalls, humanizerInfo as HumanizerMeta, humanizerOptions)
    } catch (error) {
      console.error(error)
      // No action is needed here; we only set `currentCalls` if the module successfully resolves the calls.
    }
  })
  return currentCalls
}

const humanizeMessage = (_message: Message): IrMessage => {
  const message = parse(stringify(_message))

  try {
    // runs all modules and takes the first non empty array
    const { fullVisualization, warnings } =
      humanizerTMModules.map((m) => m(message)).filter((p) => p.fullVisualization?.length)[0] || {}

    return { ...message, fullVisualization, warnings }
  } catch (error) {
    console.error(error)
    return message
  }
}

export { humanizeAccountOp, humanizeMessage }
