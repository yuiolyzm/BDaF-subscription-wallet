// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ISmartWallet} from "../interfaces/ISmartWallet.sol";

/**
 * @title  MockMerchant
 * @notice Test helper that pretends to be a merchant contract.
 *         Used in SmartWallet tests to verify that charge() correctly
 *         transfers ETH and handles failed receivers.
 */
contract MockMerchant {
    uint256 public totalReceived;
    bool public shouldRevert;

    // * --- reentrancy attack state (off by default; enabled via setAttack) ---
    bool    public attackEnabled;   // master switch: receive() only re-enters when true
    bytes32 public attackSubId;     // subscriptionId to re-enter on
    uint256 public attackAmount;    // amount to attempt on re-entry
    uint256 public reentryCount;    // # of reentrant charges that SUCCEEDED; CEI works => stays 0
    bool    private attacked;       // one-shot guard, avoids re-entering on every receive

    receive() external payable {
        if(shouldRevert) {
            revert("MockMerchant: Payment rejected");
        }
        totalReceived += msg.value;

        // Reentrancy probe: on the first incoming payment, try to pull again.
        if (attackEnabled && !attacked) {
            attacked = true;
            // try/catch swallows the inner revert so the OUTER transfer still
            // succeeds — this lets the test observe "tried twice, paid once".
            try ISmartWallet(msg.sender).charge(attackSubId, attackAmount) {
                reentryCount++;
            } catch {
                // expected path: do nothing
            }
        }
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    // Arm the reentrancy probe. Call this only in the reentrancy test.
    function setAttack(bytes32 _subId, uint256 _amount) external {
        attackEnabled = true;
        attackSubId = _subId;
        attackAmount = _amount;
    }

    function callCharge(address wallet, bytes32 subscriptionId, uint256 amount) external {
        ISmartWallet(wallet).charge(subscriptionId, amount);
    }
}