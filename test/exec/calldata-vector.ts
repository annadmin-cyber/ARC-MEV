/**
 * Prints the `execute` calldata `encodeExecute` produces for the shared fixture, for comparison
 * with the Solidity reference in `contracts/test/vectors/ExecCalldataVectors.t.sol`:
 *
 *   npx tsx test/exec/calldata-vector.ts
 *   (cd contracts && forge test --match-contract ExecCalldataVectors -vv)
 */
import { encodeExecute, toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import { CYCLE, INFOS, STATES } from './helpers.js'

const data = encodeExecute(toExecutorSteps(CYCLE, INFOS), 1_234_567_890_123_456_789n, 50_000_000_000_000_000n, toGuards(CYCLE, STATES, 2))
console.log('EXECUTE_CALLDATA')
console.log(data)
