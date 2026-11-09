// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../src/MockToken.sol";
import "../src/TestnetDepositCustody.sol";

contract Stranger {
    function tryMint(MockToken token) external returns (bool ok) {
        (ok,) = address(token).call(abi.encodeCall(token.mint, (address(this), 1)));
    }
}

/// Fixture tests: the mock token and its use through the real custody contract.
contract MockTokenTest {
    address private constant REFUND = address(0xBEEF);
    MockToken private token;

    function setUp() public {
        token = new MockToken("Mock CASHCAT", "mCASHCAT");
    }

    function testMetadataAndOwner() public view {
        require(keccak256(bytes(token.name())) == keccak256("Mock CASHCAT"), "name");
        require(keccak256(bytes(token.symbol())) == keccak256("mCASHCAT"), "symbol");
        require(token.decimals() == 18 && token.owner() == address(this), "metadata");
    }

    function testOnlyOwnerMints() public {
        Stranger stranger = new Stranger();
        require(!stranger.tryMint(token) && token.totalSupply() == 0, "stranger minted");
        token.mint(address(stranger), 5);
        require(token.balanceOf(address(stranger)) == 5 && token.totalSupply() == 5, "owner mint failed");
    }

    function testTransferFromNeedsAllowanceAndBalance() public {
        token.mint(address(this), 10);
        (bool ok,) = address(token).call(abi.encodeCall(token.transferFrom, (address(this), REFUND, 1)));
        require(!ok, "transferFrom without allowance");
        token.approve(address(this), 4);
        require(token.transferFrom(address(this), REFUND, 4), "transferFrom");
        require(token.balanceOf(REFUND) == 4 && token.allowance(address(this), address(this)) == 0, "balances");
        (ok,) = address(token).call(abi.encodeCall(token.transfer, (REFUND, 100)));
        require(!ok, "overdraft");
    }

    function testDepositThroughCustodyReceivesFullAmount() public {
        TestnetDepositCustody custody = new TestnetDepositCustody();
        token.mint(address(this), 1000);
        token.approve(address(custody), 1000);
        (uint256 id, uint256 received) = custody.deposit(address(token), 1, 3, REFUND, "alice.testnet", 1000);
        require(id == 1 && received == 1000 && token.balanceOf(address(custody)) == 1000, "deposit");
    }
}
