import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from "viem";

/**
 * TypeScript client for SetraPaymentIntent (contracts/src/SetraPaymentIntent.sol).
 * The ABI below is the subset Setra uses and must stay in sync with ISetraPaymentIntent.sol,
 * `contracts-client` tests compare it against the compiled artifact.
 */

const termsTuple = {
  type: "tuple",
  name: "terms",
  components: [
    { name: "merchant", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "ref", type: "bytes32" }
  ]
} as const;

export const PAYMENT_INTENT_ABI = [
  { type: "function", name: "intentIdOf", stateMutability: "view", inputs: [termsTuple], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "pay", stateMutability: "nonpayable", inputs: [termsTuple], outputs: [{ name: "intentId", type: "bytes32" }] },
  {
    type: "function",
    name: "payWithPermit",
    stateMutability: "nonpayable",
    inputs: [termsTuple, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }],
    outputs: [{ name: "intentId", type: "bytes32" }]
  },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [termsTuple], outputs: [{ name: "intentId", type: "bytes32" }] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [termsTuple], outputs: [{ name: "intentId", type: "bytes32" }] },
  { type: "function", name: "stateOf", stateMutability: "view", inputs: [termsTuple], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "event",
    name: "PaymentIntentPaid",
    anonymous: false,
    inputs: [
      { name: "intentId", type: "bytes32", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "ref", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "PaymentIntentCancelled",
    anonymous: false,
    inputs: [
      { name: "intentId", type: "bytes32", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "ref", type: "bytes32", indexed: false }
    ]
  },
  {
    type: "event",
    name: "PaymentIntentRefunded",
    anonymous: false,
    inputs: [
      { name: "intentId", type: "bytes32", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "ref", type: "bytes32", indexed: false }
    ]
  }
] as const;

/** SetraBooksAttestation: a business publishes the Merkle root of a closed month from its own wallet. */
export const BOOKS_ATTESTATION_ABI = [
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "book", type: "bytes32" },
      { name: "period", type: "uint32" },
      { name: "root", type: "bytes32" },
      { name: "entryCount", type: "uint32" }
    ],
    outputs: [{ name: "version", type: "uint32" }]
  },
  {
    type: "event",
    name: "BooksAttested",
    anonymous: false,
    inputs: [
      { name: "publisher", type: "address", indexed: true },
      { name: "book", type: "bytes32", indexed: true },
      { name: "period", type: "uint32", indexed: true },
      { name: "root", type: "bytes32", indexed: false },
      { name: "entryCount", type: "uint32", indexed: false },
      { name: "version", type: "uint32", indexed: false }
    ]
  }
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false }
    ]
  }
] as const;

export interface IntentTerms {
  merchant: Address;
  token: Address;
  amount: bigint;
  expiresAt: bigint; // unix seconds
  ref: Hex; // bytes32
}

/** The opaque onchain reference for a Setra intent id: keccak256("setra:" + id). Reveals nothing about the invoice. */
export function intentReference(setraIntentId: string): Hex {
  return keccak256(stringToHex(`setra:${setraIntentId}`));
}

/** Mirrors SetraPaymentIntent.intentIdOf, computed offchain, no transaction required. */
export function computeIntentId(chainId: number, contract: Address, terms: IntentTerms): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, address, address, address, uint256, uint64, bytes32"), [
      BigInt(chainId),
      contract,
      terms.merchant,
      terms.token,
      terms.amount,
      terms.expiresAt,
      terms.ref
    ])
  );
}
