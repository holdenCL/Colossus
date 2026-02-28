// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./Escrow.sol";

// ─── Chainlink ACE PolicyEngine integration ──────────────────────────
import {PolicyProtected} from "@chainlink/policy-management/core/PolicyProtected.sol";
// ─────────────────────────────────────────────────────────────────────

/// @title BasketFactory - Multi-standard token basket creation and management
/// @notice Users weave ERC-20, ERC-721, and ERC-1155 tokens into basket tokens
///         (themselves ERC-1155) and unweave to redeem. Supports cross-chain
///         bridging and remote unweaving via an authorized bridge contract.
///
/// @dev V4 changes (ACE integration):
///      - Inherits PolicyProtected (from Chainlink ACE)
///      - weave() and createBasket() gated with runPolicy() modifier
///      - Bridge operations (bridgeBurn/Mint/Release, registerBasketFromBridge)
///        are NOT gated — compliance at entry point, not infrastructure layer
///      - setBridge() uses Ownable.onlyOwner (replaces custom deployer check)
///      - Constructor adds policyEngine parameter
///
///      Everything else is identical to V3. ABI for all public functions
///      (except constructor) is unchanged — no frontend updates needed.
///
/// @dev Architecture overview:
///      - Each basket has a DEFINITION (list of components) and UNITS (how many minted).
///      - Components can be any mix of ERC-20, ERC-721, and ERC-1155 tokens.
///      - If ANY component is ERC-721 (a unique NFT), the basket is restricted to
///        exactly 1 unit. This is because ERC-721s are unique — you can't lock
///        3 copies of NFT #42 because only 1 exists.
///      - ERC-20 and ERC-1155 baskets can have multiple units (unlimited splicing).
///      - The basket token itself is ERC-1155, so it's transferable and bridgeable.
///
///      Token standard recap:
///        ERC-20:  amount, no tokenId     (LINK, WETH, stablecoins)
///        ERC-721: tokenId, amount is 1   (unique NFTs, RWA deeds)
///        ERC-1155: tokenId AND amount    (game items, semi-fungibles)
contract BasketFactory is ERC1155, PolicyProtected {
    using SafeERC20 for IERC20;

    // --- Token Standard Constants ---

    uint8 public constant STD_ERC20  = 0;
    uint8 public constant STD_ERC721 = 1;
    uint8 public constant STD_ERC1155 = 2;

    // --- Types ---

    struct Component {
        address token;      // Token contract address
        uint8   standard;   // 0 = ERC-20, 1 = ERC-721, 2 = ERC-1155
        uint256 tokenId;    // Specific token ID (ERC-721/1155). 0 for ERC-20.
        uint256 amount;     // Amount per 1 basket unit. Must be 1 for ERC-721.
    }

    struct BasketDef {
        string name;
        Component[] components;
        address creator;
        bool exists;
        bool hasNFT;        // True if any component is ERC-721 → units restricted to 1
    }

    // --- State ---

    Escrow public immutable escrow;
    IERC20 public immutable linkToken;
    address public immutable feeRecipient;
    // NOTE: V3 had `address public immutable deployer` — replaced by Ownable.owner()
    uint256 public constant FEE_BPS = 10; // 0.1% = 10 basis points
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public bridge;  // Authorized CCIP bridge contract
    uint256 public nextBasketId = 1;
    mapping(uint256 => BasketDef) public baskets;

    // --- Events ---

    event BasketCreated(uint256 indexed basketId, string name, address indexed creator, bool hasNFT);
    event Weave(uint256 indexed basketId, address indexed user, uint256 units);
    event Unweave(uint256 indexed basketId, address indexed user, uint256 units);
    event BridgeBurn(uint256 indexed basketId, address indexed from, uint256 units);
    event BridgeMint(uint256 indexed basketId, address indexed to, uint256 units);
    event BridgeRelease(uint256 indexed basketId, address indexed to, uint256 units);
    event BridgeSet(address indexed bridge);

    // --- Errors ---

    error BasketNotFound(uint256 basketId);
    error EmptyComponents();
    error ZeroAmount();
    error ZeroAddress();
    error OnlyBridge();
    error BridgeAlreadySet();
    error BasketAlreadyExists(uint256 basketId);
    error InvalidStandard(uint8 standard);
    error NFTBasketSingleUnit();          // Basket contains ERC-721 → only 1 unit allowed
    error ERC721AmountMustBeOne();        // ERC-721 components must have amount = 1

    // --- Modifiers ---

    modifier onlyBridge() {
        if (msg.sender != bridge) revert OnlyBridge();
        _;
    }

    // --- Constructor ---
    // V4: Added _policyEngine parameter. PolicyProtected sets msg.sender as Ownable owner.

    constructor(
        address _linkToken,
        address _feeRecipient,
        address _policyEngine
    ) ERC1155("") PolicyProtected(msg.sender, _policyEngine) {
        if (_linkToken == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();

        linkToken = IERC20(_linkToken);
        feeRecipient = _feeRecipient;
        escrow = new Escrow(address(this));
    }

    // --- Bridge Configuration ---
    // V4: Uses onlyOwner (from Ownable via PolicyProtected) instead of custom deployer check.

    function setBridge(address _bridge) external onlyOwner {
        if (bridge != address(0)) revert BridgeAlreadySet();
        if (_bridge == address(0)) revert ZeroAddress();
        bridge = _bridge;
        emit BridgeSet(_bridge);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Basket Management ───────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Register a new basket definition
    /// @dev V4: runPolicy() modifier enforces ACE PolicyEngine compliance check.
    function createBasket(
        string calldata name,
        address[] calldata tokens,
        uint8[] calldata standards,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) external runPolicy() returns (uint256 basketId) {
        if (tokens.length == 0) revert EmptyComponents();
        if (tokens.length != standards.length ||
            tokens.length != tokenIds.length ||
            tokens.length != amounts.length) revert EmptyComponents();

        basketId = nextBasketId++;

        BasketDef storage def = baskets[basketId];
        def.name = name;
        def.creator = msg.sender;
        def.exists = true;

        // Loop extracted to internal function to avoid stack-too-deep
        _addComponents(def, tokens, standards, tokenIds, amounts);

        emit BasketCreated(basketId, name, msg.sender, def.hasNFT);
    }

    /// @dev Internal helper — populates components array. Separate function
    ///      frame avoids "stack too deep" from 4 calldata arrays + storage writes.
    function _addComponents(
        BasketDef storage def,
        address[] calldata tokens,
        uint8[] calldata standards,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts
    ) internal {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount();
            if (standards[i] > STD_ERC1155) revert InvalidStandard(standards[i]);

            if (standards[i] == STD_ERC721) {
                if (amounts[i] != 1) revert ERC721AmountMustBeOne();
                def.hasNFT = true;
            }

            def.components.push(Component({
                token: tokens[i],
                standard: standards[i],
                tokenId: tokenIds[i],
                amount: amounts[i]
            }));
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Core Operations ─────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Weave: deposit component tokens and mint basket token(s)
    /// @dev V4: runPolicy() modifier enforces ACE PolicyEngine compliance check.
    function weave(uint256 basketId, uint256 units, uint256 linkFee) external runPolicy() {
        if (units == 0) revert ZeroAmount();
        BasketDef storage def = baskets[basketId];
        if (!def.exists) revert BasketNotFound(basketId);

        // NFT baskets are restricted to exactly 1 unit
        if (def.hasNFT && units != 1) revert NFTBasketSingleUnit();

        // Transfer each component token to escrow
        for (uint256 i = 0; i < def.components.length; i++) {
            Component storage comp = def.components[i];
            uint256 totalAmount = comp.amount * units;

            escrow.lock(
                comp.token,
                comp.standard,
                comp.tokenId,
                msg.sender,
                totalAmount
            );
        }

        // Collect LINK fee
        if (linkFee > 0) {
            linkToken.safeTransferFrom(msg.sender, feeRecipient, linkFee);
        }

        // Mint basket token(s)
        _mint(msg.sender, basketId, units, "");

        emit Weave(basketId, msg.sender, units);
    }

    /// @notice Unweave: burn basket token(s) and release component tokens
    /// @dev NOT gated by runPolicy — users can always redeem.
    function unweave(uint256 basketId, uint256 units) external {
        if (units == 0) revert ZeroAmount();
        BasketDef storage def = baskets[basketId];
        if (!def.exists) revert BasketNotFound(basketId);

        // Burn first (checks balance, reverts if insufficient)
        _burn(msg.sender, basketId, units);

        // Release each component from escrow back to user
        for (uint256 i = 0; i < def.components.length; i++) {
            Component storage comp = def.components[i];
            uint256 totalAmount = comp.amount * units;

            escrow.release(
                comp.token,
                comp.standard,
                comp.tokenId,
                msg.sender,
                totalAmount
            );
        }

        emit Unweave(basketId, msg.sender, units);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Bridge Operations (NOT policy-gated) ────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Burn basket tokens for cross-chain transfer (escrow untouched)
    function bridgeBurn(uint256 basketId, uint256 units, address from) external onlyBridge {
        if (units == 0) revert ZeroAmount();
        if (!baskets[basketId].exists) revert BasketNotFound(basketId);
        _burn(from, basketId, units);
        emit BridgeBurn(basketId, from, units);
    }

    /// @notice Mint basket tokens from cross-chain transfer (no deposits required)
    function bridgeMint(uint256 basketId, uint256 units, address to) external onlyBridge {
        if (units == 0) revert ZeroAmount();
        if (!baskets[basketId].exists) revert BasketNotFound(basketId);
        _mint(to, basketId, units, "");
        emit BridgeMint(basketId, to, units);
    }

    /// @notice Release component tokens from escrow for a cross-chain unweave.
    function bridgeRelease(uint256 basketId, uint256 units, address to) external onlyBridge {
        if (units == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        BasketDef storage def = baskets[basketId];
        if (!def.exists) revert BasketNotFound(basketId);

        for (uint256 i = 0; i < def.components.length; i++) {
            Component storage comp = def.components[i];
            uint256 totalAmount = comp.amount * units;

            escrow.release(
                comp.token,
                comp.standard,
                comp.tokenId,
                to,
                totalAmount
            );
        }

        emit BridgeRelease(basketId, to, units);
    }

    /// @notice Register a basket definition received from bridge (destination chain)
    function registerBasketFromBridge(
        uint256 basketId,
        string calldata name,
        address[] calldata tokens,
        uint8[] calldata standards,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts,
        address creator
    ) external onlyBridge {
        if (baskets[basketId].exists) revert BasketAlreadyExists(basketId);
        if (tokens.length == 0) revert EmptyComponents();
        if (tokens.length != standards.length ||
            tokens.length != tokenIds.length ||
            tokens.length != amounts.length) revert EmptyComponents();

        if (basketId >= nextBasketId) {
            nextBasketId = basketId + 1;
        }

        BasketDef storage def = baskets[basketId];
        def.name = name;
        def.creator = creator;
        def.exists = true;

        _addComponents(def, tokens, standards, tokenIds, amounts);

        emit BasketCreated(basketId, name, creator, def.hasNFT);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── View Functions ──────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    function getComponents(uint256 basketId) external view returns (Component[] memory) {
        if (!baskets[basketId].exists) revert BasketNotFound(basketId);
        return baskets[basketId].components;
    }

    function getBasketInfo(uint256 basketId)
        external
        view
        returns (string memory name, address creator, uint256 componentCount, bool hasNFT)
    {
        BasketDef storage def = baskets[basketId];
        if (!def.exists) revert BasketNotFound(basketId);
        return (def.name, def.creator, def.components.length, def.hasNFT);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── ERC165 Override (resolve ERC1155 + PolicyProtected diamond) ─
    // ═══════════════════════════════════════════════════════════════════

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC1155, PolicyProtected)
        returns (bool)
    {
        return ERC1155.supportsInterface(interfaceId) || PolicyProtected.supportsInterface(interfaceId);
    }
}
