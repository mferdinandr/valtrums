// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Deposit-attribution prototype for isolated tests only.
/// @dev No withdrawals or recovery exist. Do not deploy or deposit real funds.
contract TestnetDepositCustody {
    uint256 private entered = 1;
    uint256 public nextDepositId;

    event Deposited(
        uint256 indexed depositId,
        address indexed token,
        address indexed depositor,
        uint64 battleId,
        uint64 mappingVersion,
        string beneficiary,
        uint256 requested,
        uint256 received
    );

    error InvalidDeposit();
    error ReentrantDeposit();
    error TransferFailed();
    error InvalidBalanceChange();

    /// @dev Token eligibility and finalized source evidence must be checked
    /// independently. A malicious token can lie about balance or callbacks.
    function deposit(address token, uint64 battleId, uint64 mappingVersion, string calldata beneficiary, uint256 amount)
        external
        returns (uint256 depositId, uint256 received)
    {
        if (entered != 1) revert ReentrantDeposit();
        if (
            token.code.length == 0 || mappingVersion == 0 || bytes(beneficiary).length < 2
                || bytes(beneficiary).length > 64 || amount == 0
        ) {
            revert InvalidDeposit();
        }
        entered = 2;
        uint256 beforeBalance = IERC20Balance(token).balanceOf(address(this));
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount)
        );
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
        uint256 afterBalance = IERC20Balance(token).balanceOf(address(this));
        if (afterBalance <= beforeBalance) revert InvalidBalanceChange();
        received = afterBalance - beforeBalance;
        if (received > amount) revert InvalidBalanceChange();
        depositId = ++nextDepositId;
        emit Deposited(depositId, token, msg.sender, battleId, mappingVersion, beneficiary, amount, received);
        entered = 1;
    }
}
