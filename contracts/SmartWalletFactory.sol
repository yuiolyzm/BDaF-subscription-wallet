// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SmartWallet} from "./SmartWallet.sol";

/**
 * @title  SmartWalletFactory
 * @notice Deploys SmartWallet instances at deterministic (CREATE2) addresses,
 *         so a wallet's address can be computed before it is deployed
 *         (counterfactual deployment, predeployment).
 */
contract SmartWalletFactory {
    address public immutable entryPoint;

    constructor(address _entryPoint) {
        entryPoint = _entryPoint;
    }

    /**
     * @notice Compute the address a wallet WOULD be deployed at — without deploying.
     * @dev Mirrors the CREATE2 address formula:
     *      keccak256(0xff ++ deployer ++ salt ++ keccak256(initCode))[12:]
     */
    function getWalletAddress(address owner, bytes32 salt) public view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(SmartWallet).creationCode, // constructor code of SmartWallet
            abi.encode(owner, entryPoint)   // constructor args of SmartWallet
        );
        bytes32 hash = keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),     // deployer = this factory
            salt,
            keccak256(initCode)
        ));
        return address(uint160(uint256(hash)));  // get the last 20 (160/256 = 20/32) bytes of the hash
    }

    /**
     * @notice Deploy a SmartWallet for `owner` at a deterministic address.
     * @dev Uses native CREATE2 syntax: new C{salt: ...}(args).
     */
    function createWallet(address owner, bytes32 salt) external returns (address) {
        address predicted = getWalletAddress(owner, salt);
        if(predicted.code.length != 0) return predicted; // already deployed

        // deploy: get the address from new ...
        SmartWallet wallet = new SmartWallet{salt:salt}(owner, entryPoint);
        return address(wallet);
    }
}