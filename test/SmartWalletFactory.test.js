const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildUserOp, getUserOpHash, signUserOp } = require("./helpers/userOp");
const abi = ethers.AbiCoder.defaultAbiCoder();

describe("SmartWalletFactory", function () {
    async function factoryFixture() {
        const [owner, stranger] = await ethers.getSigners();
        const MockEntryPoint = await ethers.getContractFactory("MockEntryPoint");
        const entryPoint = await MockEntryPoint.deploy();
        const entryPointAddr = await entryPoint.getAddress();

        const Factory = await ethers.getContractFactory("SmartWalletFactory");
        const factory = await Factory.deploy(entryPointAddr);

        return { owner, stranger, entryPoint, entryPointAddr, factory };
    }

    it("deploys a wallet at the address predicted by getWalletAddress", async function () {
        const { owner, factory } = await loadFixture(factoryFixture);
        const salt = ethers.id("salt-1");  // any bytes32

        // predict the address BEFORE deploying
        // before deploy: no code at that address yet (counterfactual)
        const predicted = await factory.getWalletAddress(owner.address, salt);
        expect(await ethers.provider.getCode(predicted)).to.equal("0x");

        // deploy for real
        // after deploy: code now exists at the SAME predicted address
        await factory.createWallet(owner.address, salt);
        expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });

    it("deployed wallet has the correct owner and entryPoint", async function () {
        const { owner, factory, entryPointAddr } = await loadFixture(factoryFixture);
        const salt = ethers.id("salt-2");

        const predicted = await factory.getWalletAddress(owner.address, salt);
        await factory.createWallet(owner.address, salt);

        // attach the SmartWallet ABI to the deployed address and read its state
        const wallet = await ethers.getContractAt("SmartWallet", predicted);
        expect(await wallet.owner()).to.equal(owner.address);
        expect(await wallet.entryPoint()).to.equal(entryPointAddr);
    });

    it("is idempotent: deploying twice returns the same address without reverting", async function () {
        const { owner, factory } = await loadFixture(factoryFixture);
        const salt = ethers.id("salt-3");

        const predicted = await factory.getWalletAddress(owner.address, salt);
        await factory.createWallet(owner.address, salt);            // first deploy
        // second call: use staticCall to read the RETURNED address (real tx gives a receipt, not the address)
        const returnedAddr = await factory.createWallet.staticCall(owner.address, salt);
        expect(returnedAddr).to.equal(predicted);
    });
});