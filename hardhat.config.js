require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
	solidity: {
		version: "0.8.28",
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			evmVersion: "cancun",
		},
	},
	networks: {
		hardhat: {
			// local network, for testing
			forking: process.env.FORK_SEPOLIA ? { url: process.env.SEPOLIA_RPC_URL } : undefined,
			initialBaseFeePerGas: 0,   // local chain starts at base fee 0, stays near 0
		},
		sepolia: {
			url: process.env.SEPOLIA_RPC_URL || "",
			accounts: [
				process.env.DEPLOYER_KEY,
				process.env.OWNER_KEY,
			].filter(Boolean),
		},
	},
};