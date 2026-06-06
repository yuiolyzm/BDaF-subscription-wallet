// scripts/deploy.js
const { ethers, network } = require("hardhat");
const fs = require("fs");

// Canonical ERC-4337 EntryPoint v0.7 — same address on every chain (incl. Sepolia).
const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
    const [deployer, owner, bundler] = await ethers.getSigners();
    const bal = await ethers.provider.getBalance(deployer.address);
    console.log("Network :", network.name);
    console.log("Deployer:", deployer.address);
    console.log("Balance :", ethers.formatEther(bal), "ETH");

    // (1) Sanity-check the EntryPoint exists on THIS network before we wire it in.
    if ((await ethers.provider.getCode(ENTRYPOINT_V07)) === "0x") {
        throw new Error(
            `No EntryPoint at ${ENTRYPOINT_V07} on '${network.name}'. ` +
            `Use --network sepolia, or a Sepolia fork.`
        );
    }

    // (2) Factory carries entryPoint; every wallet it deploys inherits this value.
    const Factory = await ethers.getContractFactory("SmartWalletFactory");
    const factory = await Factory.deploy(ENTRYPOINT_V07);
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();

    // (3) Merchant = passive charge recipient for the demo.
    const Merchant = await ethers.getContractFactory("MockMerchant");
    const merchant = await Merchant.deploy();
    await merchant.waitForDeployment();
    const merchantAddr = await merchant.getAddress();

    // (4) Persist addresses so demo.js can read them (decouples deploy from demo).
    const out = {
        network: network.name,
        entryPoint: ENTRYPOINT_V07,
        factory: factoryAddr,
        merchant: merchantAddr,
        owner: owner.address,
        bundler: bundler.address,
    };
    fs.writeFileSync("deployed.json", JSON.stringify(out, null, 2));

    console.log("Factory :", factoryAddr);
    console.log("Merchant:", merchantAddr);
    console.log("Saved   -> deployed.json");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });