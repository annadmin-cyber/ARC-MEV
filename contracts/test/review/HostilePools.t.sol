// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeTakingHook} from "@uniswap/v4-core/src/test/FeeTakingHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev Hostile "v3 pool": pays out `give` of tokenOut, then invokes the executor's callback several
///      times, each time with its OWN `data` naming a token that is not part of the step at all, and
///      an `owed` equal to the executor's full balance of that token.
contract MultiDrainPool {
    MockERC20 immutable t0;
    MockERC20 immutable t1;
    address[] victims; // tokens (address(0) = native) to drain from the executor

    constructor(MockERC20 _t0, MockERC20 _t1, address[] memory _victims) {
        t0 = _t0;
        t1 = _t1;
        victims = _victims;
    }

    receive() external payable {}

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        MockERC20 tokenOut = zeroForOne ? t1 : t0;
        uint256 give = 1e18 + 1; // 1 wei above the cycle's 1e18 start input, so the profit gate passes
        amountSpecified;
        tokenOut.transfer(recipient, give);
        for (uint256 i = 0; i < victims.length; ++i) {
            address v = victims[i];
            uint256 grab = v == address(0) ? recipient.balance : MockERC20(v).balanceOf(recipient);
            if (grab == 0) continue;
            // The executor decodes tokenIn from *this* data and pays `grab` of it to msg.sender.
            (bool ok,) = msg.sender.call(
                abi.encodeWithSelector(
                    ArcArbExecutor.uniswapV3SwapCallback.selector,
                    zeroForOne ? int256(grab) : -int256(give),
                    zeroForOne ? -int256(give) : int256(grab),
                    abi.encode(v)
                )
            );
            require(ok, "cb failed");
        }
        (amount0, amount1) = zeroForOne ? (int256(1), -int256(give)) : (-int256(give), int256(1));
    }
}

/// @dev Honest-looking "v3 pool" that pays its output in native and happens to leave the PoolManager
///      with a synced ERC-20 currency (anything in the plan may do this: a hook, a token, a pool).
contract StaleSyncPool {
    IPoolManager immutable manager;
    MockERC20 immutable t1;

    constructor(IPoolManager _manager, MockERC20 _t1) {
        manager = _manager;
        t1 = _t1;
    }

    receive() external payable {}

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 give = 1.01e18;
        (bool ok,) = recipient.call{value: give}("");
        require(ok);
        manager.sync(Currency.wrap(address(t1))); // leaves t1 as the synced currency
        amount0 = -int256(give);
        amount1 = amountSpecified;
        (ok,) = msg.sender.call(
            abi.encodeWithSelector(ArcArbExecutor.uniswapV3SwapCallback.selector, amount0, amount1, data)
        );
        require(ok, "cb failed");
    }
}

contract HostilePoolsTest is Deployers {
    using CurrencyLibrary for Currency;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    MockERC20 internal t0;
    MockERC20 internal t1;
    PoolKey internal poolA;
    PoolKey internal poolB;
    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        (poolB,) = initPool(currency0, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(poolA, WIDE, ZERO_BYTES);
        modifyLiquidityRouter.modifyLiquidity(poolB, WIDE, ZERO_BYTES);
        exec = new ArcArbExecutor(manager, owner, operator);
    }

    /// The callback's `tokenIn` is decoded from pool-supplied data and `owed` is uncapped, so ONE
    /// hostile v3-style hop drains every balance the executor holds: tokens that are not in the
    /// plan at all, and the native balance (on Arc: the whole USDC treasury in either form).
    /// Regression: a hostile v3-style pool that demands unrelated tokens, native, or more of the input
    /// token than the hop amount is refused by the bounded callback; every held balance stays put.
    function test_hostileV3Pool_cannotDrainUnrelatedTokensOrNative() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        usdc.mint(address(exec), 1_000_000e6); // accumulated profit in a token unrelated to the plan
        vm.deal(address(exec), 50 ether); // accumulated native profit
        t0.transfer(address(exec), 7e18);

        address[] memory victims = new address[](3);
        victims[0] = address(usdc);
        victims[1] = address(0);
        victims[2] = address(t1);
        MultiDrainPool evil = new MultiDrainPool(t0, t1, victims);
        t0.transfer(address(evil), 10e18);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: poolA}); // t0 -> t1 (v4)
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> t0 on the hostile pool
            pool: address(evil),
            key: PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))})
        });

        // The executor refuses the over-demanding callback; the pool wraps that into its own revert.
        vm.prank(operator);
        vm.expectRevert(bytes("cb failed"));
        exec.execute(steps, 1e18, 1, NO_GUARDS);

        assertEq(usdc.balanceOf(address(exec)), 1_000_000e6, "unrelated token untouched");
        assertEq(address(exec).balance, 50 ether, "native untouched");
        assertEq(t0.balanceOf(address(exec)), 7e18, "start token untouched");
        assertEq(usdc.balanceOf(address(evil)), 0);
        assertEq(address(evil).balance, 0);
    }

    /// Negative check: a v4 hook that takes part of the output cannot touch the wallet; the loss is
    /// entirely inside the flash-accounted start delta, so the minProfit gate sees it.
    function test_v4FeeTakingHook_cannotTouchWallet() public {
        FeeTakingHook impl = new FeeTakingHook(manager);
        address hookAddr = address(uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG));
        vm.etch(hookAddr, address(impl).code);
        (PoolKey memory hooked,) = initPool(currency0, currency1, IHooks(hookAddr), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(hooked, WIDE, ZERO_BYTES);

        // Accumulated balances that must not move.
        t0.transfer(address(exec), 3e18);
        t1.transfer(address(exec), 4e18);
        vm.deal(address(exec), 2 ether);

        swap(poolB, true, -0.1e18, ZERO_BYTES); // token0 slightly cheap on B (~0.2% spread)

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: false, pool: address(0), key: poolB});
        steps[1] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: hooked});

        // The 1.23% hook fee on the output swallows the small spread: must revert, nothing lost.
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(steps, 0.1e18, 1, NO_GUARDS);
        assertEq(t0.balanceOf(address(exec)), 3e18);
        assertEq(t1.balanceOf(address(exec)), 4e18);
        assertEq(address(exec).balance, 2 ether);

        // With a bigger skew the cycle is profitable even after the hook's cut; wallet only gains.
        swap(poolB, true, -20e18, ZERO_BYTES);
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(t0.balanceOf(address(exec)), 3e18);
        assertEq(t1.balanceOf(address(exec)), 4e18 + profit);
        assertEq(address(exec).balance, 2 ether);
    }

    /// Regression: `_pay` for native must `sync(address(0))` before `settle{value}`, otherwise any hook,
    /// token or pool in the plan that leaves an ERC-20 synced makes the native settlement revert with
    /// `NonzeroNativeValue` (gas-only DoS of every native-start plan touching it).
    function test_nativeOwedPayment_succeedsWhenSyncedCurrencyLeftSet() public {
        vm.deal(address(this), 1_000 ether);
        (PoolKey memory nativeA,) =
            initPool(CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(nativeA, WIDE, ZERO_BYTES);

        StaleSyncPool pool = new StaleSyncPool(manager, t1);
        vm.deal(address(pool), 10 ether);

        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: nativeA}); // native -> t1
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> native on the v3-style pool
            pool: address(pool),
            key: PoolKey({
                currency0: CurrencyLibrary.ADDRESS_ZERO, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))
            })
        });

        uint256 balanceBefore = address(exec).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(address(exec).balance, balanceBefore + profit);
    }
}
