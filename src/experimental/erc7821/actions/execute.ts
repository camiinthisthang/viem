import type { Abi, Address, Narrow } from 'abitype'
import * as AbiError from 'ox/AbiError'
import * as AbiParameters from 'ox/AbiParameters'

import {
  type SendTransactionErrorType,
  sendTransaction,
} from '../../../actions/wallet/sendTransaction.js'
import type { Client } from '../../../clients/createClient.js'
import type { Transport } from '../../../clients/transports/createTransport.js'
import type { BaseError } from '../../../errors/base.js'
import type { ErrorType } from '../../../errors/utils.js'
import type { Account, GetAccountParameter } from '../../../types/account.js'
import type { Call, Calls } from '../../../types/calls.js'
import type {
  Chain,
  DeriveChain,
  GetChainParameter,
} from '../../../types/chain.js'
import type { Hex } from '../../../types/misc.js'
import type { UnionEvaluate, UnionPick } from '../../../types/utils.js'
import {
  type DecodeErrorResultErrorType,
  decodeErrorResult,
} from '../../../utils/abi/decodeErrorResult.js'
import {
  type EncodeFunctionDataErrorType,
  encodeFunctionData,
} from '../../../utils/abi/encodeFunctionData.js'
import {
  type GetContractErrorReturnType,
  getContractError,
} from '../../../utils/errors/getContractError.js'
import type { FormattedTransactionRequest } from '../../../utils/formatters/transactionRequest.js'
import { withCache } from '../../../utils/promise/withCache.js'
import { abi, executionMode } from '../constants.js'
import {
  ExecuteUnsupportedError,
  FunctionSelectorNotRecognizedError,
} from '../errors.js'
import { supportsExecutionMode } from './supportsExecutionMode.js'

export type ExecuteParameters<
  calls extends readonly unknown[] = readonly unknown[],
  chain extends Chain | undefined = Chain | undefined,
  account extends Account | undefined = Account | undefined,
  chainOverride extends Chain | undefined = Chain | undefined,
  _derivedChain extends Chain | undefined = DeriveChain<chain, chainOverride>,
> = UnionEvaluate<
  UnionPick<
    FormattedTransactionRequest<_derivedChain>,
    | 'authorizationList'
    | 'gas'
    | 'gasPrice'
    | 'maxFeePerGas'
    | 'maxPriorityFeePerGas'
  >
> &
  GetAccountParameter<account, Account | Address, true, true> &
  GetChainParameter<chain, chainOverride> & {
    /** Address that will execute the calls. */
    address: Address
    /** Calls to execute. */
    calls: Calls<Narrow<calls>>
    /** Additional data to include for execution. */
    opData?: Hex | undefined
  }

export type ExecuteReturnType = Hex

export type ExecuteErrorType =
  | DecodeErrorResultErrorType
  | GetContractErrorReturnType
  | EncodeFunctionDataErrorType
  | SendTransactionErrorType
  | ErrorType

/**
 * Executes call(s) using the `execute` function on an [ERC-7821-compatible contract](https://eips.ethereum.org/EIPS/eip-7821).
 *
 * @example
 * ```ts
 * import { createClient, http } from 'viem'
 * import { privateKeyToAccount } from 'viem/accounts'
 * import { mainnet } from 'viem/chains'
 * import { execute } from 'viem/experimental/erc7821'
 *
 * const account = privateKeyToAccount('0x...')
 *
 * const client = createClient({
 *   chain: mainnet,
 *   transport: http(),
 * })
 *
 * const hash = await execute(client, {
 *   account,
 *   calls: [{
 *     {
 *       data: '0xdeadbeef',
 *       to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
 *     },
 *     {
 *       to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
 *       value: 69420n,
 *     },
 *   }],
 *   to: account.address,
 * })
 * ```
 *
 * @example
 * ```ts
 * // Account Hoisting
 * import { createClient, http } from 'viem'
 * import { privateKeyToAccount } from 'viem/accounts'
 * import { mainnet } from 'viem/chains'
 * import { execute } from 'viem/experimental/erc7821'
 *
 * const account = privateKeyToAccount('0x...')
 *
 * const client = createClient({
 *   account,
 *   chain: mainnet,
 *   transport: http(),
 * })
 *
 * const hash = await execute(client, {
 *   calls: [{
 *     {
 *       data: '0xdeadbeef',
 *       to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
 *     },
 *     {
 *       to: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
 *       value: 69420n,
 *     },
 *   }],
 *   to: account.address,
 * })
 * ```
 *
 * @param client - Client to use.
 * @param parameters - {@link ExecuteParameters}
 * @returns Transaction hash. {@link ExecuteReturnType}
 */
export async function execute<
  const calls extends readonly unknown[],
  chain extends Chain | undefined,
  account extends Account | undefined,
  chainOverride extends Chain | undefined = undefined,
>(
  client: Client<Transport, chain, account>,
  parameters: ExecuteParameters<calls, chain, account, chainOverride>,
): Promise<ExecuteReturnType> {
  const { authorizationList, calls, opData } = parameters

  const address = authorizationList?.[0]?.contractAddress ?? parameters.address
  const encodedCalls = encodeCalls(calls, opData)
  const mode = opData ? executionMode.opData : executionMode.default

  const supported = await withCache(
    () =>
      supportsExecutionMode(client, {
        address,
        mode,
      }),
    {
      cacheKey: `supportsExecutionMode.${client.uid}.${address}.${mode}`,
    },
  )
  if (!supported) throw new ExecuteUnsupportedError()

  try {
    return await sendTransaction(client, {
      ...parameters,
      to: parameters.address,
      data: encodeFunctionData({
        abi,
        functionName: 'execute',
        args: [mode, encodedCalls],
      }),
    } as any)
  } catch (e) {
    const error = (e as BaseError).walk((e) => 'data' in (e as Error)) as
      | (BaseError & { data?: Hex | undefined })
      | undefined

    if (!error?.data) throw e
    if (
      error.data ===
      AbiError.getSelector(AbiError.from('error FnSelectorNotRecognized()'))
    )
      throw new FunctionSelectorNotRecognizedError()

    let matched: Call | null = null
    for (const c of parameters.calls) {
      const call = c as Call
      if (!call.abi) continue
      try {
        const matches = Boolean(
          decodeErrorResult({
            abi: call.abi,
            data: error.data!,
          }),
        )
        if (!matches) continue
        matched = call
      } catch {}
    }
    if (!matched) throw e

    throw getContractError(error as BaseError, {
      abi: matched.abi as Abi,
      address: matched.to,
      args: matched.args,
      docsPath: '/experimental/erc7821/execute',
      functionName: matched.functionName,
    })
  }
}

/** @internal */
export function encodeCalls(
  calls_: Calls<readonly unknown[]>,
  opData?: Hex | undefined,
) {
  const calls = calls_.map((call_) => {
    const call = call_ as Call
    return {
      data: call.abi ? encodeFunctionData(call) : (call.data ?? '0x'),
      value: call.value ?? 0n,
      target: call.to,
    }
  })

  return AbiParameters.encode(
    AbiParameters.from([
      'struct Call { address target; uint256 value; bytes data; }',
      'Call[] calls',
      ...(opData ? ['bytes opData'] : []),
    ]),
    [calls, ...(opData ? [opData] : [])] as any,
  )
}
