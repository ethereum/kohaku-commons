import { AbiCoder, concat, toBeHex } from 'ethers'

import { describe, expect, test } from '@jest/globals'

import { addressOne } from '../../../test/config'
import { getRpcProvider } from '../../services/provider'
import { compile } from './compile'
import { Deployless, DeploylessMode } from './deployless'

const helloWorld = compile('HelloWorld', {
  contractsFolder: 'test/contracts'
})
const deployErrBin = '0x6080604052348015600f57600080fd5b600080fdfe'
const mainnetProvider = getRpcProvider(['https://invictus.ambire.com/ethereum'], 1n)
let deployless: Deployless

describe('Deployless', () => {
  test('should construct an object', () => {
    deployless = new Deployless(mainnetProvider, helloWorld.abi, helloWorld.bin)
    expect(deployless.isLimitedAt24kbData).toBe(true)
  })

  test('should not allow stateToOverride if mode is not state override', async () => {
    const localDeployless = new Deployless(mainnetProvider, helloWorld.abi, helloWorld.bin)
    await expect(
      localDeployless.call('helloWorld', [], {
        mode: DeploylessMode.ProxyContract,
        stateToOverride: {}
      })
    ).rejects.toThrow('state override passed but not requested')
  })

  /*
  test('should throw if StateOverride is requested but not supported', async () => {
    // @TODO we can't find a provider that doesn't support state override
    const noStateOverrideProvider = new JsonRpcProvider('https://rpc.gnosischain.com')
    const localDeployless = new Deployless(noStateOverrideProvider, helloWorld.abi, helloWorld.bin)
    await expect(localDeployless.call('helloWorld', [], {
      mode: DeploylessMode.StateOverride,
      stateToOverride: {}
    })).rejects.toThrow('state override requested but not supported')
  })
  */

  test('should invoke a method: proxy mode', async () => {
    const localDeployless = new Deployless(mainnetProvider, helloWorld.abi, helloWorld.bin)
    const [result] = await localDeployless.call('helloWorld', [], {
      mode: DeploylessMode.ProxyContract
    })
    expect(result).toBe('hello world')
    // We still haven't detected support for state override
    expect(localDeployless.isLimitedAt24kbData).toBe(true)
  })

  // test('should invoke a method: detect mode', async () => {
  //   deployless = new Deployless(mainnetProvider, helloWorld.abi, helloWorld.bin)
  //   const [result] = await deployless.call('helloWorld', [])
  //   expect(result).toBe('hello world')
  //   // We detected support for state override
  //   expect(deployless.isLimitedAt24kbData).toBe(false)
  // })

  test('should not alllow initializing with wrong deploy code', () => {
    expect.assertions(2)
    try {
      const success = new Deployless(mainnetProvider, helloWorld.abi, helloWorld.bin.slice(2))
      // the below should not happen
      expect(!!success).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe('contract code must start with 0x')
    }
    try {
      const success = new Deployless(
        mainnetProvider,
        helloWorld.abi,
        helloWorld.bin,
        helloWorld.bin.slice(2)
      )
      // the below should not happen
      expect(!!success).toBe(false)
    } catch (e: any) {
      expect(e.message).toBe('contract code (runtime) must start with 0x')
    }
  })

  // test('should not allow detect with another Provider', async () => {
  //   expect.assertions(1)
  //   const homesteadProvider = getDefaultProvider('homestead')
  //   const localDeployless = new Deployless(homesteadProvider, helloWorld.abi, helloWorld.bin)
  //   try {
  //     await localDeployless.call('helloWorld', [])
  //   } catch (e: any) {
  //     expect(e.message).toBe(
  //       'state override mode (or auto-detect) not available unless you use JsonRpcProvider'
  //     )
  //   }
  // })

  test('should deploy error: proxy mode', async () => {
    const localDeployless = new Deployless(mainnetProvider, helloWorld.abi, deployErrBin)
    expect.assertions(1)
    try {
      await localDeployless.call('helloWorld', [], { mode: DeploylessMode.ProxyContract })
    } catch (e: any) {
      expect(e.message).toBe('contract deploy failed')
    }
  })

  // test('should deploy error: state override mode', async () => {
  //   const localDeployless = new Deployless(mainnetProvider, helloWorld.abi, deployErrBin)
  //   expect.assertions(2)
  //   try {
  //     await localDeployless.call('helloWorld', [])
  //   } catch (e: any) {
  //     expect(e.message).toBe('contract deploy failed')
  //     // detection stil succeeded
  //     expect(localDeployless.isLimitedAt24kbData).toBe(false)
  //   }
  // })

  test('should deploy error: state override without detection', async () => {
    const localDeployless = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    // we should already be aware that we are not limited by the 24kb limit
    expect(localDeployless.isLimitedAt24kbData).toBe(false)
    const [result] = await localDeployless.call('helloWorld', [], {
      mode: DeploylessMode.StateOverride
    })
    expect(result).toBe('hello world')
    const [result2] = await localDeployless.call('helloWorld', [])
    expect(result2).toBe('hello world')
  })

  test.skip('should custom block tag', async () => {
    const localDeployless = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    expect.assertions(2)
    try {
      await localDeployless.call('helloWorld', [], { blockTag: '0x1' })
    } catch (e: any) {
      // we are relying on the fact that we do not have the SHR opcode in block 0x1
      const noSHR = 'invalid opcode: SHR'
      const notActivated = 'EVM error: NotActivated'
      const notAvailable = 'not available'
      expect(
        e.info.error.message.includes(noSHR) ||
          e.info.error.message.includes(notActivated) ||
          e.info.error.message.includes(notAvailable)
      ).toBe(true)
    }
    try {
      await localDeployless.call('helloWorld', [], {
        blockTag: '0x1',
        mode: DeploylessMode.ProxyContract
      })
    } catch (e: any) {
      // ethers wraps the error if we use the Provider; perhaps we should un-wrap it
      // fails with out-of-gas when wrapped in the ProxyContract mode (or invalid opcode: SHL)
      expect(
        e.info.error.message.includes('out of gas') ||
          e.info.error.message.includes('invalid opcode: SHL') ||
          e.info.error.message.includes('NotActivated')
      ).toBe(true)
    }
  })

  test('should throw an error for max 24 kb contract size in DeploylessMode.ProxyContract and not throw it in DeploylessMode.StateOverride', async () => {
    expect.assertions(1)
    const factory = compile('AmbireFactory')
    const abiCoder = new AbiCoder()
    const bytecodeAndArgs = toBeHex(
      concat([factory.bin, abiCoder.encode(['address'], [addressOne])])
    )
    let megaLargeCode = bytecodeAndArgs
    let i = 12
    while (i > 0) {
      megaLargeCode += bytecodeAndArgs.substring(2)
      i--
    }
    const contract = new Deployless(mainnetProvider, factory.abi, megaLargeCode, factory.binRuntime)
    try {
      await contract.call('deploy', [bytecodeAndArgs, '1234'], {
        mode: DeploylessMode.ProxyContract
      })
    } catch (e: any) {
      expect(e.message).toBe(
        'Transaction cannot be sent because the 24kb call data size limit has been reached. Please use StateOverride mode instead.'
      )
    }
  })

  test('should throw an solidity assert error', async () => {
    expect.assertions(1)
    const contract = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    try {
      await contract.call('throwAssertError', [])
    } catch (e: any) {
      expect(e).toBe('solidity assert error')
    }
  })

  test('should throw an arithmetic error', async () => {
    expect.assertions(1)
    const contract = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    try {
      await contract.call('throwArithmeticError', [])
    } catch (e: any) {
      expect(e).toBe('arithmetic error')
    }
  })

  test('should throw a division by zero error', async () => {
    expect.assertions(1)
    const contract = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    try {
      await contract.call('throwDivisionByZeroError', [])
    } catch (e: any) {
      expect(e).toBe('division by zero')
    }
  })

  test('should throw a panic error', async () => {
    expect.assertions(1)
    const contract = new Deployless(
      mainnetProvider,
      helloWorld.abi,
      helloWorld.bin,
      helloWorld.binRuntime
    )
    try {
      await contract.call('throwCompilerPanic', [])
    } catch (e: any) {
      expect(e).toBe('panic error: 0x32')
    }
  })
})
