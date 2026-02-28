import { getAddress, type Address } from "viem";

// ─── Chain Selectors (CCIP) ───
export const CHAIN_SELECTORS = {
  sepolia: 16015286601757825753n,
  baseSepolia: 10344971235874465080n,
} as const;

// ─── Chain IDs ───
export const CHAIN_IDS = {
  sepolia: 11155111,
  baseSepolia: 84532,
} as const;

// ─── Per-chain contract addresses ───
export type ChainContracts = {
  basketFactory: Address;
  escrow: Address;
  bridge: Address;
  link: Address;
  ccipRouter: Address;
  chainSelector: bigint;
};

// ╔═══════════════════════════════════════════════════════════════════╗
// ║  V4 ADDRESSES — Deployed 2026-02-24 (ACE PolicyEngine)          ║
// ╚═══════════════════════════════════════════════════════════════════╝

export const SEPOLIA: ChainContracts = {
  basketFactory: getAddress("0x885eC430c471a74078C7461Fd9F44D32cB019d3D"),
  escrow: getAddress("0x08906403F95bDaa81327D1F28d3C5EC5d1DDA686"),
  bridge: getAddress("0xC81b80bc1B1047DDEd6AE86Dca1EB1945eee1051"),
  link: getAddress("0x779877A7B0D9E8603169DdbD7836e478b4624789"),
  ccipRouter: getAddress("0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59"),
  chainSelector: CHAIN_SELECTORS.sepolia,
};

export const BASE_SEPOLIA: ChainContracts = {
  basketFactory: getAddress("0xcf26e052aa417cEb1641e8B7eA806F388Cc9a022"),
  escrow: getAddress("0xF1F02bA1CcaFAFf26a9e872d2157a054125f6Bd5"),
  bridge: getAddress("0xff4bbE0428398012D96C2D70385a9bFf421d43Ff"),
  link: getAddress("0xE4aB69C077896252FAFBD49EFD26B5D171A32410"),
  ccipRouter: getAddress("0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93"),
  chainSelector: CHAIN_SELECTORS.baseSepolia,
};

// ─── Chain lookup by chain ID ───
export const CHAINS: Record<number, ChainContracts> = {
  [CHAIN_IDS.sepolia]: SEPOLIA,
  [CHAIN_IDS.baseSepolia]: BASE_SEPOLIA,
};

// ─── Destination options (for bridge UI dropdown) ───
export const BRIDGE_DESTINATIONS: { name: string; chainId: number; selector: bigint }[] = [
  { name: "Sepolia", chainId: CHAIN_IDS.sepolia, selector: CHAIN_SELECTORS.sepolia },
  { name: "Base Sepolia", chainId: CHAIN_IDS.baseSepolia, selector: CHAIN_SELECTORS.baseSepolia },
];

// ─── Defaults: used for initial UI state before wallet connects ───
export const DEFAULTS = {
  link: SEPOLIA.link,
};
