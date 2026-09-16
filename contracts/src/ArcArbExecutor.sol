// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title ArcArbExecutor
/// @notice Executes a closed cycle of Uniswap v4 swaps atomically inside a single
///         `PoolManager.unlock`, using flash accounting so no upfront capital is needed.
///         Reverts unless the net gain in the start currency is at least `minProfit`.
/// @dev    Roles: `owner` controls funds and keys, `operator` (the bot hot key) may only
///         call `execute`. Profit accumulates in this contract until the owner withdraws.
contract ArcArbExecutor is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using TransientStateLibrary for IPoolManager;
    using StateLibrary for IPoolManager;

    /// @notice One hop of the cycle. `zeroForOne` selects the swap direction within `key`.
    struct Step {
        PoolKey key;
        bool zeroForOne;
    }

    /// @notice Cheap pre-flight check: revert before swapping if a pool's price moved since simulation.
    struct Guard {
        bytes32 poolId;
        uint160 expectedSqrtPriceX96;
        /// @dev Allowed |actual - expected| as basis points of expected. 0 = exact match.
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
    error PathBroken(uint256 stepIndex);
    error NoOutput(uint256 stepIndex);
    error CycleNotClosed(Currency start, Currency end);
    error Unprofitable(int256 delta, uint256 minProfit);
    error StaleState(uint256 guardIndex, uint160 actualSqrtPriceX96);
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

    // ---------------------------------------------------------------------
    // Execution
    // ---------------------------------------------------------------------

    /// @notice Run a closed cycle of exact-input swaps and keep the profit.
    /// @param steps    Ordered hops. Output of hop i must be the input of hop i+1 and the
    ///                 final output must be the currency of the first input.
    /// @param amountIn Exact input for the first hop, in the start currency's units.
    /// @param minProfit Revert unless net gain in the start currency is >= this.
    /// @param guards   Optional price guards checked before any swap (cheap failure when the
    ///                 opportunity was already taken by someone else in this block).
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

    function _checkGuards(Guard[] calldata guards) internal view {
        for (uint256 i = 0; i < guards.length; ++i) {
            Guard calldata g = guards[i];
            (uint160 actual,,,) = POOL_MANAGER.getSlot0(PoolId.wrap(g.poolId));
            uint256 expected = g.expectedSqrtPriceX96;
            uint256 diff = actual > expected ? actual - expected : expected - actual;
            if (diff * 10_000 > expected * g.toleranceBps) revert StaleState(i, actual);
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();

        (Step[] memory steps, uint256 amountIn, uint256 minProfit) = abi.decode(data, (Step[], uint256, uint256));

        Currency start = steps[0].zeroForOne ? steps[0].key.currency0 : steps[0].key.currency1;
        Currency current = start;
        uint256 amount = amountIn;

        for (uint256 i = 0; i < steps.length; ++i) {
            Step memory step = steps[i];
            Currency input = step.zeroForOne ? step.key.currency0 : step.key.currency1;
            if (!(input == current)) revert PathBroken(i);

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
            amount = uint256(uint128(out));
            current = step.zeroForOne ? step.key.currency1 : step.key.currency0;
        }

        if (!(current == start)) revert CycleNotClosed(start, current);

        // Net delta of the start currency after the whole cycle. Every intermediate currency
        // nets to zero because each hop's full output is the next hop's input; PoolManager
        // reverts at the end of unlock if that ever does not hold.
        int256 net = POOL_MANAGER.currencyDelta(address(this), start);
        if (net < 0 || uint256(net) < minProfit) revert Unprofitable(net, minProfit);

        uint256 profit = uint256(net);
        if (profit > 0) POOL_MANAGER.take(start, address(this), profit);

        emit Executed(start, amountIn, profit, steps.length);
        return abi.encode(profit);
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
