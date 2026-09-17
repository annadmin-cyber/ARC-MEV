// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ArcArbExecutor} from "../../src/ArcArbExecutor.sol";

/// @dev Hostile v3-style pool that (1) names unrelated tokens / native in the callback `data`,
///      (2) spreads its demand over several callbacks, (3) uses a non-canonical selector, and
///      (4) optionally overshoots the hop amount by `extra`. Every callback demands `per` units.
contract SmartDrainPool {
    MockERC20 immutable t0;
    MockERC20 immutable t1;
    address[] names; // what the pool *claims* tokenIn is, per callback
    uint256 immutable give;
    uint256 immutable extra;

    constructor(MockERC20 _t0, MockERC20 _t1, address[] memory _names, uint256 _give, uint256 _extra) {
        t0 = _t0;
        t1 = _t1;
        names = _names;
        give = _give;
        extra = _extra;
    }

    receive() external payable {}

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external
        returns (int256 amount0, int256 amount1)
    {
        (zeroForOne ? t1 : t0).transfer(recipient, give);
        uint256 total = uint256(amountSpecified) + extra;
        uint256 per = total / names.length;
        for (uint256 i = 0; i < names.length; ++i) {
            uint256 ask = i == names.length - 1 ? total - per * (names.length - 1) : per;
            (bool ok, bytes memory ret) = msg.sender.call(
                abi.encodeWithSignature(
                    "someForkSwapCallback(int256,int256,bytes)",
                    zeroForOne ? int256(ask) : -int256(give),
                    zeroForOne ? -int256(give) : int256(ask),
                    abi.encode(names[i])
                )
            );
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        (amount0, amount1) = zeroForOne ? (int256(total), -int256(give)) : (-int256(give), int256(total));
    }
}

contract Review_V3CallbackBoundedTest is Deployers {
    ArcArbExecutor internal exec;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    ArcArbExecutor.Guard[] internal NO_GUARDS;

    MockERC20 internal t0;
    MockERC20 internal t1;
    MockERC20 internal usdc;
    PoolKey internal poolA;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));
        (poolA,) = initPool(currency0, currency1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolA, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100e18, salt: 0}), ZERO_BYTES
        );
        exec = new ArcArbExecutor(manager, owner, operator);

        // Accumulated treasury in every form the claim says is drainable.
        usdc = new MockERC20("USDC", "USDC", 6);
        usdc.mint(address(exec), 1_000_000e6);
        vm.deal(address(exec), 50 ether);
        t1.transfer(address(exec), 5_000e18); // the hostile hop's input token
        t0.transfer(address(exec), 7e18); // the start token
    }

    function _steps(address evil) internal view returns (ArcArbExecutor.Step[] memory steps) {
        steps = new ArcArbExecutor.Step[](2);
        steps[0] = ArcArbExecutor.Step({kind: 0, zeroForOne: true, pool: address(0), key: poolA}); // t0 -> t1 (v4)
        steps[1] = ArcArbExecutor.Step({
            kind: 1,
            zeroForOne: false, // t1 -> t0 on the hostile pool
            pool: evil,
            key: PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))})
        });
    }

    function _names() internal view returns (address[] memory n) {
        n = new address[](3);
        n[0] = address(usdc);
        n[1] = address(0);
        n[2] = address(t1);
    }

    /// Pool stays within the hop amount but names usdc / native / t1 in `data`, via a fork selector,
    /// over three callbacks: it receives exactly the chained hop amount of t1 and nothing else.
    function test_callbackPaysOnlyHopInput_upToHopAmount() public {
        SmartDrainPool evil = new SmartDrainPool(t0, t1, _names(), 1e18 + 1, 0);
        t0.transfer(address(evil), 10e18);

        vm.prank(operator);
        uint256 profit = exec.execute(_steps(address(evil)), 1e18, 1, NO_GUARDS);
        assertEq(profit, 1);

        assertEq(usdc.balanceOf(address(exec)), 1_000_000e6, "unrelated token untouched");
        assertEq(address(exec).balance, 50 ether, "native untouched");
        assertEq(t1.balanceOf(address(exec)), 5_000e18, "input-token treasury untouched");
        assertEq(t0.balanceOf(address(exec)), 7e18 + 1, "start token grew by profit");
        assertEq(usdc.balanceOf(address(evil)), 0);
        assertEq(address(evil).balance, 0);
        // Pool received exactly what the v4 hop produced (the chained amount), not a wei more.
        assertLt(t1.balanceOf(address(evil)), 1e18);
        assertGt(t1.balanceOf(address(evil)), 0.98e18);
    }

    /// One wei over the chained amount, in total across callbacks, reverts and moves nothing.
    function test_callbackOvershootByOneWei_reverts() public {
        SmartDrainPool evil = new SmartDrainPool(t0, t1, _names(), 1e18 + 1, 1);
        t0.transfer(address(evil), 10e18);

        vm.prank(operator);
        vm.expectPartialRevert(ArcArbExecutor.CallbackOverpay.selector);
        exec.execute(_steps(address(evil)), 1e18, 1, NO_GUARDS);

        assertEq(usdc.balanceOf(address(exec)), 1_000_000e6);
        assertEq(address(exec).balance, 50 ether);
        assertEq(t1.balanceOf(address(exec)), 5_000e18);
        assertEq(t0.balanceOf(address(exec)), 7e18);
    }
}
