// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @dev Minimal Uniswap-v3-style pool surface (works for most forks; callback selector is not assumed).
interface IV3PoolMinimal {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @dev Minimal Uniswap-v2-style pair surface.
interface IV2PairMinimal {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title ArcArbExecutor
/// @notice Executes a closed cycle of swaps atomically inside one `PoolManager.unlock`, across
///         Uniswap v4 pools, v3-style pools and v2-style pairs, with no upfront capital:
///         v4 flash accounting covers v4 hops and `PoolManager.take` acts as a flash loan for
///         the input of any v3/v2 hop. Reverts unless the net gain in the start currency is at
///         least `minProfit`.
/// @dev    On Arc the native currency (18 decimals) and the USDC ERC-20 predeploy at
///         0x3600…0000 (6 decimals) are one balance, so a cycle may start in one form and end in
///         the other; profit is then measured as the change of this contract's balance in the
///         start currency's units.
///         Roles: `owner` controls funds and keys, `operator` (the bot hot key) may only call
///         `execute`. Profit accumulates here until the owner withdraws.
contract ArcArbExecutor is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using TransientStateLibrary for IPoolManager;
    using StateLibrary for IPoolManager;

    uint8 public constant KIND_V4 = 0;
    uint8 public constant KIND_V3 = 1;
    uint8 public constant KIND_V2 = 2;

    /// @notice USDC ERC-20 predeploy on Arc; the 6-decimal view of the native balance.
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 internal constant PIPS = 1_000_000;

    /// @dev Transient slot holding the pool allowed to call back during a v3-style swap.
    bytes32 internal constant CALLBACK_POOL_SLOT = keccak256("ArcArbExecutor.callbackPool");

    /// @notice One hop of the cycle.
    /// @dev `key.currency0/currency1` are the pool's token0/token1 for every kind and define the
    ///      swap direction with `zeroForOne`. For v4 the full key is used; for v2 `key.fee` is the
    ///      pair's swap fee in pips (3000 = 0.30%); `pool` is the v3/v2 pool address (ignored for v4).
    struct Step {
        uint8 kind;
        bool zeroForOne;
        address pool;
        PoolKey key;
    }

    /// @notice Cheap pre-flight check: revert before swapping if a pool moved since simulation.
    /// @dev kind 0: `poolId` is the v4 pool id, `expected` its sqrtPriceX96.
    ///      kind 1: `poolId` is the v3 pool address, `expected` its slot0 sqrtPriceX96.
    ///      kind 2: `poolId` is the v2 pair address, `expected` its reserve0.
    ///      `toleranceBps` is the allowed |actual - expected| in basis points of expected.
    struct Guard {
        uint8 kind;
        bytes32 poolId;
        uint160 expected;
        uint24 toleranceBps;
    }

    IPoolManager public immutable POOL_MANAGER;
    address public owner;
    address public operator;

    error NotOwner();
    error NotOperator();
    error NotPoolManager();
    error ZeroAddress();
    error EmptyPlan();
    error UnknownKind(uint256 stepIndex);
    error PathBroken(uint256 stepIndex);
    error NoOutput(uint256 stepIndex);
    error CycleNotClosed(Currency start, Currency end);
    error Unprofitable(int256 delta, uint256 minProfit);
    error StaleState(uint256 guardIndex, uint160 actual);
    error UnexpectedCallback(address caller);
    error CallFailed(bytes reason);

    event Executed(Currency indexed currency, uint256 amountIn, uint256 profit, uint256 steps);
    event Withdrawn(Currency indexed currency, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    constructor(IPoolManager poolManager, address initialOwner, address initialOperator) {
        if (address(poolManager) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        POOL_MANAGER = poolManager;
        owner = initialOwner;
        operator = initialOperator;
        emit OwnershipTransferred(address(0), initialOwner);
        emit OperatorUpdated(address(0), initialOperator);
    }

    /// @notice Accept native currency from `PoolManager.take` and from the owner.
    receive() external payable {}

    /// @notice v3-style swap callback for any fork selector: (int256 amount0Delta, int256 amount1Delta, bytes data).
    fallback() external {
        _handleV3Callback(msg.data);
    }

    /// @notice Canonical Uniswap v3 callback.
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external {
        _handleV3Callback(msg.data);
    }

    // ---------------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------------

    /// @notice Run a closed cycle of exact-input swaps and keep the profit.
    /// @param steps    Ordered hops; the output of hop i is the input of hop i+1 and the last output
    ///                 is the start currency (or its other USDC form).
    /// @param amountIn Exact input for the first hop, in the start currency's units.
    /// @param minProfit Revert unless the net gain in the start currency is >= this.
    /// @param guards   Optional price guards checked before any swap.
    /// @return profit  Realised net gain in the start currency, now held by this contract.
    function execute(Step[] calldata steps, uint256 amountIn, uint256 minProfit, Guard[] calldata guards)
        external
        onlyOperator
        returns (uint256 profit)
    {
        if (steps.length == 0) revert EmptyPlan();
        _checkGuards(guards);
        bytes memory result = POOL_MANAGER.unlock(abi.encode(steps, amountIn, minProfit));
        profit = abi.decode(result, (uint256));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();

        (Step[] memory steps, uint256 amountIn, uint256 minProfit) = abi.decode(data, (Step[], uint256, uint256));

        Currency start = steps[0].zeroForOne ? steps[0].key.currency0 : steps[0].key.currency1;
        uint256 startBalance = start.balanceOfSelf();

        Currency current = start;
        uint256 amount = amountIn;
        // `inManager` means `amount` of `current` is a positive delta inside the PoolManager (or, for
        // the very first hop, may be drawn from it as a flash loan); otherwise this contract holds it.
        bool inManager = true;

        for (uint256 i = 0; i < steps.length; ++i) {
            (current, amount, inManager) = _hop(steps[i], current, amount, inManager, i);
        }

        uint256 profit;
        if (inManager && current == start) {
            // Plain closed cycle: every intermediate currency netted to zero, only the start delta remains.
            int256 net = POOL_MANAGER.currencyDelta(address(this), start);
            if (net < 0 || uint256(net) < minProfit) revert Unprofitable(net, minProfit);
            profit = uint256(net);
            if (profit > 0) POOL_MANAGER.take(start, address(this), profit);
        } else {
            // Funds ended in this contract's wallet and/or in the other USDC form. Bring everything
            // into the wallet, then settle what we still owe the PoolManager for the start currency
            // (a flash loan or a v4 exact-input debt) out of the wallet, checking profit first so an
            // unprofitable cycle reverts with a clear error instead of an underflow.
            if (!_sameMoney(current, start)) revert CycleNotClosed(start, current);
            if (inManager) POOL_MANAGER.take(current, address(this), amount);
            int256 startDelta = POOL_MANAGER.currencyDelta(address(this), start);
            if (startDelta > 0) POOL_MANAGER.take(start, address(this), uint256(startDelta));
            uint256 owed = startDelta < 0 ? uint256(-startDelta) : 0;
            int256 net = int256(start.balanceOfSelf()) - int256(owed) - int256(startBalance);
            if (net < 0 || uint256(net) < minProfit) revert Unprofitable(net, minProfit);
            if (owed > 0) _pay(start, owed);
            profit = uint256(net);
        }

        emit Executed(start, amountIn, profit, steps.length);
        return abi.encode(profit);
    }

    /// @dev Executes one hop and returns the new (currency, amount, inManager).
    function _hop(Step memory step, Currency current, uint256 amount, bool inManager, uint256 i)
        internal
        returns (Currency, uint256, bool)
    {
        Currency input = step.zeroForOne ? step.key.currency0 : step.key.currency1;
        Currency output = step.zeroForOne ? step.key.currency1 : step.key.currency0;
        if (!(input == current)) revert PathBroken(i);

        if (step.kind == KIND_V4) {
            if (!inManager) _pay(current, amount);
            BalanceDelta delta = POOL_MANAGER.swap(
                step.key,
                SwapParams({
                    zeroForOne: step.zeroForOne,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: step.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            int128 out = step.zeroForOne ? delta.amount1() : delta.amount0();
            if (out <= 0) revert NoOutput(i);
            return (output, uint256(uint128(out)), true);
        }

        // v3 / v2 hops need real tokens: withdraw our credit, or flash-borrow, from the PoolManager.
        if (inManager) POOL_MANAGER.take(current, address(this), amount);

        uint256 received;
        if (step.kind == KIND_V3) {
            received = _swapV3(step, input, output, amount);
        } else if (step.kind == KIND_V2) {
            received = _swapV2(step, input, output, amount);
        } else {
            revert UnknownKind(i);
        }
        if (received == 0) revert NoOutput(i);
        return (output, received, false);
    }

    function _swapV3(Step memory step, Currency input, Currency output, uint256 amount) internal returns (uint256 received) {
        uint256 before = output.balanceOfSelf();
        _setCallbackPool(step.pool);
        IV3PoolMinimal(step.pool).swap(
            address(this),
            step.zeroForOne,
            int256(amount),
            step.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            abi.encode(Currency.unwrap(input))
        );
        _setCallbackPool(address(0));
        received = output.balanceOfSelf() - before;
    }

    function _swapV2(Step memory step, Currency input, Currency output, uint256 amount) internal returns (uint256 received) {
        (uint112 reserve0, uint112 reserve1,) = IV2PairMinimal(step.pool).getReserves();
        (uint256 reserveIn, uint256 reserveOut) =
            step.zeroForOne ? (uint256(reserve0), uint256(reserve1)) : (uint256(reserve1), uint256(reserve0));
        uint256 amountWithFee = amount * (PIPS - step.key.fee);
        uint256 out = (amountWithFee * reserveOut) / (reserveIn * PIPS + amountWithFee);
        if (out == 0) return 0;

        input.transfer(step.pool, amount);
        uint256 before = output.balanceOfSelf();
        IV2PairMinimal(step.pool).swap(step.zeroForOne ? 0 : out, step.zeroForOne ? out : 0, address(this), "");
        received = output.balanceOfSelf() - before;
    }

    /// @dev Pays `amount` of `currency` from this contract into the PoolManager, creating a credit.
    function _pay(Currency currency, uint256 amount) internal {
        if (currency.isAddressZero()) {
            POOL_MANAGER.settle{value: amount}();
        } else {
            POOL_MANAGER.sync(currency);
            currency.transfer(address(POOL_MANAGER), amount);
            POOL_MANAGER.settle();
        }
    }

    function _handleV3Callback(bytes calldata callData) internal {
        address pool = _callbackPool();
        if (pool == address(0) || msg.sender != pool) revert UnexpectedCallback(msg.sender);
        (int256 amount0Delta, int256 amount1Delta, bytes memory data) = abi.decode(callData[4:], (int256, int256, bytes));
        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        Currency.wrap(tokenIn).transfer(msg.sender, owed);
    }

    function _checkGuards(Guard[] calldata guards) internal view {
        for (uint256 i = 0; i < guards.length; ++i) {
            Guard calldata g = guards[i];
            uint256 actual;
            if (g.kind == KIND_V4) {
                (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(PoolId.wrap(g.poolId));
                actual = sqrtPriceX96;
            } else if (g.kind == KIND_V3) {
                (bool ok, bytes memory ret) =
                    address(uint160(uint256(g.poolId))).staticcall(abi.encodeWithSignature("slot0()"));
                if (!ok || ret.length < 32) revert StaleState(i, 0);
                actual = uint160(abi.decode(ret, (uint256)));
            } else if (g.kind == KIND_V2) {
                (uint112 reserve0,,) = IV2PairMinimal(address(uint160(uint256(g.poolId)))).getReserves();
                actual = reserve0;
            } else {
                revert UnknownKind(i);
            }
            uint256 expected = g.expected;
            uint256 diff = actual > expected ? actual - expected : expected - actual;
            if (diff * 10_000 > expected * g.toleranceBps) revert StaleState(i, uint160(actual));
        }
    }

    function _sameMoney(Currency a, Currency b) internal pure returns (bool) {
        return a == b || (_isUsdc(a) && _isUsdc(b));
    }

    function _isUsdc(Currency c) internal pure returns (bool) {
        return c.isAddressZero() || Currency.unwrap(c) == USDC_ERC20;
    }

    function _setCallbackPool(address pool) internal {
        bytes32 slot = CALLBACK_POOL_SLOT;
        assembly ("memory-safe") {
            tstore(slot, pool)
        }
    }

    function _callbackPool() internal view returns (address pool) {
        bytes32 slot = CALLBACK_POOL_SLOT;
        assembly ("memory-safe") {
            pool := tload(slot)
        }
    }

    // ---------------------------------------------------------------------
    // Owner functions
    // ---------------------------------------------------------------------

    /// @notice Withdraw `amount` of `currency` (native if `currency` is address(0)).
    function withdraw(Currency currency, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        currency.transfer(to, amount);
        emit Withdrawn(currency, to, amount);
    }

    /// @notice Withdraw the full balance of `currency`.
    function sweep(Currency currency, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = currency.balanceOfSelf();
        currency.transfer(to, amount);
        emit Withdrawn(currency, to, amount);
    }

    /// @notice Emergency escape hatch: arbitrary call from this contract (owner only).
    function call(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    function setOperator(address newOperator) external onlyOwner {
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
