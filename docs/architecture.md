# 系統架構文件 — BDaF Subscription Wallet

> ERC-4337 訂閱錢包專案
> Version: 1.0 | EntryPoint v0.7 | Solidity 0.8.28

---

## 1. 專案概述

### 1.1 目標

實作一個基於 ERC-4337 (Account Abstraction) 的鏈上訂閱錢包，將傳統信用卡訂閱授權邏輯搬到區塊鏈，提供：

- **可驗證的扣款條件**（金額/間隔/到期寫在合約裡，商家無法繞過）
- **隨時可撤銷**（user 一個 transaction 即可 cancel）
- **三種訂閱模式並存**（Netflix / Billing / Usage 用同一個 charge() 實現）

### 1.2 與 Stripe Billing 的差異

| | Stripe Billing | 本專案 |
|---|---------------|--------|
| 信任模型 | 信任 Stripe 公司 | 信任合約程式碼 |
| 授權儲存 | Stripe 中心化資料庫 | 鏈上 SmartWallet.subscriptions |
| 撤銷方式 | 打給 Stripe / 登入儀表板 | 呼叫合約 cancelSubscription() |
| 商家代付 gas | N/A | 可選 Paymaster |
| Audit 可能性 | 需信任 Stripe 自我審計 | Etherscan verified source code |

### 1.3 Scope

- **Tier 1**：基礎 Smart Contract Wallet + UserOperation 流程 ✓
- **Tier 2**：訂閱邏輯（三模式） + Cancel + Time Lock ✓
- **Tier 3**：Paymaster 設計分析（無實作） + 安全性分析 ✓
- **不包含**：Social recovery、Multi-sig、Cross-chain support

---

## 2. ERC-4337 角色對應

```
┌──────────────────────────────────────────────────────────────┐
│                    ERC-4337 整體架構                          │
└──────────────────────────────────────────────────────────────┘

  User EOA            Bundler             EntryPoint          SmartWallet
  (簽 UserOp)         (打包送鏈)          (canonical          (本專案實作)
                                          v0.7)
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

### 2.1 角色職責

| 角色 | 實作來源 | 職責 |
|------|---------|------|
| **User EOA** | 外部錢包 (Rabby) | 簽 UserOp（不送 tx、不需有 ETH） |
| **Bundler** | Alchemy (Sepolia) / hardhat signer (local) | 收 UserOp、打包成 tx 送到 EntryPoint |
| **EntryPoint** | Canonical v0.7 `0x0000...da032` | 強制驗證流程、扣 gas、退款 bundler |
| **SmartWallet** | 本專案 `contracts/SmartWallet.sol` | validateUserOp + 業務邏輯（charge / cancel） |
| **SmartWalletFactory** | 本專案 `contracts/SmartWalletFactory.sol` | CREATE2 部署 wallet |
| **MockMerchant** | 本專案 `contracts/mocks/MockMerchant.sol` | 模擬商家收款 + CEI 驗證 |
| **Paymaster** | 未實作 | （設計分析見 security-analysis.md） |

---

## 3. 合約清單

### 3.1 SmartWallet.sol

每個 user 的訂閱錢包合約。Constructor 寫死 owner + entryPoint，不可升級。

**State**：
```solidity
address public immutable owner;
address public immutable entryPoint;
mapping(bytes32 => Subscription) public subscriptions;
uint256 public subscriptionNonce; // for unique subscriptionId
```

**Subscription struct**：
```solidity
struct Subscription {
    address merchant;              // 收款地址
    uint256 maxAmountPerCharge;    // 單次金額上限
    uint256 interval;              // 兩次扣款最短間隔（秒）
    uint256 expiry;                // 整體有效期限（Unix timestamp）
    uint256 lastChargedAt;         // 上次扣款時間（CEI 防重入用）
    bool active;                   // cancel 後設 false
}
```

**External functions**：

| Function | Access | 用途 |
|----------|--------|------|
| `validateUserOp(userOp, userOpHash, missingAccountFunds)` | onlyEntryPoint | ERC-4337 驗證入口 |
| `execute(target, value, data)` | onlyEntryPoint OR onlyOwner | 執行任意 call |
| `createSubscription(merchant, max, interval, expiry)` | onlyOwner | 建立訂閱授權 |
| `cancelSubscription(subId)` | onlyOwner | 撤銷訂閱 |
| `charge(subId, amount)` | public（由 subscriptionId 控管） | 商家或 self-call 觸發扣款 |

### 3.2 SmartWalletFactory.sol

CREATE2 deployer，所有 wallet 從這裡部署。

**Functions**：
- `getWalletAddress(owner, salt)` — 預先計算 wallet 地址（counterfactual）
- `createWallet(owner, salt)` — 部署 wallet（已部署則 return existing，冪等）

### 3.3 MockMerchant.sol

模擬商家行為 + 驗證 CEI 的 test contract。

**State**：
- `totalReceived`：累計收到的 ETH
- `reentryCount`：成功重入次數（應 == 0 if CEI works）
- `targetWallet` / `targetSubId`：reentry attempt 的目標

**Key behavior** — `receive()` 內 try-reenter charge()：
```solidity
receive() external payable {
    totalReceived += msg.value;
    if (targetSubId != bytes32(0)) {
        try targetWallet.charge(targetSubId, 1) {
            reentryCount++;  // CEI 失效才會進這裡
        } catch {
            // 預期路徑：CEI 擋住重入
        }
    }
}
```

### 3.4 MockEntryPoint.sol

僅供 local hardhat 測試（避免依賴 mainnet fork）。Sepolia run 使用 canonical EntryPoint。

---

## 4. 三模式統一架構（核心設計）

### 4.1 設計哲學

**模式是參數空間，不是邏輯分支**。同一個 `charge()` 函數透過 `createSubscription` 的參數組合表現三種行為，**無 if-else**：

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

### 4.2 三模式參數對照

| 模式 | maxAmountPerCharge | interval | expiry | 行為 |
|------|--------------------|----------|--------|------|
| **Netflix** | == 訂閱費 | 30 day | 長 | 固定金額月費 |
| **Billing** | > 預期月帳 | 30 day | 長 | 後付帳單（商家在 cap 內決定金額） |
| **Usage** | 微小 | 短（demo 用 30 sec） | 短（30 day） | 高頻微支付 |

### 4.3 為何優於三個獨立 function

| 比較 | 三個獨立 fn | 統一 charge() |
|------|------------|--------------|
| 程式碼量 | 3x | 1x |
| 攻擊面 | 3 入口 | 1 入口 |
| Audit 成本 | 高 | 低 |
| 新增模式 | 寫新 fn | 改參數即可 |

---

## 5. UserOperation 生命週期

### 5.1 完整流程（以 charge UserOp 為例）

```
1. User EOA 在 client 端構造 UserOp
   - sender = wallet address
   - callData = execute(wallet, 0, charge(subId, amount))
   - 計算 userOpHash（EntryPoint.getUserOpHash）
   - signature = owner.signMessage(userOpHash)（EIP-191）

2. Bundler 收到 UserOp
   - eth_estimateUserOperationGas → bundler simulation 估 gas
   - eth_sendUserOperation → bundler 提交

3. Bundler 把 UserOp 包進普通 tx
   - tx.from = bundler EOA
   - tx.to = EntryPoint
   - tx.data = handleOps([userOp], beneficiary)
   - tx.value = 0

4. Block proposer 把 tx 打包進 block

5. EntryPoint.handleOps 執行
   a. validation phase:
      - 對 userOp 呼叫 wallet.validateUserOp(...)
      - wallet 驗證簽名（ecrecover）
      - wallet 補 prefund 給 EntryPoint
      - return 0 表示通過
   b. execution phase:
      - 對 userOp 呼叫 wallet.execute(target, value, callData)
      - execute 內呼叫 charge(subId, amount)（self-call）
      - charge 執行 CEI 流程
      - ETH 轉給 merchant

6. EntryPoint 計算實際 gas，退款給 bundler

7. EntryPoint emit UserOperationEvent(success=true)
```

### 5.2 Counterfactual Deploy（第一次 UserOp 的特殊情況）

第一次 UserOp 帶 `initCode = factory_address ++ createWallet(owner, salt)`：

```
EntryPoint.handleOps:
  - 偵測 sender 未部署
  - 從 initCode 拆出 factory + factoryData
  - 呼叫 factory.createWallet(owner, salt) 部署 wallet
  - 繼續 validateUserOp + execute（如同一般 op）
```

**結果**：部署 + 第一次操作在同一個 tx 完成。

---

## 6. 簽名機制

### 6.1 userOpHash 計算（ERC-4337 v0.7）

```
userOpHash = keccak256(abi.encode(
    keccak256(packedUserOpWithoutSignature),
    entryPointAddress,
    chainId
))
```

包含 entryPoint + chainId 防止 replay 攻擊。

### 6.2 EIP-191 簽名

```
ethSignedHash = keccak256("\x19Ethereum Signed Message:\n32" ++ userOpHash)
signature = sign(ethSignedHash, ownerPrivateKey)
```

Client 端用 `ethers.signMessage(getBytes(userOpHash))`，合約端用 `MessageHashUtils.toEthSignedMessageHash` + `ECDSA.recover` 對齊。

**選擇 EIP-191 而非 EIP-712 的理由**：
- 教學專案重點在合約邏輯，非錢包 UX
- EIP-191 實作簡短，容易解釋
- production 通常 EIP-712（user 可看到 typed fields）

---

## 7. 部署架構

### 7.1 Sepolia 部署（已驗證）

| 合約 | 地址 | Etherscan |
|------|------|-----------|
| EntryPoint (canonical v0.7) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Pre-existing |
| SmartWalletFactory | `0x350A8816A25B684cF69cc92a307ba5D67CEb9cDf` | ✓ Verified |
| MockMerchant | `0x2C34FC872D1057Dd9C9ED7B0c682f11eAA9f02E5` | ✓ Verified |
| Demo SmartWallet | `0xf63D252CeFd11e269809520D297a9dE9804f0206` | (CREATE2 deployed) |

### 7.2 角色帳戶

| 角色 | 從何來 |
|------|--------|
| Deployer | DEPLOYER_KEY（部署 factory + merchant） |
| Owner | OWNER_KEY（控制 wallet） |
| Bundler (local) | hardhat signer |
| Bundler (Sepolia) | Alchemy 服務 |

---

## 8. Demo 雙路線

### 8.1 路線對比

| | Local (`scripts/demo.js`) | Sepolia (`scripts/demo-sepolia.js`) |
|---|---------------------------|--------------------------------------|
| Bundler | hardhat signer 自扮 | Alchemy 真實服務 |
| 提交方式 | `entryPoint.handleOps()` 直接呼叫 | 4 個 raw RPC (`eth_sendUserOperation` 等) |
| Simulation | 無 | bundler 預先模擬 |
| 失敗 op 處理 | 上鏈後 `success=false` | bundler 階段直接拒收 |
| 時間操控 | `evm_increaseTime` | 真實等待 |
| Reputation system | 無 | 有（ERC-7562） |

### 8.2 雙路線的互補價值

**Local 證明**：合約邏輯正確、CEI 防重入、access control、三模式設計
**Sepolia 證明**：bundler 接受、reputation 不封鎖、gas 經濟性合理、真實 mempool 行為

最具體的差異在 Phase 4：
- Local 看到 `success=false` 上鏈
- Sepolia 看到 bundler simulation **直接拒收**（更強的安全保證）

---

## 9. 測試覆蓋

| 測試類別 | 工具 | 涵蓋 |
|---------|------|------|
| Unit tests | Hardhat + Chai | createSubscription / charge / cancel / validateUserOp |
| Integration | Hardhat local fork | 完整 UserOp 流程 |
| End-to-end (local) | scripts/demo.js | 4 phases × 三模式 |
| End-to-end (Sepolia) | scripts/demo-sepolia.js | 真實 bundler + 7 UserOps |
| Reentrancy | MockMerchant reentrancy test | totalReceived == amount, reentryCount == 0 |

---

## 10. Future Work

未涵蓋在此 scope，但有設計思路：

### 10.1 Paymaster

商家代付 gas 機制。設計分析見 `security-analysis.md`。

### 10.2 Social Recovery

Multi-sig recovery 機制（朋友協助換 owner）。需擴展 SmartWallet 為 multi-sig 或 guardian-based 設計。

### 10.3 EIP-712 簽名

替換 EIP-191 為 EIP-712，提供 typed data 顯示，提升 UX 安全性。

### 10.4 Cross-EntryPoint 升級

當前 entryPoint 寫死在 immutable，無法升級。production 通常用 proxy + 部署新版 wallet 遷移。

### 10.5 Calendar-aware Interval

當前 interval 用秒計算，未考慮閏年/月份天數差異。production 可改用 oracle 提供 calendar-aware 月度時間戳。

### 10.6 Front-run Mitigation

當前 cancel 暴露於 mempool 有 1× cap 風險。可選方案：commit-reveal / time-locked cancel / private mempool（Flashbots）。

---

## Appendix A：檔案結構

```
contracts/
├── SmartWallet.sol               # 主合約
├── SmartWalletFactory.sol        # CREATE2 factory
├── interfaces/
│   └── ISmartWallet.sol         # interface
└── mocks/
    ├── MockEntryPoint.sol       # 本地測試用
    └── MockMerchant.sol         # CEI 驗證用

scripts/
├── deploy.js                    # 部署 factory + merchant
├── demo.js                      # local self-bundling demo
└── demo-sepolia.js              # Sepolia real bundler demo

test/
├── SmartWallet.test.js
├── SmartWalletFactory.test.js
└── helpers/userOp.js

docs/
├── spec.md                      # 規格書
├── architecture.md              # 本文件
├── security-analysis.md         # 安全分析
├── learning-checklist.md        # 答辯學習清單
└── progress.md                  # 進度追蹤
```
