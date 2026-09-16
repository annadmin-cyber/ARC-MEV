/**
 * Prints the `execute` calldata `encodeExecute` produces for the shared fixtures, for comparison
 * with the Solidity reference in `contracts/test/vectors/ExecCalldataVectors.t.sol`:
 *
 *   npx tsx test/exec/calldata-vector.ts
 *   (cd contracts && forge test --match-contract ExecCalldataVectors -vv)
 *
 * Both print `EXECUTE_CALLDATA` (the v4-only fixture) and `EXECUTE_CALLDATA_MIXED` (v4 + v3 + v2)
 * followed by the same hex. `test/exec/encode.test.ts` pins both hex strings.
 */
import { encodeExecute, toExecutorSteps, toGuards } from '../../src/exec/encode.js'
import { CYCLE, INFOS, MIXED_CYCLE, MIXED_INFOS, MIXED_STATES, STATES } from './helpers.js'

console.log('EXECUTE_CALLDATA')
console.log(encodeExecute(toExecutorSteps(CYCLE, INFOS), 1_234_567_890_123_456_789n, 50_000_000_000_000_000n, toGuards(CYCLE, STATES, 2)))
console.log('EXECUTE_CALLDATA_MIXED')
console.log(encodeExecute(toExecutorSteps(MIXED_CYCLE, MIXED_INFOS), 10n ** 18n, 12_345n, toGuards(MIXED_CYCLE, MIXED_STATES, 3, MIXED_INFOS)))
