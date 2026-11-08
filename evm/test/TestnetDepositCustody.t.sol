// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../src/TestnetDepositCustody.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract FixtureToken {
    mapping(address => uint256) public balanceOf;
    uint256 public fee;
    bool public fails;
    TestnetDepositCustody public reenter;
    bool public reentryBlocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function setFails(bool value) external {
        fails = value;
    }

    function setReenter(TestnetDepositCustody value) external {
        reenter = value;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (fails) return false;
        if (address(reenter) != address(0)) {
            try reenter.deposit(address(this), 1, 1, address(0xBEEF), "alice.testnet", 1) {
                revert("reentry succeeded");
            } catch {
                reentryBlocked = true;
            }
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return true;
    }
}

contract TestnetDepositCustodyTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant REFUND = address(0xBEEF);
    TestnetDepositCustody private custody;
    FixtureToken private token;

    function setUp() public {
        custody = new TestnetDepositCustody();
        token = new FixtureToken();
        token.mint(address(this), 1000);
    }

    function testActualReceivedAndPriorDonationAreSeparate() public {
        token.mint(address(custody), 25);
        token.setFee(2);
        (uint256 id, uint256 received) = custody.deposit(address(token), 7, 1, REFUND, "alice.testnet", 100);
        require(id == 1 && received == 98, "incorrect attribution");
        require(token.balanceOf(address(custody)) == 123, "balance mismatch");
        (, received) = custody.deposit(address(token), 7, 1, REFUND, "alice.testnet", 100);
        require(received == 98 && custody.nextDepositId() == 2, "second deposit mismatch");
    }

    function testRejectedTransfersAndInvalidIdentityDoNotCreateDeposits() public {
        token.setFails(true);
        (bool ok,) = address(custody).call(abi.encodeCall(custody.deposit, (address(token), 1, 1, REFUND, "alice.testnet", 10)));
        require(!ok && custody.nextDepositId() == 0, "failed transfer credited");
        token.setFails(false);
        (ok,) = address(custody).call(abi.encodeCall(custody.deposit, (address(token), 1, 0, REFUND, "alice.testnet", 10)));
        require(!ok && custody.nextDepositId() == 0, "invalid mapping credited");
    }

    function testTokenCannotReenterDeposit() public {
        token.setReenter(custody);
        (, uint256 received) = custody.deposit(address(token), 1, 1, REFUND, "alice.testnet", 10);
        require(received == 10 && token.reentryBlocked() && custody.nextDepositId() == 1, "reentry was not blocked");
    }

    function testDepositEventBindsAttributionAndActualAmount() public {
        token.setFee(2);
        vm.recordLogs();
        custody.deposit(address(token), 7, 3, REFUND, "alice.testnet", 100);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(custody), "unexpected event source");
        require(
            logs[0].topics[0] == keccak256("Deposited(uint256,address,address,uint64,uint64,address,string,uint256,uint256)"),
            "wrong event"
        );
        require(uint256(logs[0].topics[1]) == 1, "wrong deposit id");
        require(address(uint160(uint256(logs[0].topics[2]))) == address(token), "wrong token");
        require(address(uint160(uint256(logs[0].topics[3]))) == address(this), "wrong depositor");
        (uint64 battle, uint64 version, address refund, string memory beneficiary, uint256 requested, uint256 received) =
            abi.decode(logs[0].data, (uint64, uint64, address, string, uint256, uint256));
        require(refund == REFUND, "wrong refund address");
        require(
            battle == 7 && version == 3 && keccak256(bytes(beneficiary)) == keccak256("alice.testnet"),
            "wrong attribution"
        );
        require(requested == 100 && received == 98, "wrong amounts");
    }

    function testZeroRefundAddressIsRejected() public {
        (bool ok,) = address(custody)
            .call(abi.encodeCall(custody.deposit, (address(token), 1, 1, address(0), "alice.testnet", 10)));
        require(!ok && custody.nextDepositId() == 0, "zero refund address accepted");
    }
}
