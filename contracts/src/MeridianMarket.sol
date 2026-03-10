// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import "./libraries/OrderBookLib.sol";
import "./libraries/PriceLib.sol";

/// @title MeridianMarket
/// @notice Binary option market contract. Each market is a (ticker, strike, expiry) triple.
///         Yes wins if closing price >= strike; No wins otherwise.
///         1 USDC collateral per pair. Protocol fee deducted from winning redemptions.
///         On-chain CLOB for Yes token trading (BID = buy Yes, ASK = sell Yes).
contract MeridianMarket is ERC1155, AccessControl, Pausable, ReentrancyGuard {
    using OrderBookLib for OrderBookLib.Book;
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────────

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────────

    uint16 public constant MAX_FEE_BPS = 200;
    uint64 public constant ADMIN_OVERRIDE_DELAY = 900;
    uint64 public constant MAX_PARSE_WINDOW = 900; // 15 minutes

    // ── External dependencies ──────────────────────────────────────────────────

    IPyth public pyth;
    IERC20 public usdc;
    address public feeRecipient;

    // ── Protocol configuration ─────────────────────────────────────────────────

    uint16 public feeBps;
    uint16 public maxConfBps = 100; // default: 1% confidence tolerance

    // ── Ticker / feed allowlist ────────────────────────────────────────────────

    mapping(bytes32 ticker => bytes32 feedId) public supportedFeeds;
    mapping(bytes32 ticker => bool enabled) public supportedTickers;

    // ── Market state ───────────────────────────────────────────────────────────

    struct Market {
        bytes32 ticker;
        int64 strikePrice; // Pyth native int64, expo -5
        bytes32 pythFeedId;
        uint64 expiryTimestamp;
        uint256 totalPairsMinted;
        uint256 vaultBalance; // USDC locked for this market (in 6-decimal units)
        uint16 feeBpsSnapshot; // feeBps at market creation time
        bool settled;
        bool yesWins;
    }

    mapping(bytes32 marketId => Market) public markets;

    /// @notice Append-only list of all created market IDs, in creation order.
    ///         Use marketCount() + getMarkets() for paginated frontend discovery.
    bytes32[] public allMarketIds;

    // ── ERC1155 token ID reverse mappings (for O(1) uri() lookups) ────────────

    mapping(uint256 tokenId => bytes32 marketId) public tokenIdToMarket;
    mapping(uint256 tokenId => bool isYes) public tokenIdIsYes;

    // ── Order book state ───────────────────────────────────────────────────────

    mapping(bytes32 marketId => OrderBookLib.Book) internal orderBooks;

    // Per-order metadata for cancel authorization and collateral refunds
    mapping(uint256 orderId => bytes32 marketId) public orderMarket;
    mapping(uint256 orderId => address owner) public orderOwner;
    mapping(uint256 orderId => OrderBookLib.Side) public orderSide;
    mapping(uint256 orderId => uint8 priceCents) public orderPriceCents;


    // ── Errors ─────────────────────────────────────────────────────────────────

    error UnsupportedTicker(bytes32 ticker);
    error MarketExists(bytes32 marketId);
    error MarketNotFound(bytes32 marketId);
    error MarketNotExpired(bytes32 marketId);
    error MarketExpired(bytes32 marketId);
    error MarketNotSettled(bytes32 marketId);
    error AlreadySettled(bytes32 marketId);
    error InvalidSettlementWindow();
    error WindowTooWide();
    error FeeTooHigh(uint16 bps);
    error OrderNotOwned(uint256 orderId);
    error ZeroQuantity();
    error UnknownTokenId(uint256 tokenId);
    error InsufficientProceed(uint128 got, uint128 minExpected);

    // ── Events ─────────────────────────────────────────────────────────────────

    event MarketCreated(
        bytes32 indexed marketId,
        bytes32 indexed ticker,
        int64 strikePrice,
        uint64 expiryTimestamp,
        bytes32 pythFeedId
    );
    event PairMinted(bytes32 indexed marketId, address indexed user, uint256 quantity);
    event OrderPlaced(
        bytes32 indexed marketId,
        uint256 indexed orderId,
        address indexed owner,
        OrderBookLib.Side side,
        uint8 priceCents,
        uint128 quantity
    );
    event OrderCancelled(uint256 indexed orderId, address indexed owner, uint128 remainingQty);
    event OrderFilled(
        bytes32 indexed marketId,
        uint256 indexed orderId,
        address indexed maker,
        address taker,
        uint8 side,
        uint8 priceCents,
        uint128 qty
    );
    event MarketSettled(bytes32 indexed marketId, bool yesWins, int64 settlePrice, uint256 publishTime);
    event AdminSettled(bytes32 indexed marketId, bool yesWins, int64 manualPrice);
    event Redeemed(bytes32 indexed marketId, address indexed user, uint256 quantity, uint256 payout);
    event FeeUpdated(uint16 oldBps, uint16 newBps);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event SupportedFeedSet(bytes32 indexed ticker, bytes32 feedId, bool enabled);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _oracle,
        address _usdc,
        address _feeRecipient,
        uint16 _feeBps
    ) ERC1155("") {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh(_feeBps);

        pyth = IPyth(_oracle);
        usdc = IERC20(_usdc);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ── Ticker/feed governance ─────────────────────────────────────────────────

    function setSupportedFeed(
        bytes32 ticker,
        bytes32 feedId,
        bool enabled
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        supportedTickers[ticker] = enabled;
        supportedFeeds[ticker] = feedId;
        emit SupportedFeedSet(ticker, feedId, enabled);
    }

    // ── Market creation ────────────────────────────────────────────────────────

    function createStrikeMarket(
        bytes32 ticker,
        int64 strikePrice,
        uint64 expiryTimestamp
    ) external onlyRole(OPERATOR_ROLE) returns (bytes32) {
        return _createMarket(ticker, strikePrice, expiryTimestamp);
    }

    function addStrike(
        bytes32 ticker,
        int64 strikePrice,
        uint64 expiryTimestamp
    ) external onlyRole(OPERATOR_ROLE) returns (bytes32) {
        return _createMarket(ticker, strikePrice, expiryTimestamp);
    }

    function _createMarket(
        bytes32 ticker,
        int64 strikePrice,
        uint64 expiryTimestamp
    ) internal returns (bytes32 marketId) {
        if (!supportedTickers[ticker]) revert UnsupportedTicker(ticker);

        marketId = keccak256(abi.encode(ticker, strikePrice, expiryTimestamp));
        if (markets[marketId].expiryTimestamp != 0) revert MarketExists(marketId);

        markets[marketId] = Market({
            ticker: ticker,
            strikePrice: strikePrice,
            pythFeedId: supportedFeeds[ticker],
            expiryTimestamp: expiryTimestamp,
            totalPairsMinted: 0,
            vaultBalance: 0,
            feeBpsSnapshot: feeBps,
            settled: false,
            yesWins: false
        });

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));
        tokenIdToMarket[yesId] = marketId;
        tokenIdToMarket[noId] = marketId;
        tokenIdIsYes[yesId] = true;
        // tokenIdIsYes[noId] defaults to false

        allMarketIds.push(marketId);

        emit MarketCreated(marketId, ticker, strikePrice, expiryTimestamp, supportedFeeds[ticker]);
    }

    // ── Mint pair ──────────────────────────────────────────────────────────────

    /// @notice Mint `quantity` Yes tokens + `quantity` No tokens by depositing `quantity` USDC.
    function mintPair(bytes32 marketId, uint128 quantity) external whenNotPaused nonReentrant {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (block.timestamp >= m.expiryTimestamp) revert MarketExpired(marketId);
        if (quantity == 0) revert ZeroQuantity();

        uint256 usdcAmount = uint256(quantity) * 1e6;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        m.vaultBalance += usdcAmount;
        m.totalPairsMinted += quantity;

        _mint(msg.sender, uint256(marketId), quantity, "");
        _mint(msg.sender, uint256(keccak256(abi.encode(marketId, "NO"))), quantity, "");

        emit PairMinted(marketId, msg.sender, quantity);
    }

    // ── Order placement ────────────────────────────────────────────────────────

    /// @notice Place a limit order. Immediately crosses resting orders where possible.
    ///         Unfilled remainder is posted as a resting limit unless isIOC = true.
    function placeOrder(
        bytes32 marketId,
        OrderBookLib.Side side,
        uint8 priceCents,
        uint128 quantity,
        bool isIOC
    ) external whenNotPaused nonReentrant returns (uint256 orderId) {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (block.timestamp >= m.expiryTimestamp) revert MarketExpired(marketId);
        if (quantity == 0) revert ZeroQuantity();

        // Lock collateral upfront (full quantity, pre-fill)
        if (side == OrderBookLib.Side.BID) {
            uint256 lockUsdc = uint256(quantity) * uint256(priceCents) * 1e4;
            usdc.safeTransferFrom(msg.sender, address(this), lockUsdc);
            m.vaultBalance += lockUsdc;
        } else {
            _safeTransferFrom(msg.sender, address(this), uint256(marketId), quantity, "");
        }

        // Cross with resting orders
        OrderBookLib.FillResult memory fr = orderBooks[marketId].matchLimit(
            side, priceCents, quantity, msg.sender
        );

        // Process per-fill settlements (pay each maker, deliver assets to taker)
        _processFills(marketId, side, fr, msg.sender);

        // Refund excess collateral if taker overpaid (BID: paid full price, may have gotten lower ask)
        if (side == OrderBookLib.Side.BID && fr.filledQty > 0) {
            uint256 paidUsdc = uint256(fr.filledQty) * uint256(priceCents) * 1e4;
            uint256 actualCostUsdc = uint256(fr.usdcTradedCents) * 1e4;
            if (paidUsdc > actualCostUsdc) {
                uint256 overPaid = paidUsdc - actualCostUsdc;
                m.vaultBalance -= overPaid;
                usdc.safeTransfer(msg.sender, overPaid);
            }
        }

        uint128 remainder = fr.remainderQty;
        if (remainder > 0) {
            if (isIOC) {
                _refundCollateral(marketId, m, side, remainder, priceCents, msg.sender);
            } else {
                orderId = _insertOrder(marketId, side, priceCents, remainder, msg.sender);
            }
        }
    }

    // ── Order cancellation ─────────────────────────────────────────────────────

    function cancelOrder(uint256 orderId) external nonReentrant {
        if (orderOwner[orderId] != msg.sender) revert OrderNotOwned(orderId);
        _cancelOrder(orderId, msg.sender);
    }

    function bulkCancelOrders(uint256[] calldata orderIds) external nonReentrant {
        uint256 len = orderIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (orderOwner[orderIds[i]] != msg.sender) continue;
            _cancelOrder(orderIds[i], msg.sender);
        }
    }

    function _cancelOrder(uint256 orderId, address owner) internal {
        bytes32 mid = orderMarket[orderId];
        OrderBookLib.Side side = orderSide[orderId];
        uint8 price = orderPriceCents[orderId];

        uint128 remaining = orderBooks[mid].remainingOf(orderId);
        orderBooks[mid].remove(orderId);

        Market storage m = markets[mid];
        _refundCollateral(mid, m, side, remaining, price, owner);

        _cleanOrderMeta(orderId);
        emit OrderCancelled(orderId, owner, remaining);
    }

    // ── Atomic Buy No (market) ─────────────────────────────────────────────────

    /// @notice Mint `quantity` pairs, immediately sell all Yes at market, keep all No.
    /// @param quantity            Number of pairs to mint (and No tokens to acquire).
    /// @param minYesSaleProceeds  Minimum total USDC proceeds in cents across all Yes sales.
    function buyNoMarket(
        bytes32 marketId,
        uint128 quantity,
        uint128 minYesSaleProceeds,
        uint8 maxFills
    ) external whenNotPaused nonReentrant {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (block.timestamp >= m.expiryTimestamp) revert MarketExpired(marketId);
        if (quantity == 0) revert ZeroQuantity();

        uint256 usdcAmount = uint256(quantity) * 1e6;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        m.vaultBalance += usdcAmount;
        m.totalPairsMinted += quantity;

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        // Mint Yes to this contract (to sell) and No to caller (to keep)
        _mint(address(this), yesId, quantity, "");
        _mint(msg.sender, noId, quantity, "");

        // Sell all Yes at market (contract is the ASK taker)
        OrderBookLib.FillResult memory fr = orderBooks[marketId].matchMarket(
            OrderBookLib.Side.ASK, quantity, maxFills, true, msg.sender, 0
        );

        if (fr.usdcTradedCents < minYesSaleProceeds) {
            revert InsufficientProceed(fr.usdcTradedCents, minYesSaleProceeds);
        }

        // Pay BID makers their Yes tokens (from this contract's balance)
        uint8 fillCount = fr.fillCount;
        for (uint8 i = 0; i < fillCount; i++) {
            emit OrderFilled(
                marketId,
                fr.fills[i].orderId,
                fr.fills[i].maker,
                msg.sender,
                uint8(OrderBookLib.Side.ASK), // taker is selling Yes (ASK direction)
                fr.fills[i].priceCents,
                fr.fills[i].qty
            );
            _safeTransferFrom(address(this), fr.fills[i].maker, yesId, fr.fills[i].qty, "");
            uint256 makerUsdc = uint256(fr.fills[i].qty) * uint256(fr.fills[i].priceCents) * 1e4;
            m.vaultBalance -= makerUsdc;
        }

        // Pay caller proceeds from the Yes sales
        uint256 proceeds = uint256(fr.usdcTradedCents) * 1e4;
        usdc.safeTransfer(msg.sender, proceeds);

        // Burn any unfilled Yes (IOC: remainder is discarded) and refund 1 USDC per unfilled token
        uint128 unfilledYes = quantity - fr.filledQty;
        if (unfilledYes > 0) {
            _burn(address(this), yesId, unfilledYes);
            uint256 refund = uint256(unfilledYes) * 1e6;
            m.vaultBalance -= refund;
            usdc.safeTransfer(msg.sender, refund);
        }
    }

    /// @notice Mint `quantity` pairs, post all Yes as a single resting limit sell, keep all No.
    /// @param quantity          Number of pairs to mint (and No tokens to acquire).
    /// @param limitYesSalePrice Limit price in cents at which to post the Yes ASK order.
    function buyNoLimit(bytes32 marketId, uint128 quantity, uint8 limitYesSalePrice) external whenNotPaused nonReentrant {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (block.timestamp >= m.expiryTimestamp) revert MarketExpired(marketId);
        if (quantity == 0) revert ZeroQuantity();

        uint256 usdcAmount = uint256(quantity) * 1e6;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        m.vaultBalance += usdcAmount;
        m.totalPairsMinted += quantity;

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        // Mint Yes to this contract (locked as ASK collateral) and No to caller
        _mint(address(this), yesId, quantity, "");
        _mint(msg.sender, noId, quantity, "");

        // Post all Yes as a single resting ASK limit order on behalf of caller
        _insertOrder(marketId, OrderBookLib.Side.ASK, limitYesSalePrice, quantity, msg.sender);
    }

    // ── Atomic Sell No (market) ────────────────────────────────────────────────

    /// @notice Buy Yes at market, then immediately redeem Yes+No for $1 USDC.
    function sellNoMarket(
        bytes32 marketId,
        uint128 noAmount,
        uint8 maxYesBuyPrice,
        uint8 maxFills
    ) external whenNotPaused nonReentrant {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (block.timestamp >= m.expiryTimestamp) revert MarketExpired(marketId);
        if (noAmount == 0) revert ZeroQuantity();

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        // Transfer caller's No tokens to this contract for the pair redemption
        _safeTransferFrom(msg.sender, address(this), noId, noAmount, "");

        // Lock max USDC for the Yes purchase
        uint256 maxUsdc = uint256(noAmount) * uint256(maxYesBuyPrice) * 1e4;
        usdc.safeTransferFrom(msg.sender, address(this), maxUsdc);
        m.vaultBalance += maxUsdc;

        // Buy Yes at market (BID side, contract is taker)
        OrderBookLib.FillResult memory fr = orderBooks[marketId].matchMarket(
            OrderBookLib.Side.BID, noAmount, maxFills, true, msg.sender, 0
        );

        // Pay ASK makers (USDC from vault)
        for (uint8 i = 0; i < fr.fillCount; i++) {
            emit OrderFilled(
                marketId,
                fr.fills[i].orderId,
                fr.fills[i].maker,
                msg.sender,
                uint8(OrderBookLib.Side.BID), // taker is buying Yes (BID direction)
                fr.fills[i].priceCents,
                fr.fills[i].qty
            );
            uint256 makerUsdc = uint256(fr.fills[i].qty) * uint256(fr.fills[i].priceCents) * 1e4;
            usdc.safeTransfer(fr.fills[i].maker, makerUsdc);
            m.vaultBalance -= makerUsdc;
            // Transfer Yes tokens from ASK maker (locked in contract) to this contract
            // (ASK makers' Yes tokens were locked in contract at placeOrder time)
        }

        // Refund unused USDC to caller
        uint256 actualCostUsdc = uint256(fr.usdcTradedCents) * 1e4;
        uint256 refund = maxUsdc - actualCostUsdc;
        if (refund > 0) {
            m.vaultBalance -= refund;
            usdc.safeTransfer(msg.sender, refund);
        }

        // Redeem Yes+No pairs for $1 each (internal pair cancellation, no fee at pre-settlement)
        if (fr.filledQty > 0) {
            uint256 grossPayout = uint256(fr.filledQty) * 1e6;
            _burn(address(this), yesId, fr.filledQty);
            _burn(address(this), noId, fr.filledQty);
            m.totalPairsMinted -= fr.filledQty;
            m.vaultBalance -= grossPayout;
            usdc.safeTransfer(msg.sender, grossPayout);
        }

        // Return unfilled No tokens to caller
        uint128 unfilledNo = noAmount - fr.filledQty;
        if (unfilledNo > 0) {
            _safeTransferFrom(address(this), msg.sender, noId, unfilledNo, "");
        }
    }

    // ── Settlement ─────────────────────────────────────────────────────────────

    /// @notice Settle a market using a Pyth price update.
    function settleMarket(
        bytes32 marketId,
        bytes[] calldata priceUpdate,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable onlyRole(SETTLER_ROLE) nonReentrant {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (m.settled) revert AlreadySettled(marketId);
        if (block.timestamp < m.expiryTimestamp) revert MarketNotExpired(marketId);
        if (minPublishTime > m.expiryTimestamp || maxPublishTime < m.expiryTimestamp) {
            revert InvalidSettlementWindow();
        }
        if (maxPublishTime - minPublishTime > MAX_PARSE_WINDOW) revert WindowTooWide();

        uint256 fee = pyth.getUpdateFee(priceUpdate);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = m.pythFeedId;

        PythStructs.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdates{value: fee}(priceUpdate, ids, minPublishTime, maxPublishTime);

        bool yesWins = PriceLib.validateAndCompare(feeds[0].price, m.strikePrice, maxConfBps);

        m.settled = true;
        m.yesWins = yesWins;

        emit MarketSettled(marketId, yesWins, feeds[0].price.price, feeds[0].price.publishTime);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "ETH refund failed");
        }
    }

    /// @notice Emergency settlement with a manually provided price.
    ///         Only callable by DEFAULT_ADMIN_ROLE after expiryTimestamp + ADMIN_OVERRIDE_DELAY.
    function adminSettleOverride(
        bytes32 marketId,
        int64 manualPrice
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Market storage m = markets[marketId];
        if (m.expiryTimestamp == 0) revert MarketNotFound(marketId);
        if (m.settled) revert AlreadySettled(marketId);
        if (block.timestamp < m.expiryTimestamp + ADMIN_OVERRIDE_DELAY) revert MarketNotExpired(marketId);

        bool yesWins = manualPrice >= m.strikePrice;
        m.settled = true;
        m.yesWins = yesWins;

        emit AdminSettled(marketId, yesWins, manualPrice);
    }

    // ── Redemption ─────────────────────────────────────────────────────────────

    /// @notice Redeem settled tokens for USDC.
    ///         Winners receive `1e6 - fee` per token. Losers may also redeem for 0 (to burn worthless tokens).
    ///         If the caller holds both sides, the winning token is redeemed first.
    function redeem(bytes32 marketId, uint256 quantity) external nonReentrant {
        Market storage m = markets[marketId];
        if (!m.settled) revert MarketNotSettled(marketId);
        if (quantity == 0) revert ZeroQuantity();

        uint256 yesId = uint256(marketId);
        uint256 noId = uint256(keccak256(abi.encode(marketId, "NO")));

        bool holdsYes = balanceOf(msg.sender, yesId) >= quantity;
        bool holdsNo = balanceOf(msg.sender, noId) >= quantity;

        uint256 tokenId;
        bool isWinning;

        if (m.yesWins) {
            if (holdsYes) {
                tokenId = yesId;
                isWinning = true;
            } else if (holdsNo) {
                tokenId = noId;
                isWinning = false;
            } else {
                revert("Insufficient tokens");
            }
        } else {
            if (holdsNo) {
                tokenId = noId;
                isWinning = true;
            } else if (holdsYes) {
                tokenId = yesId;
                isWinning = false;
            } else {
                revert("Insufficient tokens");
            }
        }

        _burn(msg.sender, tokenId, quantity);

        uint256 payout = 0;
        if (isWinning) {
            uint256 gross = quantity * 1e6;
            uint256 feeAmt = (gross * m.feeBpsSnapshot) / 10_000;
            payout = gross - feeAmt;
            m.vaultBalance -= gross;
            usdc.safeTransfer(msg.sender, payout);
            usdc.safeTransfer(feeRecipient, feeAmt);
        }

        emit Redeemed(marketId, msg.sender, quantity, payout);
    }


    // ── Admin configuration ────────────────────────────────────────────────────

    function setFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        emit FeeUpdated(feeBps, bps);
        feeBps = bps;
    }

    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit FeeRecipientUpdated(feeRecipient, recipient);
        feeRecipient = recipient;
    }

    function setOracle(address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        pyth = IPyth(oracle);
    }

    function setMaxConfBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxConfBps = bps;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ── Market discovery ──────────────────────────────────────────────────────

    /// @notice A flattened view of a market's key fields, returned by getMarkets().
    struct MarketView {
        bytes32 marketId;   // cast to uint256 for the Yes token ID
        bytes32 ticker;
        int64   strikePrice;
        uint64  expiryTimestamp;
        bool    settled;
        bool    yesWins;
        uint256 vaultBalance;
        uint16  feeBpsSnapshot;
    }

    /// @notice Total number of markets ever created (never decreases).
    function marketCount() external view returns (uint256) {
        return allMarketIds.length;
    }

    /// @notice Return the `count` most recently created markets, newest last.
    ///         If `count` exceeds the total number of markets, all markets are returned.
    ///         Typical call: getMarkets(490) — last 7 stocks × 7 strikes × 10 days.
    function getMarkets(uint256 count) external view returns (MarketView[] memory result) {
        uint256 total = allMarketIds.length;
        if (total == 0 || count == 0) return result;

        uint256 size = count < total ? count : total;
        uint256 start = total - size;

        result = new MarketView[](size);
        for (uint256 i = 0; i < size; i++) {
            bytes32 mId = allMarketIds[start + i];
            Market storage m = markets[mId];
            result[i] = MarketView({
                marketId:       mId,
                ticker:         m.ticker,
                strikePrice:    m.strikePrice,
                expiryTimestamp: m.expiryTimestamp,
                settled:        m.settled,
                yesWins:        m.yesWins,
                vaultBalance:   m.vaultBalance,
                feeBpsSnapshot: m.feeBpsSnapshot
            });
        }
    }

    // ── ERC1155 metadata (fully on-chain) ──────────────────────────────────────

    function uri(uint256 id) public view override returns (string memory) {
        bytes32 mId = tokenIdToMarket[id];
        if (mId == bytes32(0)) revert UnknownTokenId(id);
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(_buildJson(mId, tokenIdIsYes[id])))
        );
    }

    function _buildJson(bytes32 mId, bool isYes) internal view returns (string memory) {
        Market storage m = markets[mId];
        string memory ticker = _bytes32ToString(m.ticker);
        string memory strike = PriceLib.toDisplayString(m.strikePrice);
        string memory expiry = Strings.toString(m.expiryTimestamp);
        string memory ttype = isYes ? "YES" : "NO";
        string memory outcome = !m.settled ? "Pending" : (m.yesWins ? "YES WINS" : "NO WINS");

        string memory nameDesc = _buildNameDesc(ticker, strike, expiry, ttype);
        string memory attrs = _buildAttrs(ticker, strike, expiry, ttype, m.settled, outcome);
        return string.concat(nameDesc, attrs, "]}");
    }

    function _buildNameDesc(
        string memory ticker,
        string memory strike,
        string memory expiry,
        string memory ttype
    ) internal pure returns (string memory) {
        return string.concat(
            '{"name":"', ticker, " ", ttype, " > $", strike,
            '","description":"Meridian: Will ', ticker,
            " close at or above $", strike, " on ", expiry, '?","attributes":['
        );
    }

    function _buildAttrs(
        string memory ticker,
        string memory strike,
        string memory expiry,
        string memory ttype,
        bool settled,
        string memory outcome
    ) internal pure returns (string memory) {
        string memory status = settled ? "Settled" : "Active";
        return string.concat(
            '{"trait_type":"Ticker","value":"', ticker, '"},',
            '{"trait_type":"Token Type","value":"', ttype, '"},',
            '{"trait_type":"Strike","value":"$', strike, '"},',
            '{"trait_type":"Expiry","value":"', expiry, '"},',
            '{"trait_type":"Status","value":"', status, '"},',
            '{"trait_type":"Outcome","value":"', outcome, '"}'
        );
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    function _insertOrder(
        bytes32 marketId,
        OrderBookLib.Side side,
        uint8 priceCents,
        uint128 quantity,
        address owner
    ) internal returns (uint256 orderId) {
        orderId = orderBooks[marketId].insert(side, priceCents, quantity, owner);
        orderMarket[orderId] = marketId;
        orderOwner[orderId] = owner;
        orderSide[orderId] = side;
        orderPriceCents[orderId] = priceCents;
        emit OrderPlaced(marketId, orderId, owner, side, priceCents, quantity);
    }

    function _cleanOrderMeta(uint256 orderId) internal {
        delete orderMarket[orderId];
        delete orderOwner[orderId];
        delete orderSide[orderId];
        delete orderPriceCents[orderId];
    }

    /// @dev Settle collateral exchanges for each fill produced by matchLimit / matchMarket.
    ///      `takerSide` is the side of the taker; makers are on the opposite side.
    function _processFills(
        bytes32 marketId,
        OrderBookLib.Side takerSide,
        OrderBookLib.FillResult memory fr,
        address taker
    ) internal {
        if (fr.fillCount == 0) return;

        Market storage m = markets[marketId];
        uint256 yesId = uint256(marketId);

        for (uint8 i = 0; i < fr.fillCount; i++) {
            OrderBookLib.Fill memory f = fr.fills[i];
            uint256 usdcAmt = uint256(f.qty) * uint256(f.priceCents) * 1e4;

            emit OrderFilled(marketId, f.orderId, f.maker, taker, uint8(takerSide), f.priceCents, f.qty);

            if (takerSide == OrderBookLib.Side.BID) {
                // Taker (buyer) locked USDC; maker (seller) locked Yes tokens.
                // → Transfer Yes from contract (maker's locked stock) to taker.
                // → Transfer USDC (from taker's lock) to maker.
                _safeTransferFrom(address(this), taker, yesId, f.qty, "");
                usdc.safeTransfer(f.maker, usdcAmt);
                m.vaultBalance -= usdcAmt;
                // Clean maker order metadata (already removed from book by matchLimit)
                _cleanOrderMetaIfExists(f.orderId);
            } else {
                // Taker (seller) locked Yes tokens; maker (buyer) locked USDC.
                // → Transfer Yes from contract (taker's locked stock) to maker.
                // → Transfer USDC (from maker's lock) to taker.
                _safeTransferFrom(address(this), f.maker, yesId, f.qty, "");
                usdc.safeTransfer(taker, usdcAmt);
                m.vaultBalance -= usdcAmt;
                _cleanOrderMetaIfExists(f.orderId);
            }
        }
    }

    function _cleanOrderMetaIfExists(uint256 orderId) internal {
        if (orderOwner[orderId] != address(0)) {
            _cleanOrderMeta(orderId);
        }
    }

    function _refundCollateral(
        bytes32 marketId,
        Market storage m,
        OrderBookLib.Side side,
        uint128 qty,
        uint8 priceCents,
        address recipient
    ) internal {
        if (side == OrderBookLib.Side.BID) {
            uint256 refund = uint256(qty) * uint256(priceCents) * 1e4;
            m.vaultBalance -= refund;
            usdc.safeTransfer(recipient, refund);
        } else {
            _safeTransferFrom(address(this), recipient, uint256(marketId), qty, "");
        }
    }

    function _bytes32ToString(bytes32 b) internal pure returns (string memory) {
        uint256 len = 0;
        for (uint256 i = 0; i < 32; i++) {
            if (b[i] != 0) len = i + 1;
        }
        bytes memory result = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = b[i];
        }
        return string(result);
    }

    // ── View helpers ───────────────────────────────────────────────────────────

    function yesTokenId(bytes32 marketId) external pure returns (uint256) {
        return uint256(marketId);
    }

    function noTokenId(bytes32 marketId) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(marketId, "NO")));
    }

    function bestBid(bytes32 marketId) external view returns (uint8) {
        return orderBooks[marketId].bestBid();
    }

    function bestAsk(bytes32 marketId) external view returns (uint8) {
        return orderBooks[marketId].bestAsk();
    }

    function depthAt(bytes32 marketId, OrderBookLib.Side side, uint8 priceCents)
        external view returns (uint128)
    {
        return orderBooks[marketId].depthAt(side, priceCents);
    }

    // ── ERC1155 receiver (self-custody of locked tokens) ───────────────────────

    /// @dev Allows the contract to receive its own ERC1155 tokens (ASK order collateral).
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external pure returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    // ── ERC1155 / ERC165 overrides ─────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId)
            || interfaceId == type(IERC1155Receiver).interfaceId;
    }

    receive() external payable {}
}
