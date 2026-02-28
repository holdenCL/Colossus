// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Escrow - Multi-standard custodial vault for basket component tokens
/// @notice Holds ERC-20, ERC-721, and ERC-1155 tokens on behalf of BasketFactory.
///         Only the BasketFactory can deposit/withdraw tokens.
///
/// @dev Why three standards?
///      - ERC-20:  Fungible tokens (LINK, WETH, stablecoins). Have an "amount" but no tokenId.
///      - ERC-721: Non-fungible tokens (unique NFTs, RWA deeds). Each has a unique tokenId.
///                 You can only own 1 of each tokenId. amount is always 1.
///      - ERC-1155: Multi-tokens (game items, semi-fungible assets). Have BOTH tokenId AND amount.
///                 You can own multiple copies of the same tokenId.
///
///      The Escrow must implement receiver interfaces (IERC721Receiver, IERC1155Receiver)
///      so that safeTransferFrom calls don't revert when sending tokens TO this contract.
///      Think of it like: the token contract checks "can this address actually hold my tokens?"
///      by calling onERC721Received/onERC1155Received. We return the magic selector to say "yes."
contract Escrow is IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    // --- Token Standard Constants ---
    // These match the values used in BasketFactory.Component.standard

    uint8 public constant STD_ERC20  = 0;
    uint8 public constant STD_ERC721 = 1;
    uint8 public constant STD_ERC1155 = 2;

    // --- State ---

    address public immutable factory;

    // --- Errors ---

    error OnlyFactory();
    error InvalidStandard(uint8 standard);

    // --- Modifiers ---

    modifier onlyFactory() {
        if (msg.sender != factory) revert OnlyFactory();
        _;
    }

    // --- Constructor ---

    constructor(address _factory) {
        factory = _factory;
    }

    // --- Lock (Deposit into Escrow) ---

    /// @notice Lock tokens into escrow. Called by BasketFactory during weave/splice.
    /// @param token    The token contract address
    /// @param standard 0 = ERC-20, 1 = ERC-721, 2 = ERC-1155
    /// @param tokenId  Specific token ID (ERC-721/1155). Ignored for ERC-20.
    /// @param from     Address to pull tokens from (must have approved Escrow)
    /// @param amount   Amount to lock (ERC-20/1155). Must be 1 for ERC-721.
    function lock(
        address token,
        uint8 standard,
        uint256 tokenId,
        address from,
        uint256 amount
    ) external onlyFactory {
        if (standard == STD_ERC20) {
            // ERC-20: user must have called token.approve(escrow, amount)
            IERC20(token).safeTransferFrom(from, address(this), amount);
        } else if (standard == STD_ERC721) {
            // ERC-721: user must have called token.approve(escrow, tokenId)
            //          or token.setApprovalForAll(escrow, true)
            IERC721(token).safeTransferFrom(from, address(this), tokenId);
        } else if (standard == STD_ERC1155) {
            // ERC-1155: user must have called token.setApprovalForAll(escrow, true)
            IERC1155(token).safeTransferFrom(from, address(this), tokenId, amount, "");
        } else {
            revert InvalidStandard(standard);
        }
    }

    // --- Release (Withdraw from Escrow) ---

    /// @notice Release tokens from escrow. Called by BasketFactory during unweave/bridgeRelease.
    /// @param token    The token contract address
    /// @param standard 0 = ERC-20, 1 = ERC-721, 2 = ERC-1155
    /// @param tokenId  Specific token ID (ERC-721/1155). Ignored for ERC-20.
    /// @param to       Address to send tokens to
    /// @param amount   Amount to release (ERC-20/1155). Must be 1 for ERC-721.
    function release(
        address token,
        uint8 standard,
        uint256 tokenId,
        address to,
        uint256 amount
    ) external onlyFactory {
        if (standard == STD_ERC20) {
            IERC20(token).safeTransfer(to, amount);
        } else if (standard == STD_ERC721) {
            IERC721(token).safeTransferFrom(address(this), to, tokenId);
        } else if (standard == STD_ERC1155) {
            IERC1155(token).safeTransferFrom(address(this), to, tokenId, amount, "");
        } else {
            revert InvalidStandard(standard);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Token Receiver Interfaces ───────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    // These functions are called BY the token contracts when someone uses
    // safeTransferFrom to send tokens to this contract. We return the
    // expected "magic value" (the function selector) to signal acceptance.
    // Without these, safeTransferFrom would revert.

    function onERC721Received(
        address, // operator
        address, // from
        uint256, // tokenId
        bytes calldata // data
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(
        address, // operator
        address, // from
        uint256, // id
        uint256, // value
        bytes calldata // data
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address, // operator
        address, // from
        uint256[] calldata, // ids
        uint256[] calldata, // values
        bytes calldata // data
    ) external pure override returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /// @notice ERC-165 interface detection — tells other contracts what interfaces we support
    function supportsInterface(bytes4 interfaceId) external pure override(IERC165) returns (bool) {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
