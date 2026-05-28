// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

interface ISmartWallet {
    // Events
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

    // State getters
    function owner() external view returns (address);
    function entryPoint() external view returns (address);

    // ERC-4337 methods
    function  validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
    function execute(address target, uint256 value, bytes calldata data) external;
    
    // Subscription methods
    function createSubscription(
        address merchant,
        uint256 maxAmountPerCharge,
        uint256 interval,
        uint256 expiry
    ) external returns (bytes32 subscriptionId);
    function cancelSubscription(bytes32 subscriptionId) external;
    function charge(bytes32 subscriptionId, uint256 amount) external;
}