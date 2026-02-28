// ═══════════════════════════════════════════════════════════════════
// V2 ABIs — Multi-standard support (ERC-20/721/1155)
// ═══════════════════════════════════════════════════════════════════

export const BasketFactoryABI = [
  // ─── Write ───
  {
    inputs: [
      { name: "name", type: "string" },
      { name: "tokens", type: "address[]" },
      { name: "standards", type: "uint8[]" },       // V2: 0=ERC20, 1=ERC721, 2=ERC1155
      { name: "tokenIds", type: "uint256[]" },       // V2: token IDs (0 for ERC-20)
      { name: "amounts", type: "uint256[]" },
    ],
    name: "createBasket",
    outputs: [{ name: "basketId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "basketId", type: "uint256" },
      { name: "units", type: "uint256" },
      { name: "linkFee", type: "uint256" },
    ],
    name: "weave",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "basketId", type: "uint256" },
      { name: "units", type: "uint256" },
    ],
    name: "unweave",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // ─── Read ───
  {
    inputs: [{ name: "basketId", type: "uint256" }],
    name: "getComponents",
    outputs: [
      {
        components: [
          { name: "token", type: "address" },
          { name: "standard", type: "uint8" },       // V2
          { name: "tokenId", type: "uint256" },       // V2
          { name: "amount", type: "uint256" },
        ],
        name: "components",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "basketId", type: "uint256" }],
    name: "getBasketInfo",
    outputs: [
      { name: "name", type: "string" },
      { name: "creator", type: "address" },
      { name: "componentCount", type: "uint256" },
      { name: "hasNFT", type: "bool" },               // V2
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "nextBasketId",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "escrow",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    name: "safeTransferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    name: "setApprovalForAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ERC20ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const CCIPBasketBridgeABI = [
  // ─── Write ───
  {
    inputs: [
      { name: "basketId", type: "uint256" },
      { name: "units", type: "uint256" },
      { name: "destChainSelector", type: "uint64" },
      { name: "recipient", type: "address" },
    ],
    name: "sendBasket",
    outputs: [{ name: "messageId", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "basketId", type: "uint256" },
      { name: "units", type: "uint256" },
      { name: "homeChainSelector", type: "uint64" },
      { name: "releaseRecipient", type: "address" },
    ],
    name: "unweaveRemote",
    outputs: [{ name: "messageId", type: "bytes32" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  
  // ─── Read ───
  {
    inputs: [
      { name: "basketId", type: "uint256" },
      { name: "units", type: "uint256" },
      { name: "destChainSelector", type: "uint64" },
    ],
    name: "getFee",
    outputs: [{ name: "fee", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "chainSelector", type: "uint64" }],
    name: "peerBridges",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "basketFactory",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "linkToken",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
