// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev Emulates Arc's USDC predeploy at 0x3600…0000 on a vanilla EVM: `balanceOf` is the native
///      balance floored to 6 decimals and every write moves the *native* balance (Arc does this via
///      the 0x1800 system contract, which Foundry cannot run; here `vm.deal` plays that role and
///      is journaled, so a revert unwinds it exactly like a real balance change).
contract ArcUsdcPredeploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SCALE = 1e12;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function balanceOf(address a) external view returns (uint256) {
        return a.balance / SCALE;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "Arc: value to address(0) reverts");
        uint256 w = amount * SCALE;
        require(from.balance >= w, "USDC: insufficient");
        vm.deal(from, from.balance - w);
        vm.deal(to, to.balance + w);
    }
}

/// @title Mixed native / ERC-20 USDC closes through the real PoolManager with Arc balance semantics.
contract Review_UsdcFormBridging is Deployers {
    using CurrencyLibrary for Currency;

    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    Currency internal usdc = Currency.wrap(USDC);
    Currency internal native = CurrencyLibrary.ADDRESS_ZERO;

    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    MockERC20 internal t1; // 18-decimal counter asset
    Currency internal c1;

    PoolKey internal nativePool; // native / t1 at 1 wei : 1 wei
    PoolKey internal usdcCheap; // USDC / t1 where 1 USDC unit buys only 0.98e12 t1-wei (t1 dear)
    PoolKey internal usdcRich; // USDC / t1 where 1 USDC unit buys 1.02e12 t1-wei (t1 cheap)

    function setUp() public {
        deployFreshManagerAndRouters();
        vm.etch(USDC, address(new ArcUsdcPredeploy()).code);
        vm.deal(address(this), 1_000_000 ether);

        t1 = new MockERC20("T1", "T1", 18);
        t1.mint(address(this), 1e30);
        t1.approve(address(modifyLiquidityRouter), type(uint256).max);
        t1.approve(address(swapRouter), type(uint256).max);
        c1 = Currency.wrap(address(t1));

        (nativePool,) = initPool(native, c1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 100 ether}(
            nativePool, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );

        usdcCheap = _initUsdcPool(0.98e12, 3000, 60);
        usdcRich = _initUsdcPool(1.02e12, 500, 10);

        exec = new ArcArbExecutor(manager, owner, operator);
    }

    /// @dev Creates a USDC/t1 pool where one USDC unit (1e-6) is worth `t1PerUnit` t1-wei and adds
    ///      liquidity around that price. Currency ordering depends on t1's address.
    function _initUsdcPool(uint256 t1PerUnit, uint24 fee, int24 spacing) internal returns (PoolKey memory key) {
        bool usdcIs0 = USDC < address(t1);
        uint160 sqrtP = usdcIs0
            ? uint160(FixedPointMathLib.sqrt(t1PerUnit << 192))
            : uint160(FixedPointMathLib.sqrt((uint256(1) << 192) / t1PerUnit));
        (key,) = usdcIs0
            ? initPool(usdc, c1, IHooks(address(0)), fee, spacing, sqrtP)
            : initPool(c1, usdc, IHooks(address(0)), fee, spacing, sqrtP);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 lower = (tick / spacing - 20) * spacing;
        int24 upper = (tick / spacing + 20) * spacing;
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 1e15, salt: 0}), ZERO_BYTES
        );
    }

    function _step(PoolKey memory key, Currency input) internal pure returns (ArcArbExecutor.Step memory) {
        return ArcArbExecutor.Step({kind: 0, zeroForOne: key.currency0 == input, pool: address(0), key: key});
    }

    // ------------------------------------------------------------------
    // (1) start native, end in the ERC-20 form inside the manager
    // ------------------------------------------------------------------

    function test_startNative_endErc20_takesUnitsThenSettlesNative() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _step(nativePool, native); // native -> t1
        steps[1] = _step(usdcCheap, c1); // t1 -> USDC (ERC-20 form)

        uint256 before = address(exec).balance;
        uint256 mgrBefore = address(manager).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        // profit is reported in wei (native units) and is exactly the wallet change
        assertEq(address(exec).balance, before + profit, "native profit equals wallet change");
        // the manager's one balance lost exactly the profit and nothing else
        assertEq(mgrBefore - address(manager).balance, profit, "manager paid exactly the profit");
    }

    // ------------------------------------------------------------------
    // (2) start ERC-20 form, end native inside the manager
    // ------------------------------------------------------------------

    function test_startErc20_endNative_settleIsExactAndProfitIsUnits() public {
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _step(usdcRich, usdc); // USDC -> t1
        steps[1] = _step(nativePool, c1); // t1 -> native

        uint256 before = address(exec).balance;
        uint256 mgrBefore = address(manager).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1_000_000, 1, NO_GUARDS); // 1 USDC in 6-dec units
        assertGt(profit, 0);
        uint256 gained = address(exec).balance - before;
        // reported profit is in 6-decimal units; the wallet moved by that many units of wei, floored
        assertEq(gained / 1e12, profit, "profit units equal floored wei change");
        assertEq(mgrBefore - address(manager).balance, gained, "manager lost exactly what we gained");
    }

    /// @dev Executor wallet holds sub-unit dust: the floored `balanceOf` view may over- or
    ///      under-count by one unit but the settle is exact and the value call has the funds.
    function test_startErc20_endNative_withDust_boundedByOneUnit() public {
        vm.deal(address(exec), 0.999999e12); // just under one unit of dust
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _step(usdcRich, usdc);
        steps[1] = _step(nativePool, c1);

        uint256 before = address(exec).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 1_000_000, 0, NO_GUARDS);
        uint256 gained = address(exec).balance - before;
        // |profit*1e12 - gained| < 1e12
        assertLt(profit * 1e12 > gained ? profit * 1e12 - gained : gained - profit * 1e12, 1e12);
    }

    // ------------------------------------------------------------------
    // Unprofitable mixed shapes revert with the clear error, never an underflow
    // ------------------------------------------------------------------

    function test_mixedUnprofitable_revertsUnprofitable() public {
        // reverse of (1): native -> t1 -> USDC on the rich pool loses ~2%
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](2);
        steps[0] = _step(nativePool, native);
        steps[1] = _step(usdcRich, c1);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(steps, 1e18, 0, NO_GUARDS);

        ArcArbExecutor.Step[] memory steps2 = new ArcArbExecutor.Step[](2);
        steps2[0] = _step(usdcCheap, usdc);
        steps2[1] = _step(nativePool, c1);
        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.Unprofitable.selector);
        exec.execute(steps2, 1_000_000, 0, NO_GUARDS);
    }

    // ------------------------------------------------------------------
    // Closed cycle touching both forms needs no bridging (plain path)
    // ------------------------------------------------------------------

    function test_closedCycleThroughBothForms_plainPath() public {
        // native -> t1 (nativePool) -> USDC (cheap) -> t1 (rich) -> native (nativePool)
        ArcArbExecutor.Step[] memory steps = new ArcArbExecutor.Step[](4);
        steps[0] = _step(nativePool, native);
        steps[1] = _step(usdcCheap, c1);
        steps[2] = _step(usdcRich, usdc);
        steps[3] = _step(nativePool, c1);
        uint256 before = address(exec).balance;
        vm.prank(operator);
        uint256 profit = exec.execute(steps, 0.5e18, 1, NO_GUARDS);
        assertGt(profit, 0);
        assertEq(address(exec).balance, before + profit);
    }
}
