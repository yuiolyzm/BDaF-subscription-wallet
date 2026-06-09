# Security Analysis Document — BDaF Subscription Wallet

> Subscription Wallet Contract Security Analysis + Attack Vector Mapping + Mitigation Verification
> Version: 1.0 | Corresponds to SmartWallet.sol Solidity 0.8.28

---

## 1. Threat Model

### 1.1 Protected Assets

- **User ETH Balance**: Deposited and held natively within the `SmartWallet` balance.
- **Subscription Authorizations**: Parameters locked inside the `subscriptions` mapping state (`active`, `cap`, `interval`, `expiry`).
- **Owner Governance**: Root control handled through the cryptographic signature of the owner's private key.

### 1.2 Potential Attack Vectors & Actors

| Attacker Profile | Motivation | Capability |
|-------|------|------|
| **Malicious Merchant** | Overcharging user accounts / charging post-cancellation | Invokes `charge()`, can monitor and front-run the public mempool |
| **Malicious Third Party**| Spoofing user execution / stealing wallet funds | Submits arbitrary UserOps, monitors mempool transactions |
| **Malicious Bundler** | Censoring user transactions / colluding with merchants | Can censor or delay UserOps; cannot alter signature payload |
| **Compromised User** | Not a threat actor, but represents operational risk | Private key lost, stolen, or entirely unavailable |

### 1.3 Trust Assumptions

| Entity | Trust Level | Justification |
|---------|---------|------|
| **EVM Execution Environment**| Absolute Trust | Core layer protocol guarantees |
| **EntryPoint v0.7 Contract** | Absolute Trust | Canonical canonical deployment, audited code |
| **OpenZeppelin Standard Libraries**| High Trust | Production-grade industry standards |
| **Bundler Infrastructure** | **Zero Trust** | May censor or front-run, but cannot modify signatures |
| **Merchant Entities** | **Zero Trust** | May attempt overcharging or front-running cancellations |
| **Paymaster (If applicable)**| Partial Trust | Sandboxed and strictly limited by ERC-4337 validation rules |

---

## 2. Defensive Mechanisms

### 2.1 Layered Access Control

| Function | Modifier | Rationale |
|----------|---------|------|
| `validateUserOp` | `onlyEntryPoint` | Restricts account validation triggering exclusively to the EntryPoint |
| `execute` | `onlyEntryPoint` OR `onlyOwner` | Allows UserOp execution pathways alongside direct owner call pathways |
| `createSubscription` | `onlyOwner` | Confines subscription authorization power strictly to the user |
| `cancelSubscription` | `onlyOwner` | Restricts cancellation rights entirely to the user |
| `charge` | `public` | Globally executable, but completely gated by `subscriptionId` rules |

**Critical Edge-Case Design**: The `onlyOwner` design explicitly isolates `address(this)` to block a contract from accidentally bypassing permissions via inner self-calls:

```solidity
require(
    msg.sender == entryPoint || msg.sender == owner,
    "SmartWallet: not authorized"
);
// Note: address(this) is explicitly excluded from the permitted access list
```

### 2.2 Three-Layer Charge Protection

Every execution of `charge()` must successfully pass through a three-layer validation matrix:

| Defense Line | Mitigation Target | Failure Consequence |
|------|------|------|
| `amount <= s.maxAmountPerCharge` | Single transaction drainage | Merchant could drain the entire wallet balance in one go |
| `block.timestamp >= lastChargedAt + interval` | High-frequency burst charging | Merchant could submit multiple drain calls in a single block |
| `block.timestamp < s.expiry` | Perpetual authorization risk | Merchant could charge indefinitely, ignoring user loss-of-activity |

**Mathematical Risk Boundary**:
The combination of these three defenses establishes an absolute cap on worst-case financial exposure:
```
Maximum Allowable Drain = maxAmountPerCharge × ⌊(expiry - now) / interval⌋
```
This loss is deterministic and bounded, enabling users to evaluate their maximum financial exposure before signing the initialization transaction.

### 2.3 CEI (Checks-Effects-Interactions) Protection Against Reentrancy

**Correct Execution Ordering** (Implemented within `SmartWallet.charge`):

```solidity
function charge(bytes32 subId, uint256 amount) external {
    // C — Checks
    require(s.active);
    require(amount <= s.maxAmountPerCharge);
    require(block.timestamp >= s.lastChargedAt + s.interval);
    require(block.timestamp < s.expiry);
    
    // E — Effects (State updated prior to external call)
    s.lastChargedAt = block.timestamp;
    
    // I — Interactions (External contract call executed last)
    (bool ok, ) = s.merchant.call{value: amount}("");
    require(ok);
}
```

**Verification Method — MockMerchant Strategy B**:
The mock merchant attempts a reentrancy attack by calling `charge()` within its own `receive()` fallback loop. If CEI is working correctly, the re-entrant call fails:
```solidity
receive() external payable {
    totalReceived += msg.value;
    try targetWallet.charge(targetSubId, 1) {
        reentryCount++;  // Increments only if CEI fails
    } catch {
        // Expected path: Reentrancy blocked by state checks
    }
}
```
**Assertion**: `totalReceived == amount` and `reentryCount == 0`.

### 2.4 Replay Protection

| Attack Vector | Defense Mechanism |
|---------|---------|
| **Intra-chain Replay** (Resubmitting the same UserOp) | Managed by `EntryPoint` tracking a unique `sender` -> `nonce` map |
| **Cross-chain Replay** | The `userOpHash` incorporates the unique domain `chainId` |
| **Cross-EntryPoint Version Replay** | The `userOpHash` signs the explicit `entryPoint` contract address |

### 2.5 ERC-7562 Storage Rule Compliance

The `validateUserOp` execution is bound by strict storage access rules to maintain bundler network safety. This implementation perfectly complies with:
- ✅ Only reads `owner` configuration (the account's own storage slot).
- ✅ Validates signatures via the precompiled `ecrecover` engine (fixed gas cost).
- ✅ Prepays the `prefund` pool without declaring artificial inner gas caps (spec requirement).
- ✅ Avoids time-dependent, oracle-dependent, or external state-dependent code blocks.

**Sepolia Test Validation**: Live Alchemy bundlers accepted all 7 consecutive UserOps without encountering compliance exceptions, verifying adherence to ERC-7562.

---

## 3. Attack Vector Analysis

### 3.1 Merchant Attempts to Overcharge

- **Vector 1: Reentrancy Attack**
  - *Mechanism*: Merchant forces reentrancy inside the `receive()` transfer fallback handler.
  - *Defense*: CEI ensures `lastChargedAt` updates before the transfer. The re-entrant call hits the interval check and reverts.
  - *Proof*: Verified via `MockMerchant Strategy B` confirming `reentryCount == 0`.

- **Vector 2: Single-Block High-Frequency Charging**
  - *Mechanism*: Merchant submits several `charge()` transactions within a single block.
  - *Defense*: The `interval` check blocks all subsequent calls since `lastChargedAt` updates instantly during the first valid execution.

- **Vector 3: Multi-Interval Boundary Exploitation**
  - *Mechanism*: Merchant charges right before and right after an interval boundary.
  - *Analysis*: **This is valid behavior.** The user explicitly authorized a maximum amount per interval. It is not an exploit, but rather an expected capability.
  - *Mitigation*: Users must evaluate total financial exposure (`interval` × `max` × `duration`) prior to signing.

- **Vector 4: Forged Subscriptions**
  - *Mechanism*: Merchant attempts to inject an authorized subscription mapping entry directly.
  - *Defense*: Gated by the `createSubscription` function's `onlyOwner` modifier.

### 3.2 Merchant Charges Funds Post-Cancellation

- **Front-Running Attack**
  - *Mechanism*: A merchant monitors the public mempool for a user's `cancelSubscription()` transaction and immediately broadcasts a higher-gas `charge()` transaction to slip in right before the cancellation.
  - *Maximum Financial Exposure*: Limited to exactly **one** `maxAmountPerCharge` payment, as the interval check blocks further exploits.
  - *Validation*: On Sepolia (Phase 4), a post-cancellation charge is caught by the bundler's transaction simulation and **rejected before landing on-chain**, minimizing risk.

- **Mitigation Matrix (Alternative Explored Designs)**:

| Mitigation Architecture | Operational Flow | Trade-offs & Limitations |
|------|------|----------|
| **Commit-Reveal Cancellation** | Submit hash commitment → wait N blocks → reveal cancellation | Slows down processing; reduces user experience smoothness |
| **Time-Locked Cancellation** | Cancellation commands execute after an N-block cooldown | Lengthens exposure window, allowing potential extra charges |
| **Private Mempools** | Routes cancellation actions via Flashbots channels | Introduces dependencies on external third-party infrastructure |
| **Expiry-Only Model** | Disallows active cancellations; relies on automatic expiration | Removes user flexibility to end subscriptions early |

**Architectural Trade-Off**: This implementation accepts a 1x cap front-running risk because:
- For Netflix or standard billing models, the single cap matches a single billing period, which is an acceptable financial risk boundary.
- For usage-based models, brief expiration windows (`expiry`) eliminate the need for active user-driven cancellations.

### 3.3 Third-Party Impersonation Attacks

- *Mechanism*: A malicious actor crafts a `UserOperation` setting the user's smart wallet as the `sender`.
- *Defense*: The attacker cannot forge the owner's private cryptographic signature. `validateUserOp` will fail the `ecrecover` validation check and return `1`, causing the bundler network to instantly drop the invalid transaction.

### 3.4 Bundler and Merchant Collusion

- *Mechanism*: A malicious bundler prioritizes a merchant's `charge()` operation over a user's cancellation.
- *Defense*: A bundler **cannot bypass the EntryPoint's validation requirements**. Nonces, balances, and signatures are strictly validated. Collusion only alters block ordering (letting the merchant charge one block earlier), but can never bypass contract rules.
- *Mitigation*: Users can easily route transactions to alternative bundler networks or execute self-bundling pipelines.

### 3.5 Merchant Intentionally Reverts the `receive()` Fallback

- *Mechanism*: The merchant's receiving contract reverts inside its fallback, breaking the `charge()` routing.
- *Outcome*: The `require(ok)` statement triggers a full transaction rollback, resetting `lastChargedAt`. The merchant fails to collect funds, harming only themselves, while **other independent subscriptions inside the mapping remain completely unaffected.**
- *Design Decision*: We intentionally choose not to wrap the call in a `try/catch` block. Swallowing failures would mask transfer errors, creating inconsistent user records where a transaction appears successful but funds never arrived.

### 3.6 Compromised User Private Key

- *Outcome*: The attacker gains full signature authority, enabling them to alter ownership, cancel subscriptions, or drain assets.
- *Status*: Excluded from the current scope.
- *Future Mitigation*: Social recovery networks, multi-sig constraints, and guardian architectures.

### 3.7 EntryPoint Core Protocol Upgrade

- *Mechanism*: Migration from EntryPoint v0.7 to v0.8 occurs while the smart wallet retains an immutable address reference.
- *Outcome*: The wallet becomes incompatible with updated ecosystem frameworks.
- *Mitigation*: Production architectures employ a proxy upgrade framework to handle cross-version migrations. This remains future work for this teaching project.

---

## 4. ERC-7562 Compliance Verification

### 4.1 Storage Access Rules

| Rule Metric | Implementation Assessment |
|------|--------|
| **Read Separation** | ✓ Restricted exclusively to reading the account's own storage (`owner`) |
| **External Dependencies** | ✓ Zero integration of mutable external states |
| **Control Flow Bounds** | ✓ Avoids any gas-dependent branching behavior |
| **Contextual Invariance** | ✓ Timestamp rules are strictly isolated to the execution phase |

### 4.2 Banned Opcodes Audit

The validation phase inside `validateUserOp` completely avoids the following invalid opcodes:
- ❌ `BLOCKHASH` / `COINBASE` / `DIFFICULTY` / `GASLIMIT`
- ❌ `CREATE` / `CREATE2`
- ❌ `SELFDESTRUCT`
- ❌ Inline assembly manipulating execution states

---

## 5. System Limitations and Scope Matrix

| Risk Factor | Engineering Status | Resolution Strategy |
|------|------|------|
| **Social Recovery** | Excluded | Future architectural expansion |
| **Multi-Sig Governance**| Excluded | Future architectural expansion |
| **EIP-712 Signatures** | Excluded (Using EIP-191) | Future UX upgrade |
| **Cross-Chain Routing** | Excluded | Out of scope |
| **Paymaster Sponsorship**| Conceptualized Only | Detailed design logged in Tier 3 extensions |
| **Calendar-Aware Logic**| Excluded (Using second-based math)| Future integration of specialized oracles |

---

## 6. Security Testing Checklist

| Vulnerability Target | Test Tooling | Verification Result |
|------|------|------|
| **Reentrancy (CEI)** | MockMerchant Strategy B | ✓ `totalReceived == amount`, `reentryCount == 0` |
| **Access Control** | Hardhat Unit Testing Framework | ✓ Non-owners fail to execute admin configurations |
| **Signature Replay** | Manually Forked UserOp Testing | ✓ Duplicate nonces are instantly dropped |
| **Three-Layer Cap Matrix**| Hardhat Unit Testing Framework | ✓ Verified reverts on over-charging, invalid timing, and expiration |
| **Cancellation Validity** | `demo.js` Phase 4 | ✓ Revoked subscriptions fail subsequent charge attempts |
| **ERC-7562 Standards** | Live Sepolia Run via Alchemy | ✓ All 7 UserOps successfully pass simulation checks |

