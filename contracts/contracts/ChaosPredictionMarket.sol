// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ChaosPredictionMarket
/// @notice CPMM per outcome (YES/NO virtual reserves, USDC 6 decimals). Matches backend `cpmmQuote` math.
/// @dev Register `marketId` / `outcomeCount` to mirror Postgres. Fee on gross reduces `net` into the curve for both sides; SELLS additionally take fee on proceeds (`feeOut`).
contract ChaosPredictionMarket is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public treasury;

    uint256 public constant SEED_RESERVE = 1_000e6;
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
    mapping(uint256 => mapping(uint256 => uint256)) public reserveYes;
    mapping(uint256 => mapping(uint256 => uint256)) public reserveNo;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public yesShares;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public noShares;

    event MarketRegistered(uint256 indexed marketId, uint64 closeTime, uint16 feeBps, uint8 outcomeCount);
    event Trade(
        address indexed user,
        uint256 indexed marketId,
        uint256 indexed outcomeIndex,
        uint8 side,
        uint256 grossUsdc,
        uint256 feeUsdc,
        uint256 netUsdc,
        int256 sharesDelta,
        uint256 usdcToUser
    );
    event MarketResolved(uint256 indexed marketId, uint256 winningOutcomeIndex);
    event TreasuryUpdated(address indexed treasury);

    error BadMarket();
    error TradingClosed();
    error BadSide();
    error BadAmount();
    error Slippage();
    error InsufficientShares();
    error BadOutcome();
    error FeeTooHigh();

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

    /// @notice Pulls seed liquidity from owner (approve this contract first).
    function registerMarket(uint256 marketId, uint64 closeTime, uint16 feeBps, uint8 outcomeCount) external onlyOwner {
        if (outcomeCount == 0 || outcomeCount > MAX_OUTCOMES) revert BadOutcome();
        if (markets[marketId].active) revert BadMarket();
        if (feeBps > 2_000) revert FeeTooHigh();

        uint256 need = SEED_RESERVE * 2 * uint256(outcomeCount);
        usdc.safeTransferFrom(msg.sender, address(this), need);

        markets[marketId] = Market({
            closeTime: closeTime,
            feeBps: feeBps,
            active: true,
            resolved: false,
            outcomeCount: outcomeCount,
            winningOutcome: type(uint256).max
        });

        for (uint256 i = 0; i < outcomeCount; i++) {
            reserveYes[marketId][i] = SEED_RESERVE;
            reserveNo[marketId][i] = SEED_RESERVE;
        }

        emit MarketRegistered(marketId, closeTime, feeBps, outcomeCount);
    }

    /// @notice side: 0=BUY_YES 1=BUY_NO 2=SELL_YES 3=SELL_NO (same as API). `minOut` = min shares out (buys) or min USDC out (sells).
    function trade(uint256 marketId, uint256 outcomeIndex, uint8 side, uint256 grossUsdc, uint256 minOut)
        external
        nonReentrant
        whenNotPaused
    {
        Market storage m = markets[marketId];
        if (!m.active || m.resolved) revert BadMarket();
        if (block.timestamp >= m.closeTime) revert TradingClosed();
        if (outcomeIndex >= m.outcomeCount) revert BadOutcome();
        if (grossUsdc == 0) revert BadAmount();
        if (side > 3) revert BadSide();

        uint256 fee = Math.mulDiv(grossUsdc, m.feeBps, 10_000);
        uint256 net = grossUsdc - fee;

        uint256 ry = reserveYes[marketId][outcomeIndex];
        uint256 rn = reserveNo[marketId][outcomeIndex];

        uint256 newRy;
        uint256 newRn;
        int256 sharesDelta;

        if (side < 2) {
            usdc.safeTransferFrom(msg.sender, address(this), grossUsdc);
            if (fee > 0 && treasury != address(0)) {
                usdc.safeTransfer(treasury, fee);
            }
            (newRy, newRn, sharesDelta) = _cpmm(ry, rn, side, net);
            uint256 sharesOut = sharesDelta >= 0 ? uint256(sharesDelta) : uint256(-sharesDelta);
            if (sharesOut < minOut) revert Slippage();
        } else {
            (newRy, newRn, sharesDelta) = _cpmm(ry, rn, side, net);
            uint256 usdcOutGross = _usdcOutFromSell(ry, rn, side, net);
            uint256 feeOut = Math.mulDiv(usdcOutGross, m.feeBps, 10_000);
            uint256 usdcToUser = usdcOutGross - feeOut;
            if (usdcToUser < minOut) revert Slippage();

            reserveYes[marketId][outcomeIndex] = newRy;
            reserveNo[marketId][outcomeIndex] = newRn;
            _applyShares(marketId, outcomeIndex, side, sharesDelta);

            if (feeOut > 0 && treasury != address(0)) {
                usdc.safeTransfer(treasury, feeOut);
            }
            usdc.safeTransfer(msg.sender, usdcToUser);
            emit Trade(msg.sender, marketId, outcomeIndex, side, grossUsdc, feeOut, net, sharesDelta, usdcToUser);
            return;
        }

        reserveYes[marketId][outcomeIndex] = newRy;
        reserveNo[marketId][outcomeIndex] = newRn;
        _applyShares(marketId, outcomeIndex, side, sharesDelta);
        emit Trade(msg.sender, marketId, outcomeIndex, side, grossUsdc, fee, net, sharesDelta, 0);
    }

    /// @dev Mirrors `cpmmQuote` in services/predictionMarketService.js
    function _cpmm(uint256 reserveYes_, uint256 reserveNo_, uint8 side, uint256 net)
        internal
        pure
        returns (uint256 newRy, uint256 newRn, int256 sharesDelta)
    {
        uint256 k = reserveYes_ * reserveNo_;
        if (side == 0) {
            uint256 newYes = reserveYes_ + net;
            uint256 newNo = Math.mulDiv(k, 1, newYes);
            return (newYes, newNo, int256(reserveNo_ - newNo));
        }
        if (side == 1) {
            uint256 newNo = reserveNo_ + net;
            uint256 newYes = Math.mulDiv(k, 1, newNo);
            return (newYes, newNo, int256(reserveYes_ - newYes));
        }
        if (side == 2) {
            if (net >= reserveYes_) revert BadAmount();
            uint256 newYes = reserveYes_ - net;
            uint256 newNo = Math.mulDiv(k, 1, newYes);
            return (newYes, newNo, -int256(newNo - reserveNo_));
        }
        if (side == 3) {
            if (net >= reserveNo_) revert BadAmount();
            uint256 newNo = reserveNo_ - net;
            uint256 newYes = Math.mulDiv(k, 1, newNo);
            return (newYes, newNo, -int256(newYes - reserveYes_));
        }
        revert BadSide();
    }

    /// @notice USDC that leaves the curve to the seller before fee-on-out (geometric mean of reserve deltas).
    function _usdcOutFromSell(uint256 ry, uint256 rn, uint8 side, uint256 net) internal pure returns (uint256) {
        uint256 k = ry * rn;
        if (side == 2) {
            uint256 newYes = ry - net;
            uint256 newNo = Math.mulDiv(k, 1, newYes);
            return newNo - rn;
        }
        if (side == 3) {
            uint256 newNo = rn - net;
            uint256 newYes = Math.mulDiv(k, 1, newNo);
            return newYes - ry;
        }
        revert BadSide();
    }

    function _applyShares(uint256 marketId, uint256 outcomeIndex, uint8 side, int256 sharesDelta) internal {
        if (side == 0) {
            uint256 d = uint256(sharesDelta);
            yesShares[marketId][outcomeIndex][msg.sender] += d;
        } else if (side == 1) {
            uint256 d = uint256(sharesDelta);
            noShares[marketId][outcomeIndex][msg.sender] += d;
        } else if (side == 2) {
            uint256 need = uint256(-sharesDelta);
            if (yesShares[marketId][outcomeIndex][msg.sender] < need) revert InsufficientShares();
            yesShares[marketId][outcomeIndex][msg.sender] -= need;
        } else if (side == 3) {
            uint256 need = uint256(-sharesDelta);
            if (noShares[marketId][outcomeIndex][msg.sender] < need) revert InsufficientShares();
            noShares[marketId][outcomeIndex][msg.sender] -= need;
        }
    }

    function resolveMarket(uint256 marketId, uint256 winningOutcomeIndex) external onlyOwner {
        Market storage m = markets[marketId];
        if (!m.active || m.resolved) revert BadMarket();
        if (winningOutcomeIndex >= m.outcomeCount) revert BadOutcome();
        m.resolved = true;
        m.winningOutcome = winningOutcomeIndex;
        emit MarketResolved(marketId, winningOutcomeIndex);
    }

    /// @notice 1 share unit = 1 micro-USDC payout (same decimals as USDC).
    function claim(uint256 marketId, uint256 outcomeIndex) external nonReentrant {
        Market storage m = markets[marketId];
        if (!m.resolved) revert BadMarket();
        if (outcomeIndex != m.winningOutcome) revert BadOutcome();

        uint256 sh = yesShares[marketId][outcomeIndex][msg.sender];
        if (sh == 0) revert InsufficientShares();

        yesShares[marketId][outcomeIndex][msg.sender] = 0;
        usdc.safeTransfer(msg.sender, sh);
    }
}
