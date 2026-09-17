// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev v3-style pool (t1 -> native) that, while serving the swap, calls `PoolManager.sync(t1)`
///      and never settles. `sync` has no `onlyWhenUnlocked`, so any contract the cycle touches can
///      leave the PoolManager's synced-currency slot pointing at an ERC-20. The pool is otherwise
///      honest: it pays `give` native to the recipient and collects its exact t1 input through the
///      canonical v3 callback (forwarding `data`, so it also serves the pre-fix executor).
contract SyncingNativePool {
    IPoolManager immutable manager;
    Currency immutable stray;
    uint256 immutable give;
    MockERC20 immutable t1;

    constructor(IPoolManager _manager, MockERC20 _t1, uint256 _give) {
        manager = _manager;
        stray = Currency.wrap(address(_t1));
        give = _give;
        t1 = _t1;
    }

    receive() external payable {}

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!zeroForOne, "native is token0; only t1 -> native");
        manager.sync(stray); // the stray sync: anyone may call it, and nothing resets it
        uint256 before = t1.balanceOf(address(this));
        (bool ok,) = recipient.call{value: give}("");
        require(ok, "pay native");
        amount0 = -int256(give);
        amount1 = amountSpecified;
        (ok,) = msg.sender.call(abi.encodeWithSignature("uniswapV3SwapCallback(int256,int256,bytes)", amount0, amount1, data));
        require(ok, "callback failed");
        require(t1.balanceOf(address(this)) >= before + uint256(amountSpecified), "not paid");
    }
}

/// @dev Control: the pre-fix `_pay(native)` body (settle{value} with no sync(address(0)) first),
///      run in isolation to show the stale sync is what makes the native settle revert.
contract NaiveNativeSettler is IUnlockCallback {
    IPoolManager immutable manager;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    receive() external payable {}

    function run(Currency stray, bool syncFirst) external {
        manager.unlock(abi.encode(stray, syncFirst));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (Currency stray, bool syncFirst) = abi.decode(data, (Currency, bool));
        manager.sync(stray);
        if (syncFirst) manager.sync(CurrencyLibrary.ADDRESS_ZERO);
        manager.settle{value: 1 ether}();
        manager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), 1 ether);
        return "";
    }
}

contract Review_ExtPoolSyncNativeSettleTest is Deployers {
    using CurrencyLibrary for Currency;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    PoolKey internal nativeA; // native / t1, no hook
    MockERC20 internal t1;
    SyncingNativePool internal pool;

    ModifyLiquidityParams internal WIDE =
        ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0});

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t1 = MockERC20(Currency.unwrap(currency1));

        vm.deal(address(this), 1_000 ether);
        (nativeA,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(nativeA, WIDE, ZERO_BYTES);

        // Pays 1.1 native per 1 t1: the cycle t1 -> native (here) -> t1 (v4 at 1:1) is profitable.
        pool = new SyncingNativePool(manager, t1, 1.1e18);
        vm.deal(address(pool), 10 ether);

        exec = new ArcArbExecutor(manager, owner, operator);
    }

    /// t1 -> native on the syncing external pool, then native -> t1 on a plain v4 pool. The second
    /// hop pays its native input with `_pay(native)` while t1 is still synced.
    function _steps() internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> native
            pool: address(pool),
            key: PoolKey({
                currency0: CurrencyLibrary.ADDRESS_ZERO, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))
            })
        });
        steps[1] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: nativeA}); // native -> t1
    }

    /// Control: a stray sync(t1) makes a bare settle{value} revert NonzeroNativeValue; sync(0) first fixes it.
    function test_control_straySyncBreaksBareNativeSettle() public {
        NaiveNativeSettler naive = new NaiveNativeSettler(manager);
        vm.deal(address(naive), 10 ether);

        vm.expectRevert(IPoolManager.NonzeroNativeValue.selector);
        naive.run(currency1, false);

        naive.run(currency1, true);
    }

    /// Regression: the executor's native `_pay` must survive an external pool leaving an ERC-20 synced.
    function test_executor_nativePaySurvivesStraySyncFromExternalPool() public {
        uint256 before = t1.balanceOf(address(exec));

        vm.prank(operator);
        uint256 profit = exec.execute(_steps(), 1e18, 1, NO_GUARDS);

        assertGt(profit, 0, "cycle is profitable");
        assertEq(t1.balanceOf(address(exec)) - before, profit, "profit landed in t1");
        assertEq(address(exec).balance, 0, "no native left in the wallet");
        assertEq(address(pool).balance, 10 ether - 1.1e18, "pool paid exactly its quote");
        assertEq(t1.balanceOf(address(pool)), 1e18, "pool was paid exactly the hop input");
    }
}
