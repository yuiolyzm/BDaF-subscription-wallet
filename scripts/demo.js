// scripts/demo.js
const { ethers, network } = require("hardhat");
const fs = require("fs");
const { buildUserOp } = require("../test/helpers/userOp");

async function main() {
	// ---------- setup ----------
	const d = JSON.parse(fs.readFileSync("deployed.json", "utf8"));
	const [deployer, owner, bundler] = await ethers.getSigners();
	if (owner.address.toLowerCase() !== d.owner.toLowerCase()) {
		throw new Error(`Signer ${owner.address} != deployed owner ${d.owner}`);
	}
	const factory = await ethers.getContractAt("SmartWalletFactory", d.factory);
	const merchant = await ethers.getContractAt("MockMerchant", d.merchant);
	const entryPoint = new ethers.Contract(d.entryPoint, [
		"function getNonce(address sender, uint192 key) view returns (uint256)",
		"function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)) view returns (bytes32)",
		"function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[], address)",
		"event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"
	], ethers.provider);

	console.log("Network:", network.name);
	console.log("Deployer:", deployer.address);
	console.log("Owner:", owner.address);
	console.log("Bundler:", bundler.address);

	// ============================================================
	// Phase 1 — counterfactual deployment (UserOp #0)
	// ============================================================
	// Fresh salt per run => new wallet => Phase 1 always deploys.
	// For the "official record" run, hardcode salt to fix the address.
	const salt = ethers.id("demo-v1");

	// 1a. Compute the wallet address while no contract exists there yet.
	const wallet = await factory.getWalletAddress(owner.address, salt);
	console.log("Counterfactual wallet:", wallet);

	// 1b. Fund an address that has no code yet — the essence of counterfactual funding.
	const minNeeded = ethers.parseEther("0.02");
	const bal = await ethers.provider.getBalance(wallet);
	if (bal < minNeeded) {
		const tx = await owner.sendTransaction({ to: wallet, value: minNeeded - bal });
		await tx.wait();
		console.log("Topped up to 0.01 ETH");
	} else {
		console.log("Wallet already funded, skip");
	}
	// 1c. initCode = factory address ++ createWallet(owner, salt) calldata.
	//    The EntryPoint will execute initCode to deploy the wallet.
	const createData = factory.interface.encodeFunctionData("createWallet", [owner.address, salt]);
	const initCode = ethers.concat([d.factory, createData]);

	// 1d. UserOp#0: deploy only (empty callData); verificationGasLimit must be high.
	//     verificationGasLimit = deploy wallet + validateUserOp in v0.7
	const nonce = await entryPoint.getNonce(wallet, 0n);
	const userOp0 = buildUserOp({
		sender: wallet,
		nonce,
		initCode,
		callData: "0x",
		verificationGasLimit: 2_000_000n,  // must cover deploying the whole SmartWallet
		callGasLimit: 50_000n,
	});

	// 1e. Sign: take the hash from the REAL EntryPoint, reuse the EIP-191 scheme.
	const userOpHash = await entryPoint.getUserOpHash(userOp0);
	const sig = await owner.signMessage(ethers.getBytes(userOpHash));
	const signed0 = { ...userOp0, signature: sig };

	// 1f. Submit as our own bundler; beneficiary (gas refund) = ourselves.
	const tx = await entryPoint.connect(bundler).handleOps([signed0], bundler.address);
	const rcpt = await tx.wait();
	console.log("UserOp#0 mined:", rcpt.hash);

	// 1g. Prove the wallet now exists.
	if ((await ethers.provider.getCode(wallet)) === "0x") {
		throw new Error("Wallet was not deployed by UserOp#0");
	}
	const sw = await ethers.getContractAt("SmartWallet", wallet);
	console.log("Wallet deployed via first UserOp (counterfactual)");

	// ============================================================
	// Phase 2 — authorize 3 subscriptions (owner calls directly)  [TODO]
	// ============================================================
	// owner calls wallet.createSubscription(...) x3 (Netflix / Billing / Usage).
	// onlyOwner => must be the owner EOA directly, NOT via UserOp (see earlier design note).
	const DAY = 24 * 60 * 60;
	const now = (await ethers.provider.getBlock("latest")).timestamp;

	// Same charge() primitive; the 3 "modes" are just different parameter envelopes.
	const modes = [
		// Netflix: fixed fee. cap == price => zero headroom for the merchant.
		// Billing: post-paid, variable amount within a monthly cap (headroom by design).
		// Usage: small + frequent. short interval => many pulls; watch AGGREGATE exposure.
		{ name: "Netflix", max: ethers.parseEther("0.001"), interval: 30 * DAY, expiry: now + 365 * DAY },
		{ name: "Billing", max: ethers.parseEther("0.005"), interval: 30 * DAY, expiry: now + 365 * DAY },
		{ name: "Usage", max: ethers.parseEther("0.0002"),  interval: 300, 		expiry: now + 30  * DAY },
	];

	const subIds = {};
	for (const mode of modes) {
		const cTx = await sw.connect(owner).createSubscription(d.merchant, mode.max, mode.interval, mode.expiry);
		const rcpt2 = await cTx.wait();
		// subscriptionId is a RETURN value => read it from the SubscriptionCreated event, not the tx result.
		const ev = rcpt2.logs
			.map((l) => { try { return sw.interface.parseLog(l); } catch { return null; } })
			.find((p) => p && p.name === "SubscriptionCreated");
		subIds[mode.name] = ev.args.id;   // bytes32: keccak256(wallet, merchant, nonce=0)
		console.log(`[Phase 2] ${mode.name.padEnd(8)} subId: ${subIds[mode.name]}`);
	}

	// ctx bundle for the Phase 3 / Phase 4 charge helper.
	const ctx = { entryPoint, wallet, owner, bundler, sw };

	// ------------------------------------------------------------
	// Helper: charge one subscription through the full 4337 path (Path C).
	// Same submit flow as Phase 1, but: non-empty callData, empty initCode,
	// modest gas (no deploy this time). Returns the receipt.
	// ------------------------------------------------------------
	async function chargeViaUserOp(ctx, subId, amount) {
		const { entryPoint, wallet, owner, bundler, sw } = ctx;

		// callData: EntryPoint -> wallet.execute(wallet, 0, charge(subId, amount))
		//   target = wallet (address(this)) so inside charge msg.sender == wallet => Path C.
		const chargeData = sw.interface.encodeFunctionData("charge", [subId, amount]);
		const callData = sw.interface.encodeFunctionData("execute", [wallet, 0, chargeData]);

		const nonce = await entryPoint.getNonce(wallet, 0n);
		const op = buildUserOp({
			sender: wallet,
			nonce,
			initCode: "0x",                 // wallet already exists
			callData,
			verificationGasLimit: 200_000n, // no deploy now => far less than Phase 1
			callGasLimit: 200_000n,         // execute + charge + ETH transfer
		});

		const userOpHash = await entryPoint.getUserOpHash(op);
		const sig = await owner.signMessage(ethers.getBytes(userOpHash));
		const signed = { ...op, signature: sig };

		// bundler submits AND is the gas-refund beneficiary (real economic separation).
		const tx = await entryPoint.connect(bundler).handleOps([signed], bundler.address);
		return tx.wait();
	}

	// ============================================================
	// Phase 3 — charge each mode via UserOp (Path C)  
	// ============================================================
	// Netflix = max (fixed price, no merchant headroom)
	// Billing < max (post-paid partial bill, merchant decides how much within cap)
	// Usage   < max (micro-charge per usage event)
	const chargeAmounts = {
		Netflix: ethers.parseEther("0.001"),
		Billing: ethers.parseEther("0.003"),
		Usage: ethers.parseEther("0.0001"),
	}

	for (const mode of modes) {
		const rcpt3 = await chargeViaUserOp(ctx, subIds[mode.name], chargeAmounts[mode.name]);
		console.log(`[Phase 3] ${mode.name.padEnd(8)} charged ${ethers.formatEther(chargeAmounts[mode.name])} ETH | tx: ${rcpt3.hash}`);
	}
	const totalAfterP3 = await merchant.totalReceived();
	console.log(`[Phase 3] Merchant totalReceived: ${ethers.formatEther(totalAfterP3)} ETH`);

	// ============================================================
	// Phase 4 — cancel Netflix and Usage + prove subsequent charge reverts
	// ============================================================
	// * time travel to one month later
	await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
	await ethers.provider.send("evm_mine", []);

	// 4a. cancel subscription of Netflix + Usage
	await (await sw.connect(owner).cancelSubscription(subIds["Netflix"])).wait();
	await (await sw.connect(owner).cancelSubscription(subIds["Usage"])).wait();
	console.log("[Phase 4] Netflix + Usage cancelled");

	// helper: get UserOperationEvent.success from receipt logs
	function getSuccess(rcpt) {
		const ev = rcpt.logs
			.map(l => { try { return entryPoint.interface.parseLog(l); } catch { return null; } })
			.find(p => p && p.name === "UserOperationEvent");
		if (!ev) throw new Error("UserOperationEvent not found");
		return ev.args.success;
	}

	// 4b. Netflix → should fail
	const r1 = await chargeViaUserOp(ctx, subIds["Netflix"], chargeAmounts["Netflix"]);
	if (getSuccess(r1))  throw new Error("Netflix should have failed");
	console.log("[Phase 4] ✓ Netflix charge rejected");

	// 4c. Usage → should fail
	const r2 = await chargeViaUserOp(ctx, subIds["Usage"], chargeAmounts["Usage"]);
	if (getSuccess(r2))  throw new Error("Usage should have failed");
	console.log("[Phase 4] ✓ Usage charge rejected");

	// 4d. Billing → should success
	const r3 = await chargeViaUserOp(ctx, subIds["Billing"], chargeAmounts["Billing"]);
	if (!getSuccess(r3)) throw new Error("Billing should have succeeded");
	console.log("[Phase 4] ✓ Billing charge still works (unaffected)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });