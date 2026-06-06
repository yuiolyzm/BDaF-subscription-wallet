// scripts/demo-sepolia.js
// Real-bundler version of demo.js: submits UserOps to Alchemy's bundler via eth_sendUserOperation
//
// Run: npx hardhat run scripts/demo-sepolia.js --network sepolia
// .env: SEPOLIA_RPC_URL (Alchemy, AA-enabled), DEPLOYER_KEY, OWNER_KEY, BUNDLER_KEY

const { ethers } = require("hardhat");
const fs = require("fs");

const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"; // canonical v0.7

// Minimal ABIs, hand-rolled so each Contract clearly states which functions it
// owns and we don't depend on Hardhat artifacts (EntryPoint has no artifact here).
const ENTRYPOINT_ABI = [
    "function getNonce(address sender, uint192 key) view returns (uint256)",
    "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)) view returns (bytes32)",
];
const FACTORY_ABI = [
    "function getWalletAddress(address owner, bytes32 salt) view returns (address)",
    "function createWallet(address owner, bytes32 salt) returns (address)",
];
const WALLET_ABI = [
    "function createSubscription(address merchant, uint256 maxAmountPerCharge, uint256 interval, uint256 expiry) returns (bytes32)",
    "function cancelSubscription(bytes32 subscriptionId)",
    "function charge(bytes32 subscriptionId, uint256 amount)",
    "function execute(address target, uint256 value, bytes data)",
    "event SubscriptionCreated(bytes32 indexed id, address indexed merchant, uint256 maxAmountPerCharge, uint256 interval, uint256 expiry)",
];
const MERCHANT_ABI = ["function totalReceived() view returns (uint256)"];

// Scaled 1/100 vs local demo to conserve Sepolia test ETH; gas dominates anyway.
const PREFUND = ethers.parseEther("0.03");
const CHARGE_AMOUNTS = {
    Netflix: ethers.parseEther("0.00001"),
    Billing: ethers.parseEther("0.00003"),
    Usage:   ethers.parseEther("0.000001"),
};
const DAY = 24 * 60 * 60;

const toHex = (v) => "0x" + BigInt(v).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (x) => (BigInt(x) * 125n) / 100n; // add 25% to avoid "underpriced" rejection

// Re-pack an unpacked op into bytes32 form, only to compute userOpHash on-chain.
function packForHash(op) {
    const initCode = op.factory ? ethers.concat([op.factory, op.factoryData]) : "0x";
    const accountGasLimits = ethers.toBeHex((BigInt(op.verificationGasLimit) << 128n) | BigInt(op.callGasLimit), 32);
    const gasFees = ethers.toBeHex((BigInt(op.maxPriorityFeePerGas) << 128n) | BigInt(op.maxFeePerGas), 32);
    return {
        sender: op.sender,
        nonce: BigInt(op.nonce),
        initCode,
        callData: op.callData,
        accountGasLimits,
        preVerificationGas: BigInt(op.preVerificationGas),
        gasFees,
        paymasterAndData: "0x",
        signature: op.signature,
    };
}

// eth_sendUserOperation returns an opHash before the op is on-chain.
// Poll until the bundler packs it into a block.
async function pollReceipt(provider, opHash, timeoutMs = 180_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await provider.send("eth_getUserOperationReceipt", [opHash]);
        if (r) return r;
        await sleep(4000);
    }
    throw new Error(`UserOp ${opHash} not mined within ${timeoutMs}ms`);
}

// Send one UserOp through the real bundler: estimate -> sign -> send -> poll.
// partialOp: { sender, nonce, callData, factory?, factoryData? }
async function sendUserOpViaBundler(provider, entryPoint, owner, partialOp) {
    const fee = await provider.getFeeData();

    // Sign twice, by design: a valid dummy sig is needed for estimation (the
    // bundler simulates validateUserOp, which runs ECDSA.recover), then gas
    // changes after estimation, so we recompute the hash and re-sign for real.
    const dummySig = await owner.signMessage(ethers.getBytes(ethers.ZeroHash));

    const op = {
        sender: partialOp.sender,
        nonce: toHex(partialOp.nonce),
        callData: partialOp.callData,
        callGasLimit: toHex(1_000_000n),
        verificationGasLimit: toHex(1_000_000n),
        preVerificationGas: toHex(100_000n),
        maxFeePerGas: toHex(bump(fee.maxFeePerGas)),
        maxPriorityFeePerGas: toHex(bump(fee.maxPriorityFeePerGas)),
        signature: dummySig,
    };
    if (partialOp.factory) {
        op.factory = partialOp.factory;       // unpacked: factory + factoryData,
        op.factoryData = partialOp.factoryData; // NOT a single packed initCode
    }

    const est = await provider.send("eth_estimateUserOperationGas", [op, ENTRYPOINT]);
    op.callGasLimit = est.callGasLimit;
    op.verificationGasLimit = est.verificationGasLimit;
    op.preVerificationGas = est.preVerificationGas;

    const userOpHash = await entryPoint.getUserOpHash(packForHash(op));
    op.signature = await owner.signMessage(ethers.getBytes(userOpHash));

    const opHash = await provider.send("eth_sendUserOperation", [op, ENTRYPOINT]);
    console.log("   submitted, opHash:", opHash);

    const receipt = await pollReceipt(provider, opHash);
    console.log("   mined in tx:", receipt.receipt.transactionHash, "| success:", receipt.success);
    return receipt;
}

async function main() {
    const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
    if (d.network !== "sepolia") {
        throw new Error(`deployed.json is for '${d.network}', re-run deploy.js --network sepolia`);
    }

    const provider = ethers.provider;
    const [deployer, owner] = await ethers.getSigners();
    if (owner.address.toLowerCase() !== d.owner.toLowerCase()) {
        throw new Error(`Signer ${owner.address} != deployed owner ${d.owner}`);
    }

    const entryPoint = new ethers.Contract(ENTRYPOINT, ENTRYPOINT_ABI, owner);
    const factory = new ethers.Contract(d.factory, FACTORY_ABI, owner);
    const merchant = new ethers.Contract(d.merchant, MERCHANT_ABI, provider);

    console.log("Network : sepolia (real bundler)");
    console.log("Owner   :", owner.address);

    // ===== Phase 1 — counterfactual deployment via the real bundler =====
    const salt = ethers.hexlify(ethers.randomBytes(32)); // fresh => always deploys
    const wallet = await factory.getWalletAddress(owner.address, salt);
    console.log("Counterfactual wallet:", wallet);

    const bal = await provider.getBalance(wallet);
    if (bal < PREFUND) {
        const fundTx = await owner.sendTransaction({ to: wallet, value: PREFUND - bal });
        await fundTx.wait();
        // Wait for the funding tx to confirm, then read the balance back to verify
        // the funds actually landed before submitting the op (else bundler -> AA21).
        const after = await provider.getBalance(wallet);
        console.log("Prefunded wallet ->", ethers.formatEther(after), "ETH");
    }

    const factoryData = factory.interface.encodeFunctionData("createWallet", [owner.address, salt]);
    const nonce0 = await entryPoint.getNonce(wallet, 0n);

    console.log("[Phase 1] deploying wallet via bundler...");
    await sendUserOpViaBundler(provider, entryPoint, owner, {
        sender: wallet,
        nonce: nonce0,
        callData: "0x",
        factory: d.factory,
        factoryData,
    });
    if ((await provider.getCode(wallet)) === "0x") throw new Error("Wallet not deployed");
    console.log("[Phase 1] wallet deployed counterfactually via real bundler");

    const sw = new ethers.Contract(wallet, WALLET_ABI, owner);

    // ===== Phase 2 — authorize 3 subscriptions (owner calls directly, onlyOwner) =====
    const now = (await provider.getBlock("latest")).timestamp;
    const modes = [
        { name: "Netflix", max: ethers.parseEther("0.00001"),  interval: 30 * DAY, expiry: now + 365 * DAY },
        { name: "Billing", max: ethers.parseEther("0.00005"),  interval: 30 * DAY, expiry: now + 365 * DAY },
        { name: "Usage",   max: ethers.parseEther("0.000002"), interval: 300,      expiry: now + 30 * DAY },
    ];

    const subIds = {};
    for (const mode of modes) {
        const tx = await sw.createSubscription(d.merchant, mode.max, mode.interval, mode.expiry);
        const rcpt = await tx.wait(); // real chain: wait for confirmation
        const ev = rcpt.logs
            .map((l) => { try { return sw.interface.parseLog(l); } catch { return null; } })
            .find((p) => p && p.name === "SubscriptionCreated");
        subIds[mode.name] = ev.args.id;
        console.log(`[Phase 2] ${mode.name.padEnd(8)} subId: ${subIds[mode.name]}`);
    }

    // ===== Phase 3 — charge each mode via the real bundler (Path C) =====
    for (const mode of modes) {
        const chargeData = sw.interface.encodeFunctionData("charge", [subIds[mode.name], CHARGE_AMOUNTS[mode.name]]);
        const callData = sw.interface.encodeFunctionData("execute", [wallet, 0, chargeData]);
        const nonce = await entryPoint.getNonce(wallet, 0n);
        console.log(`[Phase 3] charging ${mode.name}...`);
        // No factory/factoryData: wallet already exists, else bundler -> AA10.
        await sendUserOpViaBundler(provider, entryPoint, owner, { sender: wallet, nonce, callData });
    }
    console.log(`[Phase 3] Merchant totalReceived: ${ethers.formatEther(await merchant.totalReceived())} ETH`);

    // ===== Phase 4 — cancel Netflix + Usage, prove their charges now fail =====
    // No evm_increaseTime on a real chain: this proves cancel-scoping only, not
    // the interval guard (that proof stays in the local fork demo).
    await (await sw.cancelSubscription(subIds["Netflix"])).wait();
    await (await sw.cancelSubscription(subIds["Usage"])).wait();
    console.log("[Phase 4] Netflix + Usage cancelled");

    const totalBefore = await merchant.totalReceived();

    for (const name of ["Netflix", "Usage"]) {
        const chargeData = sw.interface.encodeFunctionData("charge", [subIds[name], CHARGE_AMOUNTS[name]]);
        const callData = sw.interface.encodeFunctionData("execute", [wallet, 0, chargeData]);
        const nonce = await entryPoint.getNonce(wallet, 0n);
        console.log(`[Phase 4] attempting ${name} charge (should fail)...`);
        const r = await sendUserOpViaBundler(provider, entryPoint, owner, { sender: wallet, nonce, callData });
        if (r.success) throw new Error(`${name} charge should have failed`);
        console.log(`[Phase 4] ${name} charge rejected (success=false)`);
    }

    const billingData = sw.interface.encodeFunctionData("charge", [subIds["Billing"], CHARGE_AMOUNTS["Billing"]]);
    const billingCall = sw.interface.encodeFunctionData("execute", [wallet, 0, billingData]);
    const nonceB = await entryPoint.getNonce(wallet, 0n);
    console.log("[Phase 4] charging Billing (should still work)...");
    const rb = await sendUserOpViaBundler(provider, entryPoint, owner, { sender: wallet, nonce: nonceB, callData: billingCall });
    if (!rb.success) throw new Error("Billing charge should have succeeded");
    console.log("[Phase 4] Billing still works (cancel is per-subscription)");

    const totalAfter = await merchant.totalReceived();
    console.log(`[Phase 4] Merchant received only the Billing charge: +${ethers.formatEther(totalAfter - totalBefore)} ETH`);
    console.log("\nDone. Check the tx hashes above on https://sepolia.etherscan.io");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });