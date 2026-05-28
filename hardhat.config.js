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
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",   
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};