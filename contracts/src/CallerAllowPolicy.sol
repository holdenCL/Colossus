// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPolicyEngine} from "@chainlink/policy-management/interfaces/IPolicyEngine.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CallerAllowPolicy — Custom Chainlink ACE policy for Colossus (V4.1 — FIXED)
/// @notice Checks whether the transaction caller (msg.sender of the protected function)
///         is on an allowlist. If not, the policy reverts with PolicyRejected.
///
/// @dev FIX (Feb 25): Two changes from original:
///      1. Changed return from Continue to Allowed when caller IS on list
///      2. Changed revert PolicyRejected to return Continue when caller is NOT on list
///
///      Why: PolicyEngine catches reverts via _handlePolicyError and re-throws them,
///      which means a revert bypasses defaultAllow entirely. By returning Continue
///      for unknown callers, the policy says "I have no opinion" and defers to
///      defaultAllow. Only callers on the allowlist get an explicit Allowed.
///
///      Semantics:
///        - On allowlist → Allowed (explicit approval, early return)
///        - Not on allowlist → Continue (no opinion, defer to defaultAllow)
///
///      4-beat demo flow:
///        A. defaultAllow=true, not on list → Continue → defaultAllow passes ✓
///        B. defaultAllow=false, not on list → Continue → defaultAllow rejects ✗
///        C. defaultAllow=false, ON list → Allowed → early return passes ✓
///        D. defaultAllow=false, removed from list → Continue → defaultAllow rejects ✗
///
///      Demo flow (4-beat):
///        A. defaultAllow=true, no policies → weave works (baseline)
///        B. Attach policy + defaultAllow=false → weave reverts (enforcement)
///        C. allowAddress(addr) → weave succeeds (per-address allowlisting)
///        D. disallowAddress(addr) → weave reverts again (removal works)
contract CallerAllowPolicy is Ownable {

    mapping(address => bool) public allowList;

    event AddressAllowed(address indexed account);
    event AddressDisallowed(address indexed account);

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Add an address to the allowlist
    function allowAddress(address account) external onlyOwner {
        require(!allowList[account], "already allowed");
        allowList[account] = true;
        emit AddressAllowed(account);
    }

    /// @notice Remove an address from the allowlist
    function disallowAddress(address account) external onlyOwner {
        require(allowList[account], "not on list");
        allowList[account] = false;
        emit AddressDisallowed(account);
    }

    /// @notice Check if an address is on the allowlist
    function isAllowed(address account) external view returns (bool) {
        return allowList[account];
    }

    // ═══════════════════════════════════════════════════════════════════
    // ─── IPolicy interface (called by PolicyEngine) ─────────────────
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Called by PolicyEngine to evaluate the policy
    /// @param caller The msg.sender of the protected function (e.g. the user calling weave())
    /// @return Allowed if caller is allowlisted, Continue if not (defers to defaultAllow)
    function run(
        address caller,
        address,              /* subject (the factory contract) */
        bytes4,               /* selector */
        bytes[] calldata,     /* extracted parameters — unused */
        bytes calldata        /* context */
    ) external view returns (IPolicyEngine.PolicyResult) {
        if (!allowList[caller]) {
            return IPolicyEngine.PolicyResult.Continue;  // no opinion — defer to defaultAllow
        }
        return IPolicyEngine.PolicyResult.Allowed;  // explicitly approved
    }

    /// @notice Post-execution hook (no-op for this policy)
    function postRun(
        address, address, bytes4, bytes[] calldata, bytes calldata
    ) external {}

    /// @notice Called when policy is installed on a selector (no-op)
    function onInstall(bytes4) external {}

    /// @notice Called when policy is removed from a selector (no-op)
    function onUninstall(bytes4) external {}
}
