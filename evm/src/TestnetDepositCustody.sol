// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Deposit-attribution forwarder for testnet. It never holds tokens.
/// @dev `deposit` moves the tokens straight from the depositor to `holder`, the account the payout contract
/// signs for, and emits the attributed `Deposited` event. Because nothing stays in this contract there is no
/// withdrawal path to get wrong and no way for funds to be locked here. `holder` is fixed at construction and
/// must be an account without code: a contract that cannot sign could never pay the tokens out. Token
/// eligibility and finalized source evidence must be checked independently. A malicious token can lie about
/// balance or callbacks. Testnet only: do not deploy or deposit real funds without a separate review.
contract TestnetDepositCustody {
    uint256 private entered = 1;
    uint256 public nextDepositId;
    /// @notice The account that receives and holds every deposited token (the payout signing account).
    address public immutable holder;

    event Deposited(
        uint256 indexed depositId,
        address indexed token,
        address indexed depositor,
        uint64 battleId,
        uint64 mappingVersion,
        address refundAddress,
        string beneficiary,
        uint256 requested,
        uint256 received
    );

    error InvalidHolder();
    error InvalidDeposit();
    error ReentrantDeposit();
    error TransferFailed();
    error InvalidBalanceChange();

    constructor(address holder_) {
        // No zero address, no self, and no contract: an account with code may be unable to sign payouts.
        if (holder_ == address(0) || holder_ == address(this) || holder_.code.length != 0) revert InvalidHolder();
        holder = holder_;
    }

    /// @dev `refundAddress` is the EVM address a late deposit is returned to (D17); it is bound at
    /// deposit time and cannot be changed afterwards. `received` is the measured balance increase of `holder`,
    /// so a transfer tax is never counted as received.
    function deposit(
        address token,
        uint64 battleId,
        uint64 mappingVersion,
        address refundAddress,
        string calldata beneficiary,
        uint256 amount
    ) external returns (uint256 depositId, uint256 received) {
        if (entered != 1) revert ReentrantDeposit();
        if (
            token.code.length == 0 || mappingVersion == 0 || refundAddress == address(0)
                || bytes(beneficiary).length < 2 || bytes(beneficiary).length > 64 || amount == 0
        ) {
            revert InvalidDeposit();
        }
        entered = 2;
        uint256 beforeBalance = IERC20Balance(token).balanceOf(holder);
        (bool ok, bytes memory result) =
            token.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, holder, amount));
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
        uint256 afterBalance = IERC20Balance(token).balanceOf(holder);
        if (afterBalance <= beforeBalance) revert InvalidBalanceChange();
        received = afterBalance - beforeBalance;
        if (received > amount) revert InvalidBalanceChange();
        depositId = ++nextDepositId;
        emit Deposited(
            depositId, token, msg.sender, battleId, mappingVersion, refundAddress, beneficiary, amount, received
        );
        entered = 1;
    }
}
