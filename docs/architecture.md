# System Architecture Document — BDaF Subscription Wallet

> ERC-4337 Subscription Wallet Project
> Version: 1.0 | EntryPoint v0.7 | Solidity 0.8.28

---

## 1. Project Overview

### 1.1 Goals

Implement an on-chain subscription wallet based on ERC-4337 (Account Abstraction) to migrate traditional credit card subscription authorization logic onto the blockchain, providing:

- **Verifiable Charge Conditions**: Amount, interval, and expiration are hardcoded within the contract state, preventing merchants from bypassing them.
- **Instant Revocation**: Users can cancel a subscription at any time via a single transaction.
- **Coexistence of Three Subscription Modes**: Netflix (Fixed), Billing (Variable), and Usage-based models are all implemented seamlessly via a single `charge()` function.

### 1.2 Differences from Stripe Billing

| Feature | Stripe Billing | This Project |
|---|---|---|
| **Trust Model** | Trust Stripe as a centralized entity | Trust the immutable smart contract code |
| **Authorization Storage** | Stripe's centralized database | On-chain `SmartWallet.subscriptions` mapping |
| **Revocation Method** | Contact Stripe / Log into dashboard | Call contract `cancelSubscription()` directly |
| **Merchant-sponsored Gas**| N/A | Supported via optional Paymaster integration |
| **Auditability** | Requires trusting Stripe's internal audits | Open-source, Etherscan-verified source code |

### 1.3 Scope

- **Tier 1**: Core Smart Contract Wallet + UserOperation workflow ✓
- **Tier 2**: Subscription logic (3 modes) + Cancel + Time Lock ✓
- **Tier 3**: Paymaster design analysis (no implementation) + Security analysis ✓
- **Excluded**: Social recovery, Multi-sig, Cross-chain support

---

## 2. ERC-4337 Role Mapping

```
┌──────────────────────────────────────────────────────────────┐
│                    ERC-4337 Overall Architecture             │
└──────────────────────────────────────────────────────────────┘

  User EOA            Bundler             EntryPoint          SmartWallet
(Signs UserOp)     (Bundles & Sends)     (Canonical v0.7)   (This Project)
     │                   │                   │                   │
     │── sign userOp ───▶│                   │                   │
     │                   │                   │                   │
     │                   │── handleOps ─────▶│                   │
     │                   │                   │                   │
     │                   │                   │── validateUserOp ▶│
     │                   │                   │                   │
     │                   │                   │◀── return 0/1 ────│
     │                   │                   │                   │
     │                   │                   │── execute ───────▶│
     │                   │                   │                   │
     │                   │                   │◀── (result) ──────│
     │                   │                   │                   │
     │                   │◀── refund ────────│                   │
```

### 2.1 Role Responsibilities

| Role | Implementation Source | Responsibility |
|------|---------|------|
| **User EOA** | External wallet (e.g., Rabby) | Signs the `UserOperation` (does not send tx, requires no ETH) |
| **Bundler** | Alchemy (Sepolia) / Hardhat signer (local) | Collects UserOps, packages them into a tx, and submits to EntryPoint |
| **EntryPoint** | Canonical v0.7 (`0x0000...da032`) | Enforces the verification loop, deducts gas, and refunds the bundler |
| **SmartWallet** | `contracts/SmartWallet.sol` | Handles `validateUserOp` + core business logic (`charge` / `cancel`) |
| **SmartWalletFactory** | `contracts/SmartWalletFactory.sol` | Deploys wallets deterministically using `CREATE2` |
| **MockMerchant** | `contracts/mocks/MockMerchant.sol` | Simulates a merchant receiving funds + verifies CEI compliance |
| **Paymaster** | Not implemented | Modeled and analyzed in `security-analysis.md` |

---

## 3. Contract List

### 3.1 SmartWallet.sol

The core subscription wallet contract for each user. The constructor hardcodes the `owner` and `entryPoint`, making it immutable and non-upgradable.

**State Variables**:
```solidity
address public immutable owner;
address public immutable entryPoint;
mapping(bytes32 => Subscription) public subscriptions;
uint256 public subscriptionNonce; // for unique subscriptionId generation
```

**Subscription Struct**:
```solidity
struct Subscription {
    address merchant;              // Merchant receiving address
    uint256 maxAmountPerCharge;    // Maximum allowable amount per charge
    uint256 interval;              // Minimum required seconds between two charges
    uint256 expiry;                // Overall expiration time (Unix timestamp)
    uint256 lastChargedAt;         // Timestamp of the last charge (for CEI reentrancy defense)
    bool active;                   // Set to false upon cancellation
}
```

**External Functions**:

| Function | Access Control | Purpose |
|----------|--------|------|
| `validateUserOp(userOp, userOpHash, missingAccountFunds)` | `onlyEntryPoint` | Standard ERC-4337 validation entrypoint |
| `execute(target, value, data)` | `onlyEntryPoint` OR `onlyOwner` | Executes arbitrary calls from the wallet |
| `createSubscription(merchant, max, interval, expiry)` | `onlyOwner` | Creates and authorizes a new subscription |
| `cancelSubscription(subId)` | `onlyOwner` | Revokes an active subscription |
| `charge(subId, amount)` | `public` (Governed by subscriptionId validity) | Triggered by the merchant or self-call to pull funds |

### 3.2 SmartWalletFactory.sol

A `CREATE2` deployer contract used to instantiate all user wallets.

**Functions**:
- `getWalletAddress(owner, salt)`: Pre-calculates the wallet address (counterfactual address generation).
- `createWallet(owner, salt)`: Deploys the wallet contract (idempotent; returns the existing address if already deployed).

### 3.3 MockMerchant.sol

A test contract designed to simulate merchant behavior and strictly validate CEI patterns.

**State Variables**:
- `totalReceived`: Cumulative ETH received.
- `reentryCount`: Count of successful reentrancy attacks (should remain `0` if CEI functions correctly).
- `targetWallet` / `targetSubId`: Execution targets for the reentrancy attempt.

**Key Behavior** — Inside `receive()`, attempts to re-enter `charge()`:
```solidity
receive() external payable {
    totalReceived += msg.value;
    if (targetSubId != bytes32(0)) {
        try targetWallet.charge(targetSubId, 1) {
            reentryCount++;  // Only increments if CEI fails
        } catch {
            // Expected path: Reentrancy blocked by CEI checks
        }
    }
}
```

### 3.4 MockEntryPoint.sol

Used exclusively for local Hardhat unit testing to eliminate mainnet/testnet fork dependencies. Canonical EntryPoint is utilized on Sepolia.

---

## 4. Unified Architecture for the Three Modes (Core Design)

### 4.1 Design Philosophy

**Modes are parameter spaces, not logical branches.** The single `charge()` function adapts to three distinct business models entirely based on the parameter configuration passed to `createSubscription`, bypassing complex `if-else` branching:

```solidity
function charge(bytes32 subId, uint256 amount) external {
    Subscription storage s = subscriptions[subId];
    require(s.active);
    require(amount <= s.maxAmountPerCharge);
    require(block.timestamp >= s.lastChargedAt + s.interval);
    require(block.timestamp < s.expiry);
    s.lastChargedAt = block.timestamp;
    (bool ok, ) = s.merchant.call{value: amount}("");
    require(ok);
}
```

### 4.2 Parameter Matrix by Mode

| Mode | maxAmountPerCharge | interval | expiry | Behavior |
|------|--------------------|----------|--------|------|
| **Netflix** | == Subscription Fee | 30 days | Long | Fixed recurring monthly fee |
| **Billing** | > Expected Invoice | 30 days | Long | Post-paid billing (merchant specifies variable amount within cap) |
| **Usage** | Small amount | Short (e.g., 30 sec for demo) | Short (30 days) | High-frequency micropayments |

### 4.3 Why This Architecture Beats Three Separate Functions

| Metric | Three Separate Functions | Unified `charge()` |
|------|------------|--------------|
| **Code Volume** | 3x | 1x |
| **Attack Surface** | 3 Entrypoints | 1 Entrypoint |
| **Audit Cost** | High | Low |
| **Extensibility** | Requires writing new functions | Requires configuring new parameter sets |

---

## 5. UserOperation Lifecycle

### 5.1 End-to-End Workflow (Example: `charge` UserOp)

```
1. User EOA constructs the UserOp on the client-side:
   - sender = wallet address
   - callData = execute(wallet, 0, charge(subId, amount))
   - Computes userOpHash via EntryPoint.getUserOpHash
   - signature = owner.signMessage(userOpHash) (EIP-191 standard)

2. Bundler receives the UserOp:
   - eth_estimateUserOperationGas → Bundler simulates gas usage
   - eth_sendUserOperation → UserOp is submitted to the mempool

3. Bundler bundles the UserOp into a standard Ethereum transaction:
   - tx.from = Bundler EOA
   - tx.to = EntryPoint
   - tx.data = handleOps([userOp], beneficiary)
   - tx.value = 0

4. Block proposer mine and includes the tx into a block.

5. EntryPoint.handleOps executes:
   a. Validation Phase:
      - Invokes wallet.validateUserOp(...)
      - Wallet validates signature via ECDSA cryptography (ecrecover)
      - Wallet prepays missing funds to the EntryPoint (prefund)
      - Returns 0 to signify valid validation
   b. Execution Phase:
      - Invokes wallet.execute(target, value, callData)
      - execute internally invokes charge(subId, amount) via self-call
      - charge executes the CEI workflow
      - ETH is transferred to the merchant

6. EntryPoint calculates actual gas used and refunds the remaining balance to the Bundler.

7. EntryPoint emits UserOperationEvent(success=true).
```

### 5.2 Counterfactual Deployment (First UserOp Edge Case)

If the wallet hasn't been deployed yet, the first UserOp appends the `initCode = factory_address ++ createWallet(owner, salt)`:

```
EntryPoint.handleOps:
  - Detects that the sender account is not yet deployed
  - Extracts factory and factoryData from initCode
  - Calls factory.createWallet(owner, salt) to deploy the wallet
  - Continues to validateUserOp + execute within the same atomic transaction
```

**Outcome**: Deployment and the initial operation are completed atomically in one transaction.

---

## 6. Signature Mechanism

### 6.1 `userOpHash` Calculation (ERC-4337 v0.7)

```
userOpHash = keccak256(abi.encode(
    keccak256(packedUserOpWithoutSignature),
    entryPointAddress,
    chainId
))
```
Includes `entryPointAddress` and `chainId` to prevent cross-network and cross-version replay attacks.

### 6.2 EIP-191 Signature

```
ethSignedHash = keccak256("\x19Ethereum Signed Message:\n32" ++ userOpHash)
signature = sign(ethSignedHash, ownerPrivateKey)
```
The client-side uses `ethers.signMessage(getBytes(userOpHash))`, matching `MessageHashUtils.toEthSignedMessageHash` + `ECDSA.recover` on the contract side.

**Rationale for choosing EIP-191 over EIP-712**:
- As a learning-focused project, the priority is core contract logic rather than front-end UX.
- EIP-191 yields a clean, concise implementation that is straightforward to explain.
- Production environments typically pivot to EIP-712 for human-readable typed fields.

---

## 7. Deployment Architecture

### 7.1 Sepolia Deployment (Verified)

| Contract | Address | Status / Etherscan |
|---|---|---|
| **EntryPoint (canonical v0.7)** | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Pre-existing |
| **SmartWalletFactory** | `0x350A8816A25B684cF69cc92a307ba5D67CEb9cDf` | ✓ Verified |
| **MockMerchant** | `0x2C34FC872D1057Dd9C9ED7B0c682f11eAA9f02E5` | ✓ Verified |
| **Demo SmartWallet** | `0xf63D252CeFd11e269809520D297a9dE9804f0206` | Deployed via `CREATE2` |

### 7.2 Role Accounts

| Role | Source |
|------|--------|
| **Deployer** | `DEPLOYER_KEY` (Deploys factory + merchant) |
| **Owner** | `OWNER_KEY` (Controls and owns the smart wallet) |
| **Bundler (local)** | Hardhat automated signer |
| **Bundler (Sepolia)** | Alchemy Bundler Service |

---

## 8. Dual-Route Testing and Demonstration

### 8.1 Route Comparison

| Metric | Local (`scripts/demo.js`) | Sepolia (`scripts/demo-sepolia.js`) |
|---|---|---|
| **Bundler** | Simulating manually via Hardhat signer | Real Alchemy Bundler network infrastructure |
| **Submission** | Direct call to `entryPoint.handleOps()` | 4 standard JSON-RPC calls (`eth_sendUserOperation`, etc.) |
| **Simulation** | None | Prefund and execution simulation enforced by Bundler |
| **Failed Ops** | Lands on-chain with `success=false` | Rejected during the Bundler simulation phase directly |
| **Time Controls** | Manipulated via `evm_increaseTime` | Real-time elapsed waiting intervals |
| **Reputation** | Excluded | Enforced via ERC-7562 |

### 8.2 Complementary Values of the Dual Methodology

- **Local Proof**: Validates core smart contract business logic, CEI protection against reentrancy, access control restrictions, and multi-mode architecture execution.
- **Sepolia Proof**: Validates compatibility with live bundlers, proof of compliance with reputation guidelines, gas optimization metrics, and real-world mempool conditions.

The key divergence occurs in Phase 4:
- Local testing registers a reverted operation on-chain as `success=false`.
- Sepolia environment results in the bundler **outright rejecting the transaction simulation** (providing a more robust security model).

---

## 9. Test Coverage Matrix

| Test Type | Tools Used | Scope Covered |
|---------|------|------|
| **Unit Tests** | Hardhat + Chai | `createSubscription`, `charge`, `cancel`, `validateUserOp` |
| **Integration** | Hardhat local fork | Complete atomic `UserOperation` loop |
| **End-to-End (Local)** | `scripts/demo.js` | 4 phases across all 3 subscription configurations |
| **End-to-End (Sepolia)** | `scripts/demo-sepolia.js` | Live bundler execution traversing 7 signed UserOps |
| **Reentrancy Validation** | MockMerchant Strategy B | Confirms `totalReceived == amount` and `reentryCount == 0` |

---

## 10. Future Work

The following features sit outside the current project scope but are architected for future expansion:

### 10.1 Paymaster Integration
Enables merchants to sponsor gas fees for users. Detailed architectural analysis is logged in `security-analysis.md`.

### 10.2 Social Recovery
Extends the ownership model from a single EOA to a multi-sig or guardian-based model to protect against key loss.

### 10.3 Upgrade to EIP-712 Signatures
Replaces basic EIP-191 signatures with structured EIP-712 typed data to show clear, human-readable authorization cards to the user during signing.

### 10.4 Cross-EntryPoint Extensibility
The `entryPoint` variable is bound as an `immutable` storage item. Production designs usually deploy a proxy structure to allow migration to updated EntryPoint versions.

### 10.5 Calendar-Aware Intervals
Replaces raw second-based math for tracking time intervals with a calendar-aware oracle to accommodate varying days in months and leap years.

### 10.6 Front-Running Mitigation
Currently, a cancellation transaction floating in the public mempool faces a 1x cap front-running exposure. Future fixes include commit-reveal structures or submitting via private mempools (e.g., Flashbots).

---

## Appendix A: File Directory Structure

```
contracts/
├── SmartWallet.sol               # Main wallet implementation
├── SmartWalletFactory.sol        # CREATE2 factory deployer
├── interfaces/
│   └── ISmartWallet.sol         # Core system interfaces
└── mocks/
    ├── MockEntryPoint.sol       # Local testing entrypoint stub
    └── MockMerchant.sol         # Reentrancy check mock contract

scripts/
├── deploy.js                    # Factory + Merchant deployment script
├── demo.js                      # Local self-bundling pipeline demonstration
└── demo-sepolia.js              # Sepolia end-to-end bundler validation script

test/
├── SmartWallet.test.js
├── SmartWalletFactory.test.js
└── helpers/userOp.js

docs/
├── spec.md                      # Functional Specifications
├── architecture.md              # Current Architectural Document
├── security-analysis.md         # Comprehensive Security Analysis
├── learning-checklist.md        # Defense and Q&A Preparation Checklist
└── progress.md                  # Development Progress Log
```
