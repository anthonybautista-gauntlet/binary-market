// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OrderBookLib
/// @notice On-chain Central Limit Order Book (CLOB) library for binary option Yes tokens.
/// Prices are in whole cents (1–99), representing $0.01–$0.99 per Yes token.
/// Each price level maintains a FIFO doubly-linked list of resting orders (price-time priority).
library OrderBookLib {
    uint8 internal constant MAX_PRICE_LEVELS = 99;
    uint8 internal constant HARD_MAX_FILLS = 100;

    // ── Errors ────────────────────────────────────────────────────────────────

    error InvalidPrice(uint8 priceCents);
    error InvalidQuantity();
    error OrderNotFound(uint256 orderId);
    error NoLiquidity();
    error SelfTradeNotAllowed();

    // ── Types ─────────────────────────────────────────────────────────────────

    enum Side {
        BID,
        ASK
    }

    struct Order {
        address owner;
        uint128 remainingQty; // whole Yes tokens
        uint8 priceCents; // 1–99
        Side side;
        uint256 prevId; // 0 = head sentinel
        uint256 nextId; // 0 = tail sentinel
    }

    struct PriceLevel {
        uint256 headId; // first order (0 = empty)
        uint256 tailId; // last order (0 = empty)
        uint128 totalQty; // sum of remainingQty at this level
    }

    /// @notice A single execution between a taker and a resting maker order.
    struct Fill {
        uint256 orderId; // maker order ID
        address maker; // maker address
        uint128 qty; // tokens exchanged
        uint8 priceCents; // price at which fill occurred
    }

    struct FillResult {
        Fill[100] fills; // per-fill details (bounded by HARD_MAX_FILLS)
        uint8 fillCount; // number of fills that occurred
        uint128 filledQty; // total Yes tokens moved
        uint128 usdcTradedCents; // total USDC in cents (filledQty * price per fill)
        uint8 worstFillPrice; // last price level touched (cents)
        uint128 remainderQty; // quantity not filled
        bool fullyFilled;
    }

    struct Book {
        mapping(uint256 orderId => Order) orders;
        PriceLevel[99] bids; // index 0 = $0.01
        PriceLevel[99] asks; // index 0 = $0.01
        uint256 nextOrderId; // auto-increment; 0 reserved as null
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _levelIndex(uint8 priceCents) private pure returns (uint8) {
        return priceCents - 1;
    }

    function _appendToLevel(Book storage book, PriceLevel storage level, uint256 orderId) private {
        if (level.tailId == 0) {
            level.headId = orderId;
            level.tailId = orderId;
            book.orders[orderId].prevId = 0;
            book.orders[orderId].nextId = 0;
        } else {
            book.orders[level.tailId].nextId = orderId;
            book.orders[orderId].prevId = level.tailId;
            book.orders[orderId].nextId = 0;
            level.tailId = orderId;
        }
    }

    function _removeFromLevel(Book storage book, PriceLevel storage level, uint256 orderId) private {
        Order storage o = book.orders[orderId];
        uint256 prev = o.prevId;
        uint256 next = o.nextId;

        if (prev == 0) {
            level.headId = next;
        } else {
            book.orders[prev].nextId = next;
        }

        if (next == 0) {
            level.tailId = prev;
        } else {
            book.orders[next].prevId = prev;
        }

        o.prevId = 0;
        o.nextId = 0;
    }

    /// @dev Execute one fill against a resting order. Modifies book state and populates result.
    function _executeFill(
        Book storage book,
        uint256 currentId,
        PriceLevel storage level,
        uint128 remaining,
        uint8 price,
        FillResult memory result
    ) private returns (uint128 newRemaining) {
        Order storage resting = book.orders[currentId];
        uint128 fillQty = remaining < resting.remainingQty ? remaining : resting.remainingQty;

        Fill memory f;
        f.orderId = currentId;
        f.maker = resting.owner;
        f.qty = fillQty;
        f.priceCents = price;
        result.fills[result.fillCount] = f;
        result.fillCount++;

        result.usdcTradedCents += fillQty * uint128(price);
        result.filledQty += fillQty;
        result.worstFillPrice = price;

        // Update book state
        level.totalQty -= fillQty;
        resting.remainingQty -= fillQty;
        if (resting.remainingQty == 0) {
            _removeFromLevel(book, level, currentId);
            delete book.orders[currentId];
        }

        return remaining - fillQty;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// @notice Insert a new resting limit order into the book.
    /// @return orderId The assigned order ID.
    function insert(
        Book storage book,
        Side side,
        uint8 priceCents,
        uint128 quantity,
        address owner
    ) internal returns (uint256 orderId) {
        if (priceCents < 1 || priceCents > 99) revert InvalidPrice(priceCents);
        if (quantity == 0) revert InvalidQuantity();

        book.nextOrderId += 1;
        orderId = book.nextOrderId;

        book.orders[orderId] = Order({
            owner: owner,
            remainingQty: quantity,
            priceCents: priceCents,
            side: side,
            prevId: 0,
            nextId: 0
        });

        PriceLevel storage level = side == Side.BID
            ? book.bids[_levelIndex(priceCents)]
            : book.asks[_levelIndex(priceCents)];

        _appendToLevel(book, level, orderId);
        level.totalQty += quantity;
    }

    /// @notice Remove an order entirely from the book (cancel or post-fill cleanup).
    function remove(Book storage book, uint256 orderId) internal {
        Order storage o = book.orders[orderId];
        if (o.owner == address(0)) revert OrderNotFound(orderId);

        PriceLevel storage level = o.side == Side.BID
            ? book.bids[_levelIndex(o.priceCents)]
            : book.asks[_levelIndex(o.priceCents)];

        level.totalQty -= o.remainingQty;
        _removeFromLevel(book, level, orderId);
        delete book.orders[orderId];
    }

    /// @notice Decrement remainingQty on an order and remove it if fully filled.
    function applyFill(Book storage book, uint256 orderId, uint128 fillQty) internal {
        Order storage o = book.orders[orderId];
        PriceLevel storage level = o.side == Side.BID
            ? book.bids[_levelIndex(o.priceCents)]
            : book.asks[_levelIndex(o.priceCents)];

        level.totalQty -= fillQty;
        o.remainingQty -= fillQty;

        if (o.remainingQty == 0) {
            _removeFromLevel(book, level, orderId);
            delete book.orders[orderId];
        }
    }

    /// @notice Match a market order against resting orders on the opposite side.
    /// Sweeps best prices inward, up to min(maxFills, HARD_MAX_FILLS) fills.
    /// @param takerSide    BID = buying Yes, ASK = selling Yes.
    /// @param quantity     Total quantity to fill.
    /// @param maxFills     Caller-specified fill cap (capped at HARD_MAX_FILLS).
    /// @param isIOC        If true, discard unfilled remainder. If false and zero fills, revert NoLiquidity.
    /// @param taker        Address of the taker (for self-trade prevention).
    function matchMarket(
        Book storage book,
        Side takerSide,
        uint128 quantity,
        uint8 maxFills,
        bool isIOC,
        address taker,
        uint8 /* fallbackPostPriceCents — used by caller only */
    ) internal returns (FillResult memory result) {
        uint8 fillCap = maxFills > HARD_MAX_FILLS ? HARD_MAX_FILLS : maxFills;
        uint128 remaining = quantity;

        if (takerSide == Side.BID) {
            for (uint8 price = 1; price <= 99 && remaining > 0 && result.fillCount < fillCap; price++) {
                PriceLevel storage level = book.asks[_levelIndex(price)];
                uint256 currentId = level.headId;
                while (currentId != 0 && remaining > 0 && result.fillCount < fillCap) {
                    if (book.orders[currentId].owner == taker) revert SelfTradeNotAllowed();
                    uint256 nextId = book.orders[currentId].nextId;
                    remaining = _executeFill(book, currentId, level, remaining, price, result);
                    currentId = nextId;
                }
            }
        } else {
            for (uint8 price = 99; price >= 1 && remaining > 0 && result.fillCount < fillCap; price--) {
                PriceLevel storage level = book.bids[_levelIndex(price)];
                uint256 currentId = level.headId;
                while (currentId != 0 && remaining > 0 && result.fillCount < fillCap) {
                    if (book.orders[currentId].owner == taker) revert SelfTradeNotAllowed();
                    uint256 nextId = book.orders[currentId].nextId;
                    remaining = _executeFill(book, currentId, level, remaining, price, result);
                    currentId = nextId;
                }
                if (price == 1) break;
            }
        }

        result.remainderQty = remaining;
        result.fullyFilled = (remaining == 0);

        if (!result.fullyFilled && !isIOC && result.filledQty == 0) {
            revert NoLiquidity();
        }
    }

    /// @notice Attempt to immediately cross a limit order against the book.
    /// Fills crossing resting orders (up to HARD_MAX_FILLS), returns unfilled remainder.
    /// @param taker Address of the limit order placer (for self-trade prevention).
    function matchLimit(
        Book storage book,
        Side takerSide,
        uint8 priceCents,
        uint128 quantity,
        address taker
    ) internal returns (FillResult memory result) {
        uint128 remaining = quantity;

        if (takerSide == Side.BID) {
            for (
                uint8 price = 1;
                price <= priceCents && remaining > 0 && result.fillCount < HARD_MAX_FILLS;
                price++
            ) {
                PriceLevel storage level = book.asks[_levelIndex(price)];
                uint256 currentId = level.headId;
                while (currentId != 0 && remaining > 0 && result.fillCount < HARD_MAX_FILLS) {
                    if (book.orders[currentId].owner == taker) revert SelfTradeNotAllowed();
                    uint256 nextId = book.orders[currentId].nextId;
                    remaining = _executeFill(book, currentId, level, remaining, price, result);
                    currentId = nextId;
                }
            }
        } else {
            for (
                uint8 price = 99;
                price >= priceCents && remaining > 0 && result.fillCount < HARD_MAX_FILLS;
                price--
            ) {
                PriceLevel storage level = book.bids[_levelIndex(price)];
                uint256 currentId = level.headId;
                while (currentId != 0 && remaining > 0 && result.fillCount < HARD_MAX_FILLS) {
                    if (book.orders[currentId].owner == taker) revert SelfTradeNotAllowed();
                    uint256 nextId = book.orders[currentId].nextId;
                    remaining = _executeFill(book, currentId, level, remaining, price, result);
                    currentId = nextId;
                }
                if (price == priceCents) break;
            }
        }

        result.remainderQty = remaining;
        result.fullyFilled = (remaining == 0);
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /// @notice Return the best bid price (highest resting bid). Returns 0 if no bids.
    function bestBid(Book storage book) internal view returns (uint8 priceCents) {
        for (uint8 price = 99; price >= 1; price--) {
            if (book.bids[_levelIndex(price)].headId != 0) return price;
            if (price == 1) break;
        }
        return 0;
    }

    /// @notice Return the best ask price (lowest resting ask). Returns 0 if no asks.
    function bestAsk(Book storage book) internal view returns (uint8 priceCents) {
        for (uint8 price = 1; price <= 99; price++) {
            if (book.asks[_levelIndex(price)].headId != 0) return price;
        }
        return 0;
    }

    /// @notice Return the total resting quantity at a given price level.
    function depthAt(Book storage book, Side side, uint8 priceCents) internal view returns (uint128 qty) {
        return side == Side.BID
            ? book.bids[_levelIndex(priceCents)].totalQty
            : book.asks[_levelIndex(priceCents)].totalQty;
    }

    /// @notice Return the owner of an order.
    function ownerOf(Book storage book, uint256 orderId) internal view returns (address) {
        return book.orders[orderId].owner;
    }

    /// @notice Return the remaining unfilled quantity of an order.
    function remainingOf(Book storage book, uint256 orderId) internal view returns (uint128) {
        return book.orders[orderId].remainingQty;
    }
}
