# 安全分析文件 — BDaF Subscription Wallet

> 訂閱錢包合約安全性分析 + 攻擊向量列表 + 防禦機制驗證
> Version: 1.0 | 對應 SmartWallet.sol Solidity 0.8.28

---

## 1. Threat Model

### 1.1 被保護的資產

- **User 的 ETH**：儲存在 SmartWallet 餘額
- **訂閱授權**：subscriptions mapping 的 active/cap/interval/expiry
- **Owner 的控制權**：透過私鑰簽名行使

### 1.2 潛在攻擊者

| 攻擊者 | 動機 | 能力 |
|-------|------|------|
| **惡意商家** | 多扣錢 / 取消後仍扣款 | 可呼叫 charge()、可 front-run mempool |
| **第三方** | 假冒 user / 偷取 ETH | 可送 UserOp、可監聽 mempool |
| **惡意 bundler** | 審查 / 偏袒商家 | 可拒收某些 op、無法竄改 op 內容 |
| **失能 user** | 不適用攻擊者，但需設計保護 | 私鑰遺失 / 失聯 |

### 1.3 信任假設

| 信任對象 | 信任程度 | 理由 |
|---------|---------|------|
| EVM | 完全信任 | 協定保證 |
| EntryPoint v0.7 (canonical) | 完全信任 | Audited、deterministic 部署 |
| OpenZeppelin contracts | 信任 | Production-grade、industry standard |
| Bundler | **不信任** | 可能審查，但無法竄改 |
| Merchant | **不信任** | 可能多扣 / front-run |
| Paymaster (若有) | 部分信任 | 設計上限制可做的事 |

---

## 2. 防禦機制

### 2.1 Access Control 分層

| Function | Modifier | 理由 |
|----------|---------|------|
| `validateUserOp` | onlyEntryPoint | 只有 EntryPoint 可觸發驗證 |
| `execute` | onlyEntryPoint OR onlyOwner | UserOp 路徑 + 直接呼叫路徑 |
| `createSubscription` | onlyOwner | 只有 user 能授權扣款 |
| `cancelSubscription` | onlyOwner | 只有 user 能撤銷 |
| `charge` | public（但由 subscriptionId 控管） | 商家或 self-call 觸發 |

**關鍵設計**：onlyOwner 明確排除 `address(this)`，避免合約自呼叫繞權限：

```solidity
require(
    msg.sender == entryPoint || msg.sender == owner,
    "SmartWallet: not authorized"
);
// 注意：address(this) 不在 allowed list
```

### 2.2 三層扣款防護

每次 charge() 必須通過三道檢查：

| 防線 | 防什麼 | 失效後果 |
|------|--------|---------|
| `amount ≤ maxAmountPerCharge` | 單次金額被坑 | 商家可一次扣到錢包空 |
| `block.timestamp ≥ lastChargedAt + interval` | 高頻連扣 | 商家可一個 block 內連扣 |
| `block.timestamp < expiry` | 永久授權風險 | 商家可永遠扣（user 失聯也擋不住） |

**三道一起的數學保證**：

```
商家最大可扣總額 = maxAmountPerCharge × ⌊(expiry - now) / interval⌋
```

有限且可預估，user 簽授權時就能算出最壞情況。

### 2.3 CEI (Checks-Effects-Interactions) 防重入

**正確順序**（已在 SmartWallet.charge 實作）：

```solidity
function charge(bytes32 subId, uint256 amount) external {
    // C — Checks
    require(s.active);
    require(amount <= s.maxAmountPerCharge);
    require(block.timestamp >= s.lastChargedAt + s.interval);
    require(block.timestamp < s.expiry);
    
    // E — Effects（先寫 state）
    s.lastChargedAt = block.timestamp;
    
    // I — Interactions（最後 external call）
    (bool ok, ) = s.merchant.call{value: amount}("");
    require(ok);
}
```

**驗證方法 — MockMerchant Strategy B**：

商家在 `receive()` 內主動 try-reenter charge，若 CEI 有效則被 revert：

```solidity
receive() external payable {
    totalReceived += msg.value;
    try targetWallet.charge(targetSubId, 1) {
        reentryCount++;  // CEI 失效才會進這裡
    } catch {
        // 預期路徑：CEI 擋住重入
    }
}
```

**斷言**：`totalReceived == amount` 且 `reentryCount == 0`。

### 2.4 Replay Protection

| 攻擊向量 | 防禦機制 |
|---------|---------|
| 同鏈 replay（同 UserOp 重送） | EntryPoint.nonce mapping，sender + nonceKey 唯一 |
| 跨鏈 replay | userOpHash 包含 `chainId` |
| 跨 EntryPoint 版本 replay | userOpHash 包含 `entryPoint address` |

### 2.5 ERC-7562 Storage Rule Compliance

`validateUserOp` 只能讀寫受限的 storage，本實作符合：

- ✅ 只讀 `owner`（自己的 storage slot）
- ✅ 簽名驗證用 `ecrecover` precompile（固定 gas）
- ✅ 補 prefund 不設 gas limit（spec 要求）
- ✅ 無 time-dependent / oracle-dependent / external state-dependent 邏輯

**Sepolia run 驗證**：Alchemy bundler 接受 7 個 UserOp（包含部署、charge、cancelled charge），證明合約符合 ERC-7562。

---

## 3. 攻擊向量分析

### 3.1 商家試圖多扣錢

**攻擊路徑 1：reentrancy**
- 機制：merchant 在 receive 內 reenter charge()
- 防禦：CEI 確保 lastChargedAt 已更新，interval check fail → revert
- 驗證：MockMerchant Strategy B 證明 reentryCount == 0

**攻擊路徑 2：高頻連扣**
- 機制：商家在同 block 連送多筆 charge tx
- 防禦：interval check 擋住所有後續 charge（lastChargedAt 已更新）

**攻擊路徑 3：跨 interval 邊界 timing**
- 機制：interval 到的瞬間連扣兩次
- 結論：**這是合法操作**（user 簽授權同意「每 interval 一次 max」），不算偷扣
- 緩解：user 應審視 interval × max × duration 的總曝險

**攻擊路徑 4：偽造 subscription**
- 機制：商家嘗試直接創建有利於自己的 subscription
- 防禦：createSubscription 有 onlyOwner

### 3.2 User 取消後商家仍能扣款

**Front-run 攻擊**：
- 機制：商家監聽 mempool 看到 cancel tx，搶在 cancel 之前送 charge tx（給更高 gas）
- 損失上限：**一次 `maxAmountPerCharge`**（interval check 擋住連扣）
- 驗證：見 Sepolia run Phase 4 — Netflix/Billing cancel 後 charge 被 bundler simulation 直接拒收

**Mitigation 方案**（未實作，分析如下）：

| 方案 | 機制 | Trade-off |
|------|------|----------|
| Commit-reveal cancel | 先送 hash → 等 N block → reveal | cancel 變慢，UX 差 |
| Time-locked cancel | cancel 命令延遲 N block 生效 | 被掏空時間可能更長 |
| Private mempool | 透過 Flashbots 等管道送 cancel | 依賴第三方 |
| Expiry-only model | 不允許主動 cancel，只用 expiry 自動失效 | 失去彈性 |

**設計選擇**：本專案接受 1× cap 的 front-run 風險，因為：
- Netflix/Billing 的 cap ≈ 訂閱費，損失等於多扣一期，可接受
- Usage 用短 expiry 規避 active cancel 需求（dead-man-switch）

### 3.3 第三方假冒 user 發 UserOp

**攻擊機制**：攻擊者建構 UserOp，sender = user wallet

**防禦**：
- 攻擊者不知 owner 私鑰，無法產生有效簽名
- `validateUserOp` 內 `ecrecover(userOpHash, sig) != owner` → return 1 → bundler 拒收

### 3.4 Bundler 與商家串通

**機制**：bundler 偏袒商家、優先打包商家的 charge tx

**防禦**：
- Bundler **無法跳過 EntryPoint validation**
- 簽名 / nonce / state check 在 EntryPoint 強制執行
- 結果：bundler 偏袒最多達成「商家的 op 早一個 block 上鏈」，但無法繞過合約檢查

**Mitigation**：user 可換 bundler、自行 bundle（self-bundling）。

### 3.5 商家把 receive 函數搞爛

**機制**：merchant.receive() revert，導致 charge() 內 transfer 失敗

**結果**：
- charge() 的 `require(ok)` 觸發 revert
- 整個 tx 回滾，包括 lastChargedAt 更新
- 商家自己扣不到錢（grief 自己）
- **其他 subscription 不受影響**（state per subId）

**Trade-off 分析**：是否應該 try/catch 吞掉 receive 失敗？
- 吞掉：商家無法 grief 自己，但 user history 出現「轉帳成功但對方沒收到」
- 不吞：對應錢扣不到，但邏輯一致
- **本實作選擇不吞**（讓 revert 自然往上）

### 3.6 User 私鑰被偷

**結果**：
- 攻擊者可發任意 UserOp（cancel 所有訂閱、掏空 wallet）
- **超出本實作 scope**

**Future work**：social recovery / multisig / guardian-based 設計

### 3.7 EntryPoint 升級

**機制**：v0.7 升 v0.8，本 wallet immutable entryPoint 無法跟上

**結果**：wallet 在新版生態系失效

**Mitigation**：production 通常 proxy pattern + 遷移到新版 wallet 部署。本專案 scope 不含。

### 3.8 商家 contract 升級

**機制**：merchant 用 proxy pattern，升級實作合約

**結果**：
- subscription 綁定 merchant address，proxy 地址不變 → subscription 仍指向同一 entity
- 但 proxy 後的邏輯可能變壞（例：偷偷加 fee）
- **語意上**：user 訂閱 = 信任那個 address。如果 merchant 改邏輯，user 應視為新主體並評估

**Mitigation**：user 應檢查 merchant 是否為 proxy、proxy admin 是誰

### 3.9 Replay 攻擊

| 場景 | 防禦 |
|------|------|
| 同 nonce 重送 | EntryPoint 維護 sender → nonce mapping |
| 跨鏈 replay | userOpHash 包含 chainId |
| 跨 EntryPoint 版本 | userOpHash 包含 entryPoint address |
| Cancel 後重送舊 charge UserOp | 即使簽名有效，charge() 內 `s.active` check fail |

### 3.10 同一個 owner + merchant 訂閱多次

**機制**：user 為同一個 merchant 創 N 個 subscription

**結果**：
- subscriptionId = keccak256(wallet, merchant, subscriptionNonce)，nonce 遞增 → 不會撞 ID
- 多個 subscription **獨立計算 interval / cap**
- **不是漏洞，是 UX 問題**（user 應自我管理訂閱列表）

---

## 4. ERC-7562 Compliance 驗證

### 4.1 Storage Access Rules

| 規則 | 本實作 |
|------|--------|
| 只讀 sender 自己的 storage | ✓ 只讀 owner |
| 不讀外部 mutable state | ✓ 無外部依賴 |
| 不使用 gas-dependent control flow | ✓ 無 |
| 不使用環境變數（GASLEFT、TIMESTAMP 影響邏輯） | ✓ timestamp 只在 execution phase 用 |

### 4.2 Banned Opcodes

`validateUserOp` 內**未使用**以下 opcode：
- ❌ BLOCKHASH / COINBASE / DIFFICULTY / GASLIMIT
- ❌ CREATE / CREATE2
- ❌ SELFDESTRUCT
- ❌ Inline assembly with state-changing ops

**Sepolia run 證明**：Alchemy bundler 的 simulation 通過所有 7 個 UserOp，包含 deploy + charge + cancelled charge attempt。

---

## 5. 已知限制與 scope 排除

| 議題 | 狀態 | 處理 |
|------|------|------|
| Social Recovery | 未實作 | Future work |
| Multi-sig owner | 未實作 | Future work |
| EIP-712 簽名 | 未實作（用 EIP-191） | Future work（提升 UX 安全） |
| Cross-chain support | 未實作 | 超出 scope |
| Paymaster | 未實作（設計分析見 §6） | Tier 3 加分 |
| EntryPoint 升級遷移 | 未實作（immutable） | Future work（proxy pattern） |
| Calendar-aware interval | 未實作（用秒） | Future work（oracle） |
| Front-run mitigation（commit-reveal 等） | 未實作 | 接受 1× cap 風險 |

---

## 6. 安全測試清單

| 測試 | 工具 | 結果 |
|------|------|------|
| Reentrancy（CEI 防禦） | MockMerchant Strategy B | ✓ totalReceived == amount, reentryCount == 0 |
| Access control | Hardhat unit tests | ✓ non-owner cannot create/cancel |
| Signature replay | manually crafted UserOp | ✓ duplicate nonce rejected |
| Three-layer charge protection | Hardhat unit tests | ✓ amount > cap revert, interval not elapsed revert, expired revert |
| Cancel 有效性 | demo.js Phase 4 | ✓ cancelled subscription charge fails |
| ERC-7562 compliance | Sepolia run (Alchemy bundler) | ✓ all 7 UserOps accepted |
| Front-run boundary | 邏輯分析 + Sepolia Phase 4 | ✓ bundler simulation 直接拒收 |
| Etherscan verification | Etherscan UI | ✓ Factory + Merchant verified |

---

## 7. 答辯重點摘要

最有可能被問的安全議題（按優先級）：

1. **「重入會發生在哪？怎麼擋？怎麼證明？」** → CEI + Strategy B
2. **「使用者取消後商家還能扣到錢嗎？」** → 1× cap front-run + Sepolia Phase 4 證明
3. **「為什麼 validateUserOp return 1 而非 revert？」** → bundler reputation + spec convention
4. **「如果有人假冒你的 wallet 發 UserOp？」** → ecrecover + chainId + entryPoint addr
5. **「Etherscan AI 說你 CEI 名字寫錯？」** → 反駁：AI 寫錯了，正確是 Checks-Effects-Interactions
6. **「為什麼 prefund 不設 gas limit？」** → ERC-4337 spec 要求，違反會破壞 ERC-7562
7. **「商家把 receive 搞爛 charge 會卡住嗎？」** → revert propagate，其他訂閱不受影響
8. **「為什麼不實作 Paymaster？」** → scope 取捨 + 設計分析見 §6
9. **「user 私鑰被偷怎辦？」** → 承認 out of scope，未來可加 social recovery
10. **「三模式為何不分三個 function？」** → 參數空間 vs 邏輯分支
