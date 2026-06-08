const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
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

    // pre-compute commonly-used addresses + chainId so tests don't repeat this
    const walletAddr = await wallet.getAddress();
    const merchantAddr = await merchant.getAddress();
    const entryPointAddr = await entryPoint.getAddress();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    return { owner, stranger, entryPoint, wallet, merchant, walletAddr, merchantAddr, entryPointAddr, chainId  };
}

// * Mirror of the contract's id math: keccak256(abi.encode(wallet, merchant, nonce)).
function computeSubId(walletAddr, merchantAddr, nonce) {
    return ethers.keccak256(abi.encode(
        ["address", "address", "uint256"],
        [walletAddr, merchantAddr, nonce]
    ));
}

// * Deploy base contracts, optionally fund the wallet, create ONE subscription (nonce 0), 
// * and return the full context + its subscriptionId.
async function setupSubscription({
    maxAmount = 1000n,
    interval = 3600,
    expiry = 0,
    fundWei = 0n,
} = {}) {
    const base = await deployFixture();
    const { owner, wallet, merchant, walletAddr, merchantAddr } = base;

    if (fundWei > 0n) {
        await owner.sendTransaction({ to: base.walletAddr, value: fundWei });
    }

    await wallet.createSubscription(merchantAddr, maxAmount, interval, expiry);
    const subscriptionId = computeSubId(base.walletAddr, merchantAddr, 0);

    return { ...base,subscriptionId };
}

describe("createSubscription", function () {
    it("owner can create a subscription and event is emitted", async function () {
        const { owner, wallet, merchant } = await loadFixture(deployFixture);
        const walletAddr = await wallet.getAddress();
        const merchantAddr = await merchant.getAddress();

        // merchant, maxAmountPerCharge, interval, expiry (0 for no expiry)
        await expect(
            wallet.createSubscription(merchantAddr, 1000, 3600, 0)
        ).to.emit(wallet, "SubscriptionCreated").withArgs(anyValue, merchantAddr, 1000, 3600, 0);

        const subscriptionId = computeSubId(walletAddr, merchantAddr, 0);
        const subscription = await wallet.subscriptions(subscriptionId);
        expect(subscription.merchant).to.equal(merchantAddr);
        expect(subscription.maxAmountPerCharge).to.equal(1000);
        expect(subscription.interval).to.equal(3600);
    })

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

describe("charge", function () {
    // * charge：funded with 1 ETH so charges have balance. expiry is the only knob.
    function chargeFixture(expiry = 0) {
        return setupSubscription({ fundWei: ethers.parseEther("1.0"), expiry });
    }

    it("merchant can charge within limits", async function () {
        const { wallet, merchant, subscriptionId, merchantAddr } = await chargeFixture();

        await expect(merchant.callCharge(await wallet.getAddress(), subscriptionId, 500))
            .to.emit(wallet, "Charged")
            .withArgs(subscriptionId, merchantAddr, 500);

        expect(await merchant.totalReceived()).to.equal(500);

        const sub = await wallet.subscriptions(subscriptionId);
        expect(sub.lastCharged).to.be.gt(0);
    });

    it("reverts when amount exceeds maxAmountPerCharge", async function () {
        const { wallet, merchant, subscriptionId, walletAddr } = await chargeFixture();

        await expect(
            merchant.callCharge(walletAddr, subscriptionId, 1001)  // maxAmountPerCharge 1000
        ).to.be.revertedWith("SmartWallet: invalid amount");
    });

    it("reverts when called too soon (interval not elapsed)", async function () {
        const { wallet, merchant, subscriptionId, walletAddr } = await chargeFixture();

        await merchant.callCharge(walletAddr, subscriptionId, 500);

        // immediately another charge (interval (3600s) not elapsed)
        await expect(
            merchant.callCharge(walletAddr, subscriptionId, 500)
        ).to.be.revertedWith("SmartWallet: charge too soon");
    });

    it("reverts when subscription is cancelled", async function () {
        const { wallet, merchant, subscriptionId, walletAddr } = await chargeFixture();

        await wallet.cancelSubscription(subscriptionId);
        await expect(
            merchant.callCharge(walletAddr, subscriptionId, 500)
        ).to.be.revertedWith("SmartWallet: subscription not active");
    });

    it("reverts when subscription is expired", async function () {
        const now = await time.latest();
        const { wallet, merchant, subscriptionId, walletAddr } = await chargeFixture(now + 100);
        await time.increase(200);   // jump to 200 seconds later
        await expect(
            merchant.callCharge(walletAddr, subscriptionId, 500)
        ).to.be.revertedWith("SmartWallet: subscription expired");
    });

    it("reverts when caller is not the authorized merchant", async function () {
        const { wallet, subscriptionId, walletAddr, stranger } = await chargeFixture();

        // stranger calls charge (not authorized merchant）
        await expect(
            wallet.connect(stranger).charge(subscriptionId, 500)
        ).to.be.revertedWith("SmartWallet: not authorized");
    });
});

describe("cancelSubscription", function () {
    // * cancel：no funding (cancel never touches ETH). defaults are fine.
    function cancelFixture() {
        return setupSubscription();
    }   

    it("owner can cancel an active subscription and event is emitted", async function () {
        const { wallet, subscriptionId } = await loadFixture(cancelFixture);

        await expect(wallet.cancelSubscription(subscriptionId))
            .to.emit(wallet, "SubscriptionCancelled")
            .withArgs(subscriptionId);

        const sub = await wallet.subscriptions(subscriptionId);
        expect(sub.active).to.equal(false);
    });

    it("reverts when called by non-owner", async function () {
        const { wallet, stranger, subscriptionId } = await loadFixture(cancelFixture);
        // existing subscription but called by stranger (not owner)
        await expect(
            wallet.connect(stranger).cancelSubscription(subscriptionId)
        ).to.be.revertedWith("SmartWallet: not owner");
    });

    it("reverts when cancelling twice", async function () {
        const { wallet, subscriptionId } = await loadFixture(cancelFixture);
        await wallet.cancelSubscription(subscriptionId);  // first: active true → success, active becomes false
        await expect(
            wallet.cancelSubscription(subscriptionId)      // second: merchant != 0 passes, active == false → blocked
        ).to.be.revertedWith("SmartWallet: subscription already cancelled");
    });

    it("reverts when subscription does not exist", async function () {
        const { wallet } = await loadFixture(cancelFixture);
        const fakeId = ethers.id("nonexistent");  // arbitrary bytes32，not corresponds to any sub → merchant == address(0)
        await expect(
            wallet.cancelSubscription(fakeId)
        ).to.be.revertedWith("SmartWallet: subscription not found");
    });

    it("re-subscribing after cancel yields a fresh active subscription with a new id", async function () {
        const { wallet, walletAddr, merchantAddr, subscriptionId: oldId } = await setupSubscription();  // nonce 0
        await wallet.cancelSubscription(oldId);

        // re-subscribe to the same merchant: nonce is incremented to 1, terms are updated
        await wallet.createSubscription(merchantAddr, 2000, 7200, 0);
        const newId = computeSubId(walletAddr, merchantAddr, 1);

        expect(newId).to.not.equal(oldId);                 // new and old ids are different (distinguished by nonce)

        const oldSub = await wallet.subscriptions(oldId);
        expect(oldSub.active).to.equal(false);             // the old one is still inactive, not revived

        const newSub = await wallet.subscriptions(newId);
        expect(newSub.active).to.equal(true);
        expect(newSub.lastCharged).to.equal(0);
        expect(newSub.maxAmountPerCharge).to.equal(2000);
        expect(newSub.interval).to.equal(7200);
    });
});

// * test reentrancy resistance (CEI)
describe("charge reentrancy", function () {
    // * reentrancy：fund 2x so a reentrant pull is blocked by "charge too soon" (CEI),
    // * not by "insufficient balance"; then arm the probe.
    async function reentrancyFixture() {
        const attackAmount = 500n;
        const ctx = await setupSubscription({ maxAmount: attackAmount, fundWei: attackAmount * 2n });
        await ctx.merchant.setAttack(ctx.subscriptionId, attackAmount);
        return { ...ctx, attackAmount };
    }

    it("CEI blocks reentrant charge: attacker is paid exactly once", async function () {
        const { wallet, merchant, subscriptionId, merchantAddr, attackAmount } =
            await loadFixture(reentrancyFixture);

        // Outer charge succeeds; the inner reentrant call is swallowed.
        await expect(merchant.callCharge(await wallet.getAddress(), subscriptionId, attackAmount))
            .to.emit(wallet, "Charged")
            .withArgs(subscriptionId, merchantAddr, attackAmount);

        // These two assertions are what actually prove CEI:
        // .to.emit only guarantees "at least once", not "exactly once".
        expect(await merchant.totalReceived()).to.equal(attackAmount);  // paid once, not 2x
        expect(await merchant.reentryCount()).to.equal(0n);             // reentry never succeeded

        const sub = await wallet.subscriptions(subscriptionId);
        expect(sub.active).to.equal(true);     // not cancelled
        expect(sub.lastCharged).to.be.gt(0);   // charged exactly once
    });
});

describe("validateUserOp", function () {
    it("returns 0 for a valid owner signature", async function () {
        const { owner, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);        

        // 1. build a UserOp with sender = walletAddr
        // 2. sign it with owner (signUserOp → fills userOp.signature)
        // 3. call entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, 0)
        // 4. assert validationData == 0
        const userOp = buildUserOp({ sender: walletAddr });
        const signedUserOp = await signUserOp(userOp, owner, entryPointAddr, chainId);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);

        // * func in MockEntryPoint.sol, missingAccountFunds = 0
        await entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, 0);
        const validationData = await entryPoint.lastValidationData();
        expect(validationData).to.equal(0);     // return 0 for valid signature
    });

    it("returns 1 for an invalid signature", async function () {
        const { stranger, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);        
        const strangerAddr = await stranger.getAddress();

        // * sign with stranger, should return 1
        const userOp = buildUserOp({ sender: walletAddr });
        const signedUserOp = await signUserOp(userOp, stranger, entryPointAddr, chainId);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);

        await entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, 0);
        const validationData = await entryPoint.lastValidationData();
        expect(validationData).to.equal(1);
    })

    it("prefunds the EntryPoint when missingAccountFunds > 0", async function () {
        const { owner, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);

        // missingAccountFunds = the gas prepayment the wallet still owes the
        // EntryPoint for this UserOp. When > 0, validateUserOp must transfer it
        // to the EntryPoint (msg.sender) during validation.
        const missingAccountFunds = ethers.parseEther("0.1");

        // 1. fund the wallet first (it needs ETH to prepay)
        //    → owner.sendTransaction({ to: walletAddr, value: ??? })
        // 2. build + sign UserOp (valid owner signature, same as happy path)
        // 3. call callValidateUserOp with missingAccountFunds = some value > 0
        // 4. assert：
        //    - lastValidationData == 0（valid signature）
        //    - entryPoint.totalPrefundReceived() == missingAccountFunds
        await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("1.0") });
        const userOp = buildUserOp({ sender: walletAddr });
        const signedUserOp = await signUserOp(userOp, owner, entryPointAddr, chainId);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);

        await entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, missingAccountFunds);
        expect(await entryPoint.lastValidationData()).to.equal(0);
        expect(await entryPoint.totalPrefundReceived()).to.equal(missingAccountFunds);
    });

    it("reverts when called by a non-EntryPoint address", async function () {
        const { owner, wallet, stranger, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);

        // build + sign a perfectly valid UserOp
        const userOp = buildUserOp({ sender: walletAddr });
        const signedUserOp = await signUserOp(userOp, owner, entryPointAddr, chainId);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);

        // call validateUserOp DIRECTLY on the wallet (bypassing MockEntryPoint),
        // connected as stranger → msg.sender != entryPoint → onlyEntryPoint blocks it.
        await expect(
            wallet.connect(stranger).validateUserOp(signedUserOp, userOpHash, 0)
        ).to.be.revertedWith("SmartWallet: not EntryPoint");
    });

    it("returns 1 for a signature from a different chainId (replay resistance)", async function () {
        const { owner, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);

        const userOp = buildUserOp({ sender: walletAddr });

        // sign against a WRONG chainId (simulating a signature minted on another chain),
        // but the EntryPoint verifies against the REAL chainId.
        // signer recovered from the wrong-chain signature != owner → 1
        const signedUserOp = await signUserOp(userOp, owner, entryPointAddr, chainId + 1n);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);
        await entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, 0);
        expect(await entryPoint.lastValidationData()).to.equal(1);
    });

    it("does not revert when wallet cannot afford the prefund", async function () {
        const { owner, entryPoint, walletAddr, entryPointAddr, chainId } = await loadFixture(deployFixture);

        // → balance is 0, cannot pay the prefund
        const missingAccountFunds = ethers.parseEther("0.1");

        // build + sign a valid UserOp
        const userOp = buildUserOp({ sender: walletAddr });
        const signedUserOp = await signUserOp(userOp, owner, entryPointAddr, chainId);
        const userOpHash = getUserOpHash(userOp, entryPointAddr, chainId);

        // even though the prefund transfer fails (balance 0), validateUserOp must
        // still return 0 and NOT revert — the `(ok);` line intentionally ignores
        // the failed transfer (avoids triggering bundler blacklist).
        await entryPoint.callValidateUserOp(walletAddr, signedUserOp, userOpHash, missingAccountFunds);
        expect(await entryPoint.lastValidationData()).to.equal(0);
        expect(await entryPoint.totalPrefundReceived()).to.equal(0n);  // nothing transferred
    });
});

describe("execute", function () {
    it("owner can execute a plain ETH transfer to a target", async function () {
        const { owner, wallet, merchant, walletAddr, merchantAddr } = await loadFixture(deployFixture);

        // fund the wallet so it can forward ETH
        await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("1.0") });

        const value = ethers.parseEther("0.1");
        
        // owner calls execute(target=merchant, value, data="0x")
        // → low-level call forwards `value` ETH to merchant's receive()
        await wallet.execute(merchantAddr, value, "0x");

        // assert: merchant.totalReceived() == value
        expect(await merchant.totalReceived()).to.equal(value);
    });

    it("EntryPoint can drive a charge end-to-end via execute", async function () {
        // this is the full Path: callExecute → wallet.execute → wallet.charge
        const ctx = await setupSubscription({ fundWei: ethers.parseEther("1.0") });
        const { wallet, merchant, entryPoint, walletAddr, subscriptionId, merchantAddr } = ctx;
        const amount = 500n;

        // encode the charge(subscriptionId, amount) call
        const chargeData = wallet.interface.encodeFunctionData("charge", [subscriptionId, amount]);

        // EntryPoint drives execute, with target = the wallet ITSELF so that
        // inside charge, msg.sender == address(this).
        // * para: (wallet, target, value, data), target = walletAddr means the wallet call itself,
        // * value = 0 means the charge pulls from the waller'a balance, not from msg.value
        await expect(
            entryPoint.callExecute(walletAddr, walletAddr, 0, chargeData)
        ).to.emit(wallet, "Charged").withArgs(subscriptionId, merchantAddr, amount);

        expect(await merchant.totalReceived()).to.equal(amount);
    });

    it("reverts when called by an unauthorized address", async function () {
        const { stranger, wallet, merchant, walletAddr } = await loadFixture(deployFixture);
        // stranger calls execute → not entryPoint, not owner → revert
        const amount = 500n;
        await expect(
            wallet.connect(stranger).execute(walletAddr, 0, "0x")
        ).to.be.revertedWith("SmartWallet: not authorized");
    });

    it("bubbles up the target's revert reason", async function () {
        const { owner, wallet, merchant, walletAddr, merchantAddr } = await loadFixture(deployFixture);

        await owner.sendTransaction({ to: walletAddr, value: ethers.parseEther("1.0") });
        await merchant.setShouldRevert(true);        

        // owner executes an ETH transfer to merchant → merchant's receive() reverts
        // assert the OUTER execute reverts with the INNER (target's) message,
        // proving the assembly bubble-up works:
        await expect(
            wallet.execute(merchantAddr, ethers.parseEther("0.1"), "0x")
        ).to.be.revertedWith("MockMerchant: Payment rejected");
    });
});