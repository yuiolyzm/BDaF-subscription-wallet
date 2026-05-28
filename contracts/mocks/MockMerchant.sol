// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title  MockMerchant
 * @notice Test helper that pretends to be a merchant contract.
 *         Used in SmartWallet tests to verify that charge() correctly
 *         transfers ETH and handles failed receivers.
 */
contract MockMerchant {
    uint256 public totalReceived;
    bool public shouldRevert;

    receive() external payable {
        if(shouldRevert) {
            revert("MockMerchant: Payment rejected");
        }
        totalReceived += msg.value;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }
}