// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/CallerAllowPolicy.sol";

/// @notice Deploy ONLY the fixed CallerAllowPolicy. All other contracts stay as-is.
contract DeployFixedPolicy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        CallerAllowPolicy policy = new CallerAllowPolicy(deployer);
        console.log("CallerAllowPolicy (FIXED):", address(policy));

        vm.stopBroadcast();
    }
}
