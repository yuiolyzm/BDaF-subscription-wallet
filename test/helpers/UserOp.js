// test/helpers/userOp.js
const { ethers } = require("hardhat");

/**
 * Build a PackedUserOperation with sensible defaults.
 *
 * @param {object} overrides - any field to override (e.g. { sender, callData })
 * @returns {object} userOp ready for hashing & signing
 */
function buildUserOp(overrides = {}) {
    const verificationGasLimit = overrides.verificationGasLimit ?? 100_000n;
    const callGasLimit         = overrides.callGasLimit         ?? 100_000n;
    const maxPriorityFeePerGas = overrides.maxPriorityFeePerGas ?? 1_000_000_000n;  // 1 gwei
    const maxFeePerGas         = overrides.maxFeePerGas         ?? 2_000_000_000n;       // 2 gwei
    const defaults = {
        sender: ethers.ZeroAddress,
        nonce: 0n,
        initCode: "0x",
        callData: "0x",
        accountGasLimits: ethers.toBeHex((BigInt(verificationGasLimit) << 128n) | BigInt(callGasLimit), 32),        // * 32-byte hex string
        preVerificationGas: 50_000n,
        gasFees: ethers.toBeHex((BigInt(maxPriorityFeePerGas) << 128n) | BigInt(maxFeePerGas), 32),
        paymasterAndData: "0x",
        signature: "0x",
    };
    const { verificationGasLimit: _, callGasLimit: __,
        maxPriorityFeePerGas: ___, maxFeePerGas: ____,
        ...restOverrides } = overrides;
    return {...defaults, ...restOverrides };
}

/**
 * Compute userOpHash per ERC-4337 v0.7 spec.
 *
 * userOpHash = keccak256(abi.encode(
 *     keccak256(packUserOp(userOp)),
 *     entryPointAddr,
 *     chainId
 * ))
 *
 * @param {object} userOp
 * @param {string} entryPointAddr
 * @param {bigint|number} chainId
 * @returns {string} 0x-prefixed 32-byte hash
 */
function getUserOpHash(userOp, entryPointAddr, chainId) {
    const packedUserOp = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"],
        [
            userOp.sender,
            userOp.nonce,
            ethers.keccak256(userOp.initCode),
            ethers.keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            ethers.keccak256(userOp.paymasterAndData),
        ]
    )

    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "uint256"],
        [
            ethers.keccak256(packedUserOp),
            entryPointAddr,
            chainId
        ]
    );
    return ethers.keccak256(encoded);
}

/**
 * Sign userOpHash with given signer and attach signature.
 *
 * NOTE: SmartWallet.validateUserOp uses toEthSignedMessageHash + ECDSA.recover,
 * so we sign with signer.signMessage() (which auto-applies EIP-191 prefix).
 * If SmartWallet changes to raw hash recovery, switch to signer.signingKey.sign().
 *
 * @param {object} userOp
 * @param {Wallet} signer - ethers Signer (e.g. owner)
 * @param {string} entryPointAddr
 * @param {bigint|number} chainId
 * @returns {object} userOp with `signature` populated
 */
async function signUserOp(userOp, signer, entryPointAddr, chainId) {
    const hash = getUserOpHash(userOp, entryPointAddr, chainId);
    const sig = await signer.signMessage(ethers.getBytes(hash));
    return { ...userOp, signature: sig };   // * spread operator to create new object with signature
}

module.exports = {
    buildUserOp,
    getUserOpHash,
    signUserOp,
};