// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title  SmartWallet
 * @notice ERC-4337 Smart Account with on-chain subscription payment logic.
 *
 * Architecture:
 *   1. ERC-4337 layer: validateUserOp / execute
 *      → allows the wallet to be driven by an EntryPoint via UserOperations.
 *   2. Subscription layer: create / cancel / charge
 *      → encodes user-granted, revocable charge authorizations to merchants.
 *
 * Two charge call paths (see docs/spec.md §4.4):
 *   Path C: EntryPoint → execute(this, 0, charge.calldata)   ← msg.sender == address(this)
 *   Path A: Merchant EOA → charge(...)                       ← msg.sender == merchant
 */

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract SmartWallet {

    // --------------------------------------------------------
    // State
    // --------------------------------------------------------

    address public owner;
    address public immutable entryPoint;    // * Trusted EntryPoint contract address. Immutable to prevent malicious replacement
    mapping(bytes32 => Subscription) public subscriptions;    // * subscriptionId => Subscription
    uint256 public subscriptionNonce;    // * Monotonically increasing nonce used to derive unique subscriptionIds.

    // --------------------------------------------------------
    // Types
    // --------------------------------------------------------

    struct Subscription {
        address merchant;            // Authorized merchant address
        uint256 maxAmountPerCharge;  // Per-charge cap (wei)
        uint256 interval;            // Minimum seconds between charges
        uint256 lastCharged;         // Timestamp of the most recent charge
        uint256 expiry;              // Authorization expiry timestamp (0 = no expiry)
        bool    active;              // false once cancelled
    }

    // --------------------------------------------------------
    // Events
    // --------------------------------------------------------

    event SubscriptionCreated(
        bytes32 indexed id,
        address indexed merchant,
        uint256 maxAmountPerCharge,
        uint256 interval,
        uint256 expiry
    );

    event SubscriptionCancelled(bytes32 indexed id);

    event Charged(
        bytes32 indexed id,
        address indexed merchant,
        uint256 amount
    );

    // --------------------------------------------------------
    // Modifiers
    // --------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "SmartWallet: not owner");
        _;
    }
    modifier onlyEntryPoint() {
        require(msg.sender == entryPoint, "SmartWallet: not EntryPoint");
        _;
    }

    // --------------------------------------------------------
    // Constructor
    // --------------------------------------------------------

    /**
     * @param _owner       Wallet owner EOA
     * @param _entryPoint  ERC-4337 EntryPoint contract address
     */
    constructor(address _owner, address _entryPoint) {
        owner = _owner;
        entryPoint = _entryPoint;
    }

    /// @dev Accept plain ETH transfers (wallet funding, refunds, etc.).
    receive() external payable {}

    // ========================================================
    // ERC-4337 Required Functions
    // ========================================================

    /**
     * @notice Called by the EntryPoint to validate a UserOperation.
     * @param  userOp                The full UserOp.
     * @param  userOpHash            EntryPoint-computed hash that the owner must sign.
     * @param  missingAccountFunds   Gas the wallet must prepay to the EntryPoint.
     * @return validationData        0 = valid, 1 = invalid signature.
     *
     * Notes:
     *   - MUST NOT revert on a bad signature; return 1 instead, otherwise the
     *     bundler may blacklist this wallet (ERC-4337 §6).
     *   - Storage access is restricted during validation (ERC-4337 §4.2):
     *     only this contract's own storage may be read.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlyEntryPoint returns (uint256 validationData) {
        // * Recover signer from the EIP-191 prefixed hash.
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        address signer = ECDSA.recover(ethSignedHash, userOp.signature);
        if (signer != owner) {
            return 1;  // * SIG_VALIDATION_FAILED — must not revert.
        }

        // * Prepay gas owed to the EntryPoint.
        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok);  // * Intentionally ignored: EntryPoint will surface its own failure.
        }

        return 0;
    }

    /**
     * @notice Generic execution entry point used by the EntryPoint or owner.
     * @param  target  Call destination.
     * @param  value   ETH (wei) to attach.
     * @param  data    Calldata to forward.
     *
     * Uses a low-level `call` (not `transfer`) so the wallet can interact with
     * any contract regardless of gas consumption.
     */
    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint || msg.sender == owner, "SmartWallet: not authorized");

        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            // * Bubble up the original revert reason from `target`.
            // *   - add(ret, 32): skip the length prefix.
            // *   - mload(ret):   read the length.
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    // ========================================================
    // Subscription Management (Owner only)
    // ========================================================

    /**
     * @notice Create a new charge authorization.
     * @return subscriptionId Deterministic id: keccak256(wallet, merchant, nonce).
     */
    function createSubscription(
        address merchant,
        uint256 maxAmountPerCharge,
        uint256 interval,
        uint256 expiry
    ) external onlyOwner returns (bytes32 subscriptionId) {
        require(merchant != address(0) && merchant != address(this), "SmartWallet: invalid merchant");
        require(maxAmountPerCharge > 0, "SmartWallet: invalid max amount");
        require(interval > 0, "SmartWallet: invalid interval");
        require(expiry == 0 || expiry > block.timestamp, "SmartWallet: invalid expiry");

        subscriptionId = keccak256(abi.encode(address(this), merchant, subscriptionNonce++));
        subscriptions[subscriptionId] = Subscription({
            merchant: merchant,
            maxAmountPerCharge: maxAmountPerCharge,
            interval: interval,
            lastCharged: 0,
            expiry: expiry,
            active: true
        });
        emit SubscriptionCreated(subscriptionId, merchant, maxAmountPerCharge, interval, expiry);
    }

    /**
     * @notice Revoke a subscription. Takes effect immediately.
     */
    function cancelSubscription(bytes32 subscriptionId) external onlyOwner {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.merchant != address(0), "SmartWallet: subscription not found");
        require(sub.active, "SmartWallet: subscription already cancelled");
        sub.active = false;
        emit SubscriptionCancelled(subscriptionId);
    }

    // ========================================================
    // Charge (core logic)
    // ========================================================

    /**
     * @notice Pull `amount` wei to the authorized merchant for `subscriptionId`.
     *
     * Call paths:
     *   Path C: msg.sender == address(this)  ← EntryPoint → execute → charge
     *   Path A: msg.sender == sub.merchant   ← Merchant EOA directly (demo)
     *
     * Defense in depth: every constraint is re-checked here, even if the caller
     * already passed EntryPoint validation.
     */
    function charge(bytes32 subscriptionId, uint256 amount) external {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.active, "SmartWallet: subscription not active");
        require(sub.expiry == 0 || sub.expiry >= block.timestamp, "SmartWallet: subscription expired");
        require(amount > 0 && amount <= sub.maxAmountPerCharge, "SmartWallet: invalid amount");
        require(address(this).balance >= amount, "SmartWallet: insufficient balance");

        // * For the first charge, lastCharged == 0, so this always passes
        // * (block.timestamp >> any reasonable interval). This is intentional:
        // * follow the "use first, charge later" credit-card model.
        require(block.timestamp >= sub.lastCharged + sub.interval, "SmartWallet: charge too soon");

        require(msg.sender == address(this) || msg.sender == sub.merchant, "SmartWallet: not authorized");

        // * Effects before Interactions (CEI) — protects against reentrancy
        // * from a malicious merchant `receive()`.
        sub.lastCharged = block.timestamp;

        (bool ok, ) = payable(sub.merchant).call{value: amount}("");
        require(ok, "SmartWallet: transfer failed");

        emit Charged(subscriptionId, sub.merchant, amount);
    }
}
