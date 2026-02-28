// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/contracts/applications/CCIPReceiver.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IBasketFactory {
    struct Component {
        address token;
        uint8   standard;   // 0=ERC20, 1=ERC721, 2=ERC1155
        uint256 tokenId;
        uint256 amount;
    }

    function bridgeBurn(uint256 basketId, uint256 units, address from) external;
    function bridgeMint(uint256 basketId, uint256 units, address to) external;
    function bridgeRelease(uint256 basketId, uint256 units, address to) external;
    function registerBasketFromBridge(
        uint256 basketId,
        string calldata name,
        address[] calldata tokens,
        uint8[] calldata standards,
        uint256[] calldata tokenIds,
        uint256[] calldata amounts,
        address creator
    ) external;
    function getComponents(uint256 basketId) external view returns (Component[] memory);
    function getBasketInfo(uint256 basketId) external view returns (
        string memory name, address creator, uint256 componentCount, bool hasNFT
    );
    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/// @title CCIPBasketBridge - Cross-chain basket transfers with remote unweaving
///
/// @notice This bridge handles three operations via CCIP:
///
///   1. BRIDGE TRANSFER (sendBasket → _handleBridgeTransfer)
///      Move basket tokens between chains. Burns on source, mints on destination.
///      The underlying tokens stay locked in escrow on the home chain.
///
///   2. UNWEAVE REMOTE (unweaveRemote → _handleUnweaveRequest)
///      Redeem a basket from a non-home chain. Burns basket on the remote chain,
///      sends CCIP message to home chain, which releases tokens from escrow.
///      ERC-20 components are CCIP-transferred back to the user's chain (second hop).
///      ERC-721/1155 components are released on the home chain (CCIP can't transfer these).
///
///   The bridge uses message type bytes to distinguish these:
///     MSG_BRIDGE_TRANSFER (0) — basket metadata + mint instructions
///     MSG_UNWEAVE_REQUEST (1) — "release my tokens from escrow"
///
/// @dev Deployed on each chain. Each bridge trusts its peer(s) on other chains.
///      The bridge must be pre-funded with LINK to pay for second-hop CCIP transfers.
///      The bridge implements IERC721Receiver and IERC1155Receiver so it can temporarily
///      hold NFT components during the forwarding process.
contract CCIPBasketBridge is CCIPReceiver, IERC721Receiver, IERC1155Receiver {
    using SafeERC20 for IERC20;

    // --- Token Standard Constants ---

    uint8 public constant STD_ERC20  = 0;
    uint8 public constant STD_ERC721 = 1;
    uint8 public constant STD_ERC1155 = 2;

    // --- Message Types ---

    uint8 public constant MSG_BRIDGE_TRANSFER = 0;
    uint8 public constant MSG_UNWEAVE_REQUEST = 1;

    // --- State ---

    IBasketFactory public immutable basketFactory;
    IERC20 public immutable linkToken;
    address public immutable owner;

    /// @notice Peer bridge addresses: chainSelector => bridge address on that chain
    mapping(uint64 => address) public peerBridges;

    /// @notice Token address mappings: sourceChain => sourceToken => localToken
    mapping(uint64 => mapping(address => address)) public tokenMappings;

    /// @notice Tracks which basket IDs have been registered from a remote chain
    mapping(uint256 => bool) public registeredFromBridge;

    // --- Events ---

    event BasketSent(
        bytes32 indexed messageId,
        uint64 indexed destChainSelector,
        uint256 indexed basketId,
        address sender,
        address recipient,
        uint256 units
    );
    event BasketReceived(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        uint256 indexed basketId,
        address recipient,
        uint256 units
    );
    event UnweaveRequested(
        bytes32 indexed messageId,
        uint64 indexed homeChainSelector,
        uint256 indexed basketId,
        address sender,
        address releaseRecipient,
        uint256 units
    );
    event UnweaveExecuted(
        bytes32 indexed messageId,
        uint64 indexed sourceChainSelector,
        uint256 indexed basketId,
        address recipient,
        uint256 units
    );
    /// @notice Emitted when an ERC-20 component is forwarded via CCIP during remote unweave
    event TokenForwarded(
        bytes32 indexed ccipMessageId,
        uint64 indexed destChainSelector,
        address indexed token,
        uint256 amount,
        address recipient
    );
    /// @notice Emitted when an ERC-20 CCIP forward fails (tokens held in bridge for recovery)
    event TokenForwardFailed(
        address indexed token,
        uint256 amount,
        address recipient,
        string reason
    );
    /// @notice Emitted when ERC-721/1155 components are released on home chain (can't CCIP these)
    event NFTReleasedOnHomeChain(
        uint256 indexed basketId,
        address indexed token,
        uint8 standard,
        uint256 tokenId,
        uint256 amount,
        address recipient
    );
    event PeerBridgeSet(uint64 indexed chainSelector, address peerBridge);
    event TokenMappingSet(uint64 indexed chainSelector, address sourceToken, address localToken);

    // --- Errors ---

    error OnlyOwner();
    error UntrustedSource(uint64 chainSelector, address sender);
    error InvalidPeer();
    error InvalidMapping();
    error UnknownMessageType(uint8 messageType);

    // --- Modifiers ---

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // --- Constructor ---

    constructor(
        address _router,
        address _linkToken,
        address _basketFactory
    ) CCIPReceiver(_router) {
        linkToken = IERC20(_linkToken);
        basketFactory = IBasketFactory(_basketFactory);
        owner = msg.sender;
    }

    // --- Configuration (Owner) ---

    function setPeerBridge(uint64 chainSelector, address peerBridge) external onlyOwner {
        if (peerBridge == address(0)) revert InvalidPeer();
        peerBridges[chainSelector] = peerBridge;
        emit PeerBridgeSet(chainSelector, peerBridge);
    }

    function setTokenMapping(
        uint64 sourceChainSelector,
        address sourceToken,
        address localToken
    ) external onlyOwner {
        if (sourceToken == address(0) || localToken == address(0)) revert InvalidMapping();
        tokenMappings[sourceChainSelector][sourceToken] = localToken;
        emit TokenMappingSet(sourceChainSelector, sourceToken, localToken);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Send Basket Cross-Chain ─────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Send basket tokens to another chain via CCIP
    function sendBasket(
        uint256 basketId,
        uint256 units,
        uint64 destChainSelector,
        address recipient
    ) external returns (bytes32 messageId) {
        address peer = peerBridges[destChainSelector];
        if (peer == address(0)) revert InvalidPeer();

        // Read basket definition before burning
        (string memory name, address creator, , ) = basketFactory.getBasketInfo(basketId);
        IBasketFactory.Component[] memory components = basketFactory.getComponents(basketId);

        // Extract arrays for encoding
        address[] memory tokens = new address[](components.length);
        uint8[] memory standards = new uint8[](components.length);
        uint256[] memory tokenIds = new uint256[](components.length);
        uint256[] memory amounts = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            tokens[i] = components[i].token;
            standards[i] = components[i].standard;
            tokenIds[i] = components[i].tokenId;
            amounts[i] = components[i].amount;
        }

        // Burn basket tokens (escrow untouched)
        basketFactory.bridgeBurn(basketId, units, msg.sender);

        // Encode payload with message type
        bytes memory payload = abi.encode(
            MSG_BRIDGE_TRANSFER,
            basketId,
            units,
            recipient,
            name,
            tokens,
            standards,
            tokenIds,
            amounts,
            creator
        );

        Client.EVM2AnyMessage memory message = _buildMessage(peer, payload, 600_000);

        uint256 fee = IRouterClient(getRouter()).getFee(destChainSelector, message);
        linkToken.safeTransferFrom(msg.sender, address(this), fee);
        linkToken.approve(getRouter(), fee);
        messageId = IRouterClient(getRouter()).ccipSend(destChainSelector, message);

        emit BasketSent(messageId, destChainSelector, basketId, msg.sender, recipient, units);
    }

    /// @notice Get the CCIP fee for sending a basket cross-chain
    function getFee(
        uint256 basketId,
        uint256 units,
        uint64 destChainSelector
    ) external view returns (uint256 fee) {
        address peer = peerBridges[destChainSelector];
        if (peer == address(0)) revert InvalidPeer();

        (string memory name, address creator, , ) = basketFactory.getBasketInfo(basketId);
        IBasketFactory.Component[] memory components = basketFactory.getComponents(basketId);

        address[] memory tokens = new address[](components.length);
        uint8[] memory standards = new uint8[](components.length);
        uint256[] memory tokenIds = new uint256[](components.length);
        uint256[] memory amounts = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            tokens[i] = components[i].token;
            standards[i] = components[i].standard;
            tokenIds[i] = components[i].tokenId;
            amounts[i] = components[i].amount;
        }

        bytes memory payload = abi.encode(
            MSG_BRIDGE_TRANSFER, basketId, units, msg.sender, name,
            tokens, standards, tokenIds, amounts, creator
        );

        Client.EVM2AnyMessage memory message = _buildMessage(peer, payload, 600_000);
        fee = IRouterClient(getRouter()).getFee(destChainSelector, message);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Cross-Chain Unweave (Remote Redemption) ─────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Unweave basket tokens by burning them on this chain and requesting
    ///         component release on the home chain.
    ///
    /// @dev Complete flow:
    ///   1. User calls this on remote chain (e.g. Base Sepolia)
    ///   2. Burns basket ERC-1155 here
    ///   3. CCIP message → home chain: "release and forward components"
    ///   4. Home bridge releases from escrow → forwards ERC-20s via CCIP
    ///   5. ERC-20s arrive on user's chain. NFTs released on home chain.
    ///
    /// @param basketId           The basket to unweave
    /// @param units              Number of units to burn and redeem
    /// @param homeChainSelector  CCIP chain selector where escrow holds the tokens
    /// @param releaseRecipient   Address to receive tokens (same key works on both chains)
    function unweaveRemote(
        uint256 basketId,
        uint256 units,
        uint64 homeChainSelector,
        address releaseRecipient
    ) external returns (bytes32 messageId) {
        address peer = peerBridges[homeChainSelector];
        if (peer == address(0)) revert InvalidPeer();

        // Burn basket tokens on THIS chain
        basketFactory.bridgeBurn(basketId, units, msg.sender);

        // Encode UNWEAVE_REQUEST
        bytes memory payload = abi.encode(
            MSG_UNWEAVE_REQUEST,
            basketId,
            units,
            releaseRecipient
        );

        // Higher gas limit: the handler releases from escrow + does CCIP sends
        Client.EVM2AnyMessage memory message = _buildMessage(peer, payload, 2_000_000);

        uint256 fee = IRouterClient(getRouter()).getFee(homeChainSelector, message);
        linkToken.safeTransferFrom(msg.sender, address(this), fee);
        linkToken.approve(getRouter(), fee);
        messageId = IRouterClient(getRouter()).ccipSend(homeChainSelector, message);

        emit UnweaveRequested(messageId, homeChainSelector, basketId, msg.sender, releaseRecipient, units);
    }

    /// @notice Get the CCIP fee for a remote unweave
    function getUnweaveFee(
        uint256 basketId,
        uint256 units,
        uint64 homeChainSelector
    ) external view returns (uint256 fee) {
        address peer = peerBridges[homeChainSelector];
        if (peer == address(0)) revert InvalidPeer();

        bytes memory payload = abi.encode(
            MSG_UNWEAVE_REQUEST, basketId, units, msg.sender
        );

        Client.EVM2AnyMessage memory message = _buildMessage(peer, payload, 2_000_000);
        fee = IRouterClient(getRouter()).getFee(homeChainSelector, message);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── CCIP Receive (message routing) ──────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    function _ccipReceive(
        Client.Any2EVMMessage memory message
    ) internal override {
        uint64 sourceChainSelector = message.sourceChainSelector;
        address sender = abi.decode(message.sender, (address));

        if (peerBridges[sourceChainSelector] != sender) {
            revert UntrustedSource(sourceChainSelector, sender);
        }

        uint8 messageType = abi.decode(message.data, (uint8));

        if (messageType == MSG_BRIDGE_TRANSFER) {
            _handleBridgeTransfer(message);
        } else if (messageType == MSG_UNWEAVE_REQUEST) {
            _handleUnweaveRequest(message);
        } else {
            revert UnknownMessageType(messageType);
        }
    }

    // ─── Handler: Bridge Transfer ────────────────────────────────────

    function _handleBridgeTransfer(Client.Any2EVMMessage memory message) internal {
        uint64 sourceChainSelector = message.sourceChainSelector;

        (
            , // messageType
            uint256 basketId,
            uint256 units,
            address recipient,
            string memory name,
            address[] memory sourceTokens,
            uint8[] memory standards,
            uint256[] memory tokenIds,
            uint256[] memory amounts,
            address creator
        ) = abi.decode(
            message.data,
            (uint8, uint256, uint256, address, string, address[], uint8[], uint256[], uint256[], address)
        );

        // Register basket on this chain if it doesn't exist yet
        if (!registeredFromBridge[basketId]) {
            // Translate source chain tokens to local equivalents
            address[] memory localTokens = new address[](sourceTokens.length);
            for (uint256 i = 0; i < sourceTokens.length; i++) {
                address mapped = tokenMappings[sourceChainSelector][sourceTokens[i]];
                localTokens[i] = mapped != address(0) ? mapped : sourceTokens[i];
            }

            try basketFactory.registerBasketFromBridge(
                basketId, name, localTokens, standards, tokenIds, amounts, creator
            ) {
                registeredFromBridge[basketId] = true;
            } catch {
                // Basket already exists — fine, just mint
            }
        }

        basketFactory.bridgeMint(basketId, units, recipient);

        emit BasketReceived(message.messageId, sourceChainSelector, basketId, recipient, units);
    }

    // ─── Handler: Unweave Request (second hop) ──────────────────────

    /// @dev This runs on the HOME chain. The basket was already burned on the remote chain.
    ///      Steps:
    ///        1. Release ALL components from escrow to THIS bridge contract
    ///        2. For each ERC-20: CCIP token transfer back to user on their chain
    ///        3. For each ERC-721/1155: transfer directly to user on THIS (home) chain
    ///           (CCIP can't natively transfer NFTs — user picks them up here)
    ///
    ///      The bridge must hold enough LINK to pay for the return CCIP transfers.
    ///      If a transfer fails (unsupported token, insufficient LINK), the tokens
    ///      stay in this contract and can be recovered via withdrawToken().
    function _handleUnweaveRequest(Client.Any2EVMMessage memory message) internal {
        uint64 returnChainSelector = message.sourceChainSelector;

        (
            , // messageType
            uint256 basketId,
            uint256 units,
            address recipient
        ) = abi.decode(message.data, (uint8, uint256, uint256, address));

        // Get component details BEFORE releasing (we need standard info for routing)
        IBasketFactory.Component[] memory components = basketFactory.getComponents(basketId);

        // Release ALL components from escrow → this bridge contract
        // The bridge temporarily holds the tokens before forwarding
        basketFactory.bridgeRelease(basketId, units, address(this));

        // Forward each component to the user
        for (uint256 i = 0; i < components.length; i++) {
            uint256 totalAmount = components[i].amount * units;

            if (components[i].standard == STD_ERC20) {
                // ERC-20: CCIP token transfer back to user's chain
                _forwardERC20ViaCCIP(
                    components[i].token,
                    totalAmount,
                    recipient,
                    returnChainSelector
                );
            } else if (components[i].standard == STD_ERC721) {
                // ERC-721: transfer directly to user on home chain
                // Can't CCIP these — user collects here
                IERC721(components[i].token).safeTransferFrom(
                    address(this), recipient, components[i].tokenId
                );
                emit NFTReleasedOnHomeChain(
                    basketId, components[i].token, STD_ERC721,
                    components[i].tokenId, 1, recipient
                );
            } else if (components[i].standard == STD_ERC1155) {
                // ERC-1155: transfer directly to user on home chain
                IERC1155(components[i].token).safeTransferFrom(
                    address(this), recipient, components[i].tokenId, totalAmount, ""
                );
                emit NFTReleasedOnHomeChain(
                    basketId, components[i].token, STD_ERC1155,
                    components[i].tokenId, totalAmount, recipient
                );
            }
        }

        emit UnweaveExecuted(message.messageId, returnChainSelector, basketId, recipient, units);
    }

    /// @dev Forward a single ERC-20 token back to the user via CCIP.
    ///      This is the "second hop" — tokens flow from escrow → bridge → CCIP → user.
    ///
    ///      CCIP testnet constraint: 1 token per message. So each component gets its own
    ///      CCIP send. The bridge pays LINK for each from its pre-funded balance.
    ///
    ///      If the send fails (unsupported token, insufficient LINK, etc.), the tokens
    ///      stay in this bridge contract rather than reverting the entire unweave.
    ///      The owner can recover stuck tokens via withdrawToken().
    function _forwardERC20ViaCCIP(
        address token,
        uint256 amount,
        address recipient,
        uint64 destChainSelector
    ) internal {
        // Build token transfer message — going directly to user (EOA), no data
        Client.EVMTokenAmount[] memory tokenAmounts = new Client.EVMTokenAmount[](1);
        tokenAmounts[0] = Client.EVMTokenAmount({
            token: token,
            amount: amount
        });

        Client.EVM2AnyMessage memory tokenMessage = Client.EVM2AnyMessage({
            receiver: abi.encode(recipient),
            data: "",  // Pure token transfer, no execution on destination
            tokenAmounts: tokenAmounts,
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: 0,  // No contract execution needed for EOA token receipt
                    allowOutOfOrderExecution: true
                })
            ),
            feeToken: address(linkToken)
        });

        // Estimate fee first (before any approvals)
        try IRouterClient(getRouter()).getFee(destChainSelector, tokenMessage)
            returns (uint256 fee)
        {
            uint256 linkBalance = linkToken.balanceOf(address(this));
            if (linkBalance < fee) {
                emit TokenForwardFailed(token, amount, recipient, "Insufficient LINK for CCIP fee");
                return; // Tokens stay in bridge — recoverable via withdrawToken()
            }

            // Approve router — combine token + fee into one approval when token IS LINK
            // to prevent the fee approval from overwriting the token approval
            if (token == address(linkToken)) {
                linkToken.approve(getRouter(), amount + fee);
            } else {
                IERC20(token).approve(getRouter(), amount);
                linkToken.approve(getRouter(), fee);
            }

            // Send the token via CCIP
            bytes32 ccipMsgId = IRouterClient(getRouter()).ccipSend(destChainSelector, tokenMessage);

            emit TokenForwarded(ccipMsgId, destChainSelector, token, amount, recipient);
        } catch {
            // getFee failed — token probably not supported on this CCIP lane
            emit TokenForwardFailed(token, amount, recipient, "CCIP getFee failed - token may not be supported");
            // Tokens stay in bridge — recoverable via withdrawToken()
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Internal Helpers ────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Build a CCIP arbitrary message (no tokens, data only)
    function _buildMessage(
        address peer,
        bytes memory payload,
        uint256 gasLimit
    ) internal view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(peer),
            data: payload,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: gasLimit,
                    allowOutOfOrderExecution: true
                })
            ),
            feeToken: address(linkToken)
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Token Receiver Interfaces ───────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    // Required so bridgeRelease can send NFTs to this contract temporarily
    // before forwarding to the user.

    function onERC721Received(address, address, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure override returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    /// @notice ERC-165: declare supported interfaces
    /// @dev Must include CCIPReceiver's interface + NFT receiver interfaces
    function supportsInterface(bytes4 interfaceId)
        public pure override(CCIPReceiver, IERC165) returns (bool)
    {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── Recovery Functions (Owner) ──────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Withdraw LINK (for fee management or recovery)
    function withdrawLink() external onlyOwner {
        uint256 balance = linkToken.balanceOf(address(this));
        if (balance > 0) {
            linkToken.safeTransfer(owner, balance);
        }
    }

    /// @notice Withdraw any ERC-20 stuck in the bridge (from failed forwards)
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
    }

    /// @notice Recover a stuck ERC-721 (from failed forward or edge case)
    function withdrawNFT(address token, uint256 tokenId) external onlyOwner {
        IERC721(token).safeTransferFrom(address(this), owner, tokenId);
    }

    /// @notice Recover stuck ERC-1155 tokens
    function withdrawERC1155(address token, uint256 tokenId, uint256 amount) external onlyOwner {
        IERC1155(token).safeTransferFrom(address(this), owner, tokenId, amount, "");
    }
}
