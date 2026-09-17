// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BaseTestHooks} from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev Hook whose afterSwap calls `manager.sync(erc20)` and returns without settling, leaving the
///      PoolManager's transient synced-currency slot pointing at an ERC-20.
contract StaleSyncHook is BaseTestHooks {
    IPoolManager immutable manager;
    Currency immutable toSync;
    uint256 public calls;

    constructor(IPoolManager _manager, Currency _toSync) {
        manager = _manager;
        toSync = _toSync;
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        manager.sync(toSync);
        calls++;
        return (IHooks.afterSwap.selector, 0);
    }
}

/// @dev Honest v3-style pool: pays `give` native to the recipient and collects its exact t1 input
///      through the canonical v3 callback.
contract HonestNativePool {
    uint256 immutable give;

    constructor(uint256 _give) {
        give = _give;
    }

    receive() external payable {}

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        (bool ok,) = recipient.call{value: give}("");
        require(ok);
        amount0 = -int256(give);
        amount1 = amountSpecified;
        ArcArbExecutor(payable(msg.sender)).uniswapV3SwapCallback(amount0, amount1, "");
    }
}

/// @dev Control: a naive integrator that swaps on the hooked pool and then settles native WITHOUT
///      calling sync(address(0)) first. Shows the stale sync the hook leaves behind is real.
contract NaiveNativeSettler is IUnlockCallback {
    IPoolManager immutable manager;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    receive() external payable {}

    function run(PoolKey memory key, uint256 amountIn, bool syncFirst) external {
        manager.unlock(abi.encode(key, amountIn, syncFirst));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint256 amountIn, bool syncFirst) = abi.decode(data, (PoolKey, uint256, bool));
        BalanceDelta d = manager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        manager.take(key.currency1, address(this), uint256(uint128(d.amount1())));
        if (syncFirst) manager.sync(CurrencyLibrary.ADDRESS_ZERO);
        manager.settle{value: amountIn}();
        return "";
    }
}

contract Review_NativeSyncHookTest is Deployers {
    using CurrencyLibrary for Currency;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    PoolKey internal hooked; // native / t1, with StaleSyncHook on afterSwap
    StaleSyncHook internal hook;
    MockERC20 internal t1;

    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t1 = MockERC20(Currency.unwrap(currency1));

        StaleSyncHook impl = new StaleSyncHook(manager, currency1);
        address hookAddr = address(uint160(Hooks.AFTER_SWAP_FLAG));
        vm.etch(hookAddr, address(impl).code);
        hook = StaleSyncHook(hookAddr);

        vm.deal(address(this), 1_000 ether);
        (hooked,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(hookAddr), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(hooked, WIDE, ZERO_BYTES);

        exec = new ArcArbExecutor(manager, owner, operator);
    }

    function _steps(address pool) internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: hooked}); // native -> t1 (hook syncs t1)
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> native, paid to the wallet
            pool: pool,
            key: PoolKey({
                currency0: CurrencyLibrary.ADDRESS_ZERO, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))
            })
        });
    }

    /// Control: the hook really does leave t1 synced, and settling native on top of it without
    /// sync(address(0)) reverts with NonzeroNativeValue. With the sync it succeeds.
    function test_control_staleSyncBreaksNaiveNativeSettle() public {
        NaiveNativeSettler naive = new NaiveNativeSettler(manager);
        vm.deal(address(naive), 10 ether);

        vm.expectRevert(IPoolManager.NonzeroNativeValue.selector);
        naive.run(hooked, 1e18, false);

        naive.run(hooked, 1e18, true);
        assertEq(hook.calls(), 1, "hook ran (the reverted attempt rolled its counter back)");
    }

    /// Claimed scenario: native start, hooked v4 hop whose afterSwap syncs an ERC-20, wallet hop back
    /// to native, general close path pays the v4 debt with `_pay(native)`. Must NOT revert: `_pay`
    /// calls sync(address(0)) before settle{value}.
    function test_executor_nativeSettleSurvivesHookLeavingErc20Synced() public {
        HonestNativePool pool = new HonestNativePool(1.01e18);
        vm.deal(address(pool), 10 ether);

        uint256 before = address(exec).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(_steps(address(pool)), 1e18, 1, NO_GUARDS);

        assertEq(hook.calls(), 1, "hook afterSwap ran and synced t1");
        assertEq(profit, 0.01e18, "net = 1.01e18 received - 1e18 owed");
        assertEq(address(exec).balance - before, profit, "profit landed in the wallet");
        assertEq(t1.balanceOf(address(exec)), 0, "no leftover t1");
    }
}
