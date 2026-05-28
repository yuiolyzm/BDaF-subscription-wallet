// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ISmartWallet} from "../interfaces/ISmartWallet.sol";

contract MockEntryPoint {
    // state
    uint256 public totalPrefundReceived;
    uint256 public lastValidationData;

    // can receive ETH
    receive() external payable{
        totalPrefundReceived += msg.value;
    }

    // validateUserOp
    function callValidateUserOp(
        address wallet,
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256) {
        lastValidationData = ISmartWallet(wallet).validateUserOp(userOp, userOpHash, missingAccountFunds);
        return lastValidationData;
    }

    // execute
    function callExecute(
        address wallet,
        address target,
        uint256 value,
        bytes calldata data
    ) external {
        ISmartWallet(wallet).execute(target, value, data);
    }
}