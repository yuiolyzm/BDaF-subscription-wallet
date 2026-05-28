# Proposal: On-Chain Subscription Payment Wallet via ERC-4337 Account Abstraction

## Project Description

Use ERC-4337 Account Abstraction to implement a programmable on-chain
subscription payment wallet — a chain-native analogue to credit-card
recurring billing (e.g., Stripe Billing). Users authorize specific
merchants with on-chain constraints (max amount per charge, charge
interval, expiry); merchants can then pull payments via UserOperations,
but only within the granted bounds. Authorizations are revocable at any
time with a single transaction.

---

## Deliverables

- **SmartWallet.sol**: ERC-4337 compliant Smart Account with embedded
  subscription module (createSubscription / cancelSubscription / charge),
  enforcing time-lock, amount-cap, and expiry constraints.
- **SmartWalletFactory.sol**: CREATE2-based wallet deployment.
- **Unit tests and integration tests**: unit tests covering signature
  verification, time-lock, amount-cap, reentrancy resistance, and
  revocation (using MockEntryPoint); integration tests covering the
  full UserOperation flow against a local EntryPoint deployment.
- **Security analysis report**: threat model covering each participant's
  incentive to misbehave (merchant, bundler, EntryPoint upgrade),
  corresponding defensive design decisions, and key trade-offs.
- **Demo scripts** showing three subscription modes: fixed (Netflix-type),
  billing-style (variable amount within cap), and usage-based (small +
  frequent charges) — all supported by the same charge() function via
  parameter configuration.

---

## What are you aiming to LEARN?

**1. ERC-4337 architecture in depth**
The separation of responsibilities between EntryPoint, Bundler, Smart
Account, and Paymaster; the UserOperation lifecycle (validation phase
vs. execution phase); and why this design enables features that are
structurally impossible under traditional EOA-based accounts.

**2. Smart contract security design patterns**
Implementing the Checks-Effects-Interactions pattern and
defense-in-depth (re-validating constraints inside the contract beyond
EntryPoint-level checks); reasoning about reentrancy risk across a
multi-call chain (EntryPoint → SmartWallet → Merchant). The concrete
anchor is ERC-4337's explicit separation of `validateUserOp` from the
execution phase.

**3. Translating known software-engineering patterns into Solidity**
Applying interface design and mock-based testing — concepts already
practiced in JavaScript — to a Solidity + Hardhat environment, and
understanding how EVM constraints (gas cost of storage reads, `call`
vs `delegatecall`) create different design trade-offs compared to
traditional OOP.

**4. Cryptographic primitives in EVM context**
Understanding how EIP-191 signed messages and EIP-712 structured data
work at the byte level; how `ecrecover` is used inside `validateUserOp`
to verify signatures; and why the hash construction matters for
replay-attack resistance across chains and contracts.

**5. Business-to-protocol mapping and the real value of on-chain enforcement**
Translating real-world subscription models (fixed-fee /
variable-with-cap / usage-based) into a single programmable
authorization primitive; and building a concrete threat model for the
subscription payment scenario — analyzing each participant's incentive
(merchants are incentivized to overcharge or double-charge, bundlers
may front-run, EntryPoint upgrades can invalidate existing
authorizations), mapping those threats to defensive contract design,
and understanding where on-chain enforcement provides guarantees that
traditional payment rails structurally cannot.

---

## Relevant Links

**Technical:**
- ERC-4337 spec:
  https://eips.ethereum.org/EIPS/eip-4337
- Account Abstraction reference implementation:
  https://github.com/eth-infinitism/account-abstraction
- ERC-4337 PackedUserOperation spec:
  https://eips.ethereum.org/EIPS/eip-4337#the-useroperation-structure
- OpenZeppelin ECDSA library:
  https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography

**Non-technical:**
- Stripe Billing documentation (the off-chain analogue this project
  emulates on-chain):
  https://docs.stripe.com/billing
- Vitalik Buterin, "Why we need wide adoption of social recovery
  wallets" (motivation for Account Abstraction):
  https://vitalik.eth.limo/general/2021/01/11/recovery.html
