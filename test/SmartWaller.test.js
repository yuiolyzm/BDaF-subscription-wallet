const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue} = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildUserOp, getUserOpHash, signUserOp } = require("./helpers/userOp");
const abi = ethers.AbiCoder.defaultAbiCoder();

async function deployFixture() {
    const [owner, stranger] = await ethers.getSigners();
    const MockEntryPoint = await ethers.getContractFactory("MockEntryPoint");
    const entryPoint = await MockEntryPoint.deploy();
    
    const SmartWallet = await ethers.getContractFactory("SmartWallet");
    const wallet = await SmartWallet.deploy(owner.address, await entryPoint.getAddress());

    const MockMerchant = await ethers.getContractFactory("MockMerchant");
    const merchant = await MockMerchant.deploy();
    return { owner, stranger, entryPoint, wallet, merchant };
}

describe("SmartWallet", function () {
    describe("createSubscription", function () {
        it("owner can create a subscription and event is emitted", async function () {
            const { owner, wallet, merchant } = await loadFixture(deployFixture);
            const walletAddr = await wallet.getAddress();
            const merchantAddr = await merchant.getAddress();

            // merchant, maxAmountPerCharge, interval, expiry (0 for no expiry)
            await expect(
                wallet.createSubscription(merchantAddr, 1000, 3600, 0)
            ).to.emit(wallet, "SubscriptionCreated").withArgs(anyValue, merchantAddr, 1000, 3600, 0);
    
            const subscriptionId = ethers.keccak256(abi.encode(
                ["address", "address", "uint256"],
                [walletAddr, merchantAddr, 0]));
            const subscription = await wallet.subscriptions(subscriptionId);
            expect(subscription.merchant).to.equal(merchantAddr);
            expect(subscription.maxAmountPerCharge).to.equal(1000);
            expect(subscription.interval).to.equal(3600);
        })
    })
})

describe("createSubscription — failure cases", function () {
    it("reverts when merchant is zero address", async function () {
        const { wallet } = await loadFixture(deployFixture);
        await expect(
            wallet.createSubscription(ethers.ZeroAddress, 1000, 3600, 0)
        ).to.be.revertedWith("SmartWallet: invalid merchant");
    });

    it("reverts when merchant is the wallet itself", async function () {
        const { wallet } = await loadFixture(deployFixture);
        const walletAddr = await wallet.getAddress();
        await expect(
            wallet.createSubscription(walletAddr, 1000, 3600, 0)
        ).to.be.revertedWith("SmartWallet: invalid merchant");
    });

    it("reverts when maxAmountPerCharge is zero", async function () {
        const { wallet, merchant } = await loadFixture(deployFixture);
        const merchantAddr = await merchant.getAddress();
        await expect(
            wallet.createSubscription(merchantAddr, 0, 3600, 0)
        ).to.be.revertedWith("SmartWallet: invalid max amount");
    });

    it("reverts when interval is zero", async function () {
        const { wallet, merchant } = await loadFixture(deployFixture);
        const merchantAddr = await merchant.getAddress();
        await expect(
            wallet.createSubscription(merchantAddr, 1000, 0, 0)
        ).to.be.revertedWith("SmartWallet: invalid interval");
    });

    it("reverts when expiry is in the past", async function () {
        const { wallet, merchant } = await loadFixture(deployFixture);
        const merchantAddr = await merchant.getAddress();
        // 1: 1970-01-01 00:00:01 UTC
        await expect(
            wallet.createSubscription(merchantAddr, 1000, 3600, 1)
        ).to.be.revertedWith("SmartWallet: invalid expiry");
    });

    it("reverts when expiry equals current block timestamp", async function () {
    const { wallet, merchant } = await loadFixture(deployFixture);
    const merchantAddr = await merchant.getAddress();

    const now = await time.latest();        
    await time.setNextBlockTimestamp(now + 1);  // set next block timestamp to now + 1
    // expiry = now + 1 = next block timestamp, should revert
    await expect(
        wallet.createSubscription(merchantAddr, 1000, 3600, now + 1)
    ).to.be.revertedWith("SmartWallet: invalid expiry");
});

    it("reverts when called by non-owner", async function () {
        const { wallet, stranger, merchant } = await loadFixture(deployFixture);
        const merchantAddr = await merchant.getAddress();
        await expect(
            wallet.connect(stranger).createSubscription(merchantAddr, 1000, 3600, 0)
        ).to.be.revertedWith("SmartWallet: not owner");
    });
});