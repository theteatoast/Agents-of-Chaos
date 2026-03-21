// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ChaosParimutuelMarket
/// @notice Single pool parimutuel: bettors’ USDC (after fee) is the entire liquidity — no owner seed.
/// @dev Fee on each bet (gross) goes to treasury; net stakes accrue on outcomes. On resolve, winners split
///      the full pool pro-rata by net stake on the winning outcome. Transparent on-chain balances.
contract ChaosParimutuelMarket is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public treasury;

    uint8 public constant MAX_OUTCOMES = 64;

    struct Market {
        uint64 closeTime;
        uint16 feeBps;
        bool active;
        bool resolved;
        uint8 outcomeCount;
        uint256 winningOutcome;
    }

    mapping(uint256 => Market) public markets;
    /// @notice Net stake (after fee) sitting on each outcome index.
    mapping(uint256 => mapping(uint256 => uint256)) public totalStakeOnOutcome;
    /// @notice Net stake per user per outcome.
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public stakeOf;
    /// @notice Sum of all net stakes in the market (the pot).
    mapping(uint256 => uint256) public totalPool;
    /// @notice Snapshots at resolve for fair pro-rata claims (order-independent).
    mapping(uint256 => uint256) public resolvedPoolSnapshot;
    mapping(uint256 => uint256) public resolvedWinningStakeSnapshot;

    event MarketRegistered(uint256 indexed marketId, uint64 closeTime, uint16 feeBps, uint8 outcomeCount);
    event BetPlaced(
        address indexed user,
        uint256 indexed marketId,
        uint256 outcomeIndex,
        uint256 grossUsdc,
        uint256 feeUsdc,
        uint256 netUsdc
    );
    event MarketResolved(uint256 indexed marketId, uint256 winningOutcomeIndex);
    event Claimed(address indexed user, uint256 indexed marketId, uint256 outcomeIndex, uint256 amount);
    event StakeExited(address indexed user, uint256 indexed marketId, uint256 outcomeIndex, uint256 netUsdcReturned);
    event TreasuryUpdated(address indexed treasury);
    /// @notice Owner sent USDC out of the contract while paused (support / stuck funds — use with care).
    event USDCRescued(address indexed to, uint256 amount);

    error BadMarket();
    error TradingClosed();
    error BadOutcome();
    error BadAmount();
    error FeeTooHigh();
    error NothingToClaim();
    error NoWinningStake();
    error NothingToExit();

    constructor(IERC20 _usdc, address _treasury) Ownable(msg.sender) {
        usdc = _usdc;
        treasury = _treasury;
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice No USDC from owner — only metadata. `marketId` must match off-chain DB id; `outcomeCount` = number of agents/outcomes.
    function registerMarket(uint256 marketId, uint64 closeTime, uint16 feeBps, uint8 outcomeCount)
        external
        onlyOwner
    {
        if (outcomeCount == 0 || outcomeCount > MAX_OUTCOMES) revert BadOutcome();
        if (markets[marketId].active) revert BadMarket();
        if (feeBps > 2_000) revert FeeTooHigh();

        markets[marketId] = Market({
            closeTime: closeTime,
            feeBps: feeBps,
            active: true,
            resolved: false,
            outcomeCount: outcomeCount,
            winningOutcome: type(uint256).max
        });

        emit MarketRegistered(marketId, closeTime, feeBps, outcomeCount);
    }

    /// @notice Stake USDC that this outcome (agent) wins. Protocol fee taken from gross; net enters the pool.
    function bet(uint256 marketId, uint256 outcomeIndex, uint256 grossUsdc)
        external
        nonReentrant
        whenNotPaused
    {
        Market storage m = markets[marketId];
        if (!m.active || m.resolved) revert BadMarket();
        if (block.timestamp >= m.closeTime) revert TradingClosed();
        if (outcomeIndex >= m.outcomeCount) revert BadOutcome();
        if (grossUsdc == 0) revert BadAmount();

        uint256 fee = Math.mulDiv(grossUsdc, m.feeBps, 10_000);
        uint256 net = grossUsdc - fee;

        usdc.safeTransferFrom(msg.sender, address(this), grossUsdc);
        if (fee > 0 && treasury != address(0)) {
            usdc.safeTransfer(treasury, fee);
        }

        stakeOf[marketId][outcomeIndex][msg.sender] += net;
        totalStakeOnOutcome[marketId][outcomeIndex] += net;
        totalPool[marketId] += net;

        emit BetPlaced(msg.sender, marketId, outcomeIndex, grossUsdc, fee, net);
    }

    /// @notice Withdraw your full net stake on an outcome before betting closes (USDC back to wallet). No extra fee.
    function exitStake(uint256 marketId, uint256 outcomeIndex) external nonReentrant whenNotPaused {
        Market storage m = markets[marketId];
        if (!m.active || m.resolved) revert BadMarket();
        if (block.timestamp >= m.closeTime) revert TradingClosed();
        if (outcomeIndex >= m.outcomeCount) revert BadOutcome();

        uint256 s = stakeOf[marketId][outcomeIndex][msg.sender];
        if (s == 0) revert NothingToExit();

        stakeOf[marketId][outcomeIndex][msg.sender] = 0;
        totalStakeOnOutcome[marketId][outcomeIndex] -= s;
        totalPool[marketId] -= s;

        usdc.safeTransfer(msg.sender, s);

        emit StakeExited(msg.sender, marketId, outcomeIndex, s);
    }

    /// @notice Lock resolution to winning outcome index (same ordering as DB `market_outcomes`).
    function resolveMarket(uint256 marketId, uint256 winningOutcomeIndex) external onlyOwner {
        Market storage m = markets[marketId];
        if (!m.active || m.resolved) revert BadMarket();
        if (winningOutcomeIndex >= m.outcomeCount) revert BadOutcome();

        uint256 P = totalPool[marketId];
        uint256 W = totalStakeOnOutcome[marketId][winningOutcomeIndex];
        if (W == 0) revert NoWinningStake();

        m.resolved = true;
        m.winningOutcome = winningOutcomeIndex;
        resolvedPoolSnapshot[marketId] = P;
        resolvedWinningStakeSnapshot[marketId] = W;

        emit MarketResolved(marketId, winningOutcomeIndex);
    }

    /// @notice Winners claim: payout = stake * snapshotPool / snapshotWinningStake (fixed at resolve).
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        if (!m.active || !m.resolved) revert BadMarket();

        uint256 w = m.winningOutcome;
        uint256 s = stakeOf[marketId][w][msg.sender];
        if (s == 0) revert NothingToClaim();

        uint256 P = resolvedPoolSnapshot[marketId];
        uint256 W = resolvedWinningStakeSnapshot[marketId];
        uint256 payout = Math.mulDiv(s, P, W);

        stakeOf[marketId][w][msg.sender] = 0;

        usdc.safeTransfer(msg.sender, payout);

        emit Claimed(msg.sender, marketId, w, payout);
    }

    /// @notice Emergency: while **paused**, owner can send USDC to a user (e.g. claim/UI failed, verified off-chain).
    /// @dev Pausing blocks new bets and exitStake; claim() still works unless you coordinate otherwise.
    ///      Misuse can drain user funds — use a multisig owner and document every rescue publicly.
    function rescueUSDC(address to, uint256 amount) external onlyOwner whenPaused nonReentrant {
        if (to == address(0) || amount == 0) revert BadAmount();
        usdc.safeTransfer(to, amount);
        emit USDCRescued(to, amount);
    }
}
