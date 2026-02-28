// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BasketFactory.sol";
import "../src/CCIPBasketBridge.sol";
import "../src/CallerAllowPolicy.sol";
import {PolicyEngine} from "@chainlink/policy-management/core/PolicyEngine.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Deploy all Colossus V4 contracts on a single chain.
///         Run once per chain with appropriate env vars.
///
/// Deploys:
///   1. PolicyEngine (implementation + ERC1967Proxy, defaultAllow=true)
///   2. BasketFactory (V4, attached to PolicyEngine)
///   3. CCIPBasketBridge
///   4. CallerAllowPolicy (ready to attach later for demo)
///
/// Usage:
///   LINK=0x... ROUTER=0x... FEE_RECIPIENT=0x... forge script script/Deploy.s.sol \
///     --rpc-url $RPC --private-key $KEY --broadcast -vvvv
contract Deploy is Script {
    function run() external {
        address link = vm.envAddress("LINK");
        address router = vm.envAddress("ROUTER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast();

        // 1. Deploy PolicyEngine behind ERC1967Proxy
        //    - Implementation constructor calls _disableInitializers()
        //    - Proxy constructor calls initialize(defaultAllow=true, owner=deployer)
        PolicyEngine peImpl = new PolicyEngine();
        console.log("PolicyEngine impl:", address(peImpl));

        bytes memory initData = abi.encodeWithSelector(
            PolicyEngine.initialize.selector,
            true,        // defaultAllow = true → everything passes by default
            msg.sender   // initialOwner → gets ADMIN_ROLE, POLICY_CONFIG_ADMIN_ROLE
        );
        ERC1967Proxy peProxy = new ERC1967Proxy(address(peImpl), initData);
        address policyEngine = address(peProxy);
        console.log("PolicyEngine proxy:", policyEngine);

        // 2. Deploy BasketFactory (V4 — also deploys Escrow in its constructor)
        //    Constructor attaches to PolicyEngine (calls policyEngine.attach())
        BasketFactory factory = new BasketFactory(link, feeRecipient, policyEngine);
        console.log("BasketFactory:", address(factory));
        console.log("Escrow:", address(factory.escrow()));

        // 3. Deploy CCIPBasketBridge
        CCIPBasketBridge bridge = new CCIPBasketBridge(router, link, address(factory));
        console.log("CCIPBasketBridge:", address(bridge));

        // 4. Authorize the bridge on the factory
        factory.setBridge(address(bridge));
        console.log("Bridge authorized on factory");

        // 5. Deploy CallerAllowPolicy (ready to attach for ACE demo)
        CallerAllowPolicy allowPolicy = new CallerAllowPolicy(msg.sender);
        console.log("CallerAllowPolicy:", address(allowPolicy));

        vm.stopBroadcast();

        // Print summary
        console.log("");
        console.log("=== V4 Deployment Complete ===");
        console.log("PolicyEngine (proxy):", policyEngine);
        console.log("BasketFactory:", address(factory));
        console.log("Escrow:", address(factory.escrow()));
        console.log("CCIPBasketBridge:", address(bridge));
        console.log("CallerAllowPolicy:", address(allowPolicy));
        console.log("");
        console.log("PolicyEngine defaultAllow = true");
        console.log("All weave/createBasket calls pass through (same as V3 behavior)");
        console.log("Run ACE demo commands to enable policy enforcement");
    }
}
