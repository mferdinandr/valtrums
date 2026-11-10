// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../src/TestnetDepositCustody.sol";

interface ScriptVm {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function addr(uint256 privateKey) external returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Testnet-only deployment of the forwarder deposit contract (issue #148).
/// @dev The signing key is read from the environment (`DEPLOYER_PRIVATE_KEY`), never passed as a command-line
/// argument, and the holder (`FORWARDER_HOLDER`) must be the account the payout contract signs for. Exactly one
/// transaction is broadcast. Run without `--broadcast` first to simulate.
contract DeployForwarder {
    ScriptVm private constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (address deployed, address holder) {
        holder = vm.envAddress("FORWARDER_HOLDER");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        // The key must belong to the expected deployer, checked in-process so it never appears as an argument.
        require(vm.addr(key) == vm.envAddress("DEPLOYER_ADDRESS"), "key does not match DEPLOYER_ADDRESS");
        vm.startBroadcast(key);
        deployed = address(new TestnetDepositCustody(holder));
        vm.stopBroadcast();
    }
}
