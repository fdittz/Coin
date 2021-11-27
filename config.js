'use strict';

module.exports = class Config  {

    constructor(base, quote, type, fee, baseOrderSize, numSafetyOrders, targetProfit, deviation, volumeScaling, callback) {
        this.base = base;
        this.quote = quote;
        this.symbol = base + quote
        this.type = type;
        this.fee = fee;
        this.feeDown = 1 - fee;
        this.baseOrderSize = baseOrderSize;
        this.numSafetyOrders = numSafetyOrders;
        this.safetyOrderSize = baseOrderSize*volumeScaling;
        this.targetProfit = targetProfit;
        this.deviation = deviation;
        this.volumeScaling = volumeScaling;
        this.callback = callback;
        this.symbolInfo = {};
        this.minNotional = 0;
    }

}