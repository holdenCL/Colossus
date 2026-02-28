// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BasketFactory.sol";
import "../src/Escrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Simple mock ERC-20 for testing
contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BasketFactoryTest is Test {
    BasketFactory public factory;
    Escrow public escrow;
    MockERC20 public link;
    MockERC20 public tokenA;
    MockERC20 public tokenB;

    address public feeRecipient = address(0xfCF0003490d8aB5220d46a41716FDF9a24E68aa1);
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    function setUp() public {
        // Deploy mock tokens
        link = new MockERC20("Chainlink", "LINK");
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");

        // Deploy factory (also deploys escrow)
        factory = new BasketFactory(address(link), feeRecipient);
        escrow = factory.escrow();

        // Fund alice
        link.mint(alice, 1000 ether);
        tokenA.mint(alice, 1000 ether);
        tokenB.mint(alice, 1000 ether);

        // Fund bob
        link.mint(bob, 1000 ether);
        tokenA.mint(bob, 1000 ether);
        tokenB.mint(bob, 1000 ether);
    }

    // --- createBasket tests ---

    function test_createBasket() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10 ether; // 10 TKA per basket unit
        amounts[1] = 5 ether;  // 5 TKB per basket unit

        uint256 id = factory.createBasket("ETH+BTC Basket", tokens, amounts);
        assertEq(id, 1);

        (string memory name, address creator, uint256 count) = factory.getBasketInfo(1);
        assertEq(name, "ETH+BTC Basket");
        assertEq(creator, address(this));
        assertEq(count, 2);
    }

    function test_createBasket_emptyReverts() public {
        address[] memory tokens = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        vm.expectRevert(BasketFactory.EmptyComponents.selector);
        factory.createBasket("Empty", tokens, amounts);
    }

    function test_createBasket_zeroAddressReverts() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(0);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.expectRevert(BasketFactory.ZeroAddress.selector);
        factory.createBasket("Bad", tokens, amounts);
    }

    function test_createBasket_zeroAmountReverts() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenA);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 0;

        vm.expectRevert(BasketFactory.ZeroAmount.selector);
        factory.createBasket("Bad", tokens, amounts);
    }

    // --- weave tests ---

    function test_weave() public {
        // Create basket: 10 TKA + 5 TKB per unit
        uint256 basketId = _createBasket();

        vm.startPrank(alice);

        // Approve escrow for component tokens
        tokenA.approve(address(escrow), type(uint256).max);
        tokenB.approve(address(escrow), type(uint256).max);
        // Approve factory for LINK fee
        link.approve(address(factory), type(uint256).max);

        // Weave 2 units, pay 0.5 LINK fee
        factory.weave(basketId, 2, 0.5 ether);

        vm.stopPrank();

        // Alice should have 2 basket tokens
        assertEq(factory.balanceOf(alice, basketId), 2);

        // Escrow should hold 20 TKA + 10 TKB
        assertEq(tokenA.balanceOf(address(escrow)), 20 ether);
        assertEq(tokenB.balanceOf(address(escrow)), 10 ether);

        // Fee recipient should have 0.5 LINK
        assertEq(link.balanceOf(feeRecipient), 0.5 ether);

        // Alice's balances should be reduced
        assertEq(tokenA.balanceOf(alice), 980 ether);
        assertEq(tokenB.balanceOf(alice), 990 ether);
        assertEq(link.balanceOf(alice), 999.5 ether);
    }

    function test_weave_zeroUnitsReverts() public {
        uint256 basketId = _createBasket();

        vm.prank(alice);
        vm.expectRevert(BasketFactory.ZeroAmount.selector);
        factory.weave(basketId, 0, 0);
    }

    function test_weave_invalidBasketReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BasketFactory.BasketNotFound.selector, 999));
        factory.weave(999, 1, 0);
    }

    // --- unweave tests ---

    function test_unweave() public {
        uint256 basketId = _createBasket();

        // Weave first
        vm.startPrank(alice);
        tokenA.approve(address(escrow), type(uint256).max);
        tokenB.approve(address(escrow), type(uint256).max);
        link.approve(address(factory), type(uint256).max);
        factory.weave(basketId, 2, 0.5 ether);

        // Unweave 1 unit
        factory.unweave(basketId, 1);
        vm.stopPrank();

        // Alice should have 1 basket token remaining
        assertEq(factory.balanceOf(alice, basketId), 1);

        // Escrow should hold 10 TKA + 5 TKB (half released)
        assertEq(tokenA.balanceOf(address(escrow)), 10 ether);
        assertEq(tokenB.balanceOf(address(escrow)), 5 ether);

        // Alice gets tokens back
        assertEq(tokenA.balanceOf(alice), 990 ether);
        assertEq(tokenB.balanceOf(alice), 995 ether);
    }

    function test_unweave_fullRoundTrip() public {
        uint256 basketId = _createBasket();

        vm.startPrank(alice);
        tokenA.approve(address(escrow), type(uint256).max);
        tokenB.approve(address(escrow), type(uint256).max);
        link.approve(address(factory), type(uint256).max);

        // Weave 3 units
        factory.weave(basketId, 3, 1 ether);

        // Unweave all 3
        factory.unweave(basketId, 3);
        vm.stopPrank();

        // No basket tokens
        assertEq(factory.balanceOf(alice, basketId), 0);

        // Escrow should be empty
        assertEq(tokenA.balanceOf(address(escrow)), 0);
        assertEq(tokenB.balanceOf(address(escrow)), 0);

        // Alice gets all component tokens back (LINK fee is gone though)
        assertEq(tokenA.balanceOf(alice), 1000 ether);
        assertEq(tokenB.balanceOf(alice), 1000 ether);
        assertEq(link.balanceOf(alice), 999 ether); // lost 1 LINK in fees
    }

    function test_unweave_insufficientBalanceReverts() public {
        uint256 basketId = _createBasket();

        vm.prank(alice);
        // Alice has no basket tokens, should revert
        vm.expectRevert();
        factory.unweave(basketId, 1);
    }

    // --- Escrow access control ---

    function test_escrow_onlyFactory() public {
        vm.prank(alice);
        vm.expectRevert(Escrow.OnlyFactory.selector);
        escrow.lock(address(tokenA), alice, 1 ether);

        vm.prank(alice);
        vm.expectRevert(Escrow.OnlyFactory.selector);
        escrow.release(address(tokenA), alice, 1 ether);
    }

    // --- Helpers ---

    function _createBasket() internal returns (uint256) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 10 ether;
        amounts[1] = 5 ether;

        return factory.createBasket("Test Basket", tokens, amounts);
    }
}