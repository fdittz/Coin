const Config = require('./config.js')
const WebSocket = require('ws');
const Exchange = require('./exchanges/binance');

const getDate = require('./util.js');

module.exports = class Trader  {

    exchange = new Exchange();

    constructor() {
        this.config = null;         // Trader parameteres
        this.active = false;        // Check if this trader is already active (used for placing the first order)
        this.pause = false;         // Simple flag for controlling the trading flow, halts operations until requests are completed
        this.debug = false;         // Flag for displaying order result information on console
        this.amountIn = 0;          // Total amount of currency bought (on LONG operations) or total quote currency accumulated (on SHORT operations)        
        this.startTime = new Date();
        this.avgPrice = 0;          // Average price of the base order + all safety orders placed
        this.safetyStep = 0;        // Current safety order step
        this.ws = null;             // WebSocket Handler
        this.baseOrder = {};        // Current active order
        this.onHold = false;        // Used when all safety orders have been executed and the bot needs to wait for the price to go up
        this.totalAllocated = 0;    // Total currency already allocated
        this.safetyPrice = 0;       // Price used for placing the next Safety Order
        this.targetPrice = 0;       // Target price used for triggering the Take Profit Order
        this.lastBnbValue = 0;      // Current BNB value in the user-defined currency, used to calculate comission
        this.comission = 0;         // Total comission (in user-defined currency) paid
        this.tradeFinished = false;
    }

    setConfig() {
        this.config = new Config()
    }

    /**
     * Check conditions for placing a safety order when performing LONG operations 
     * @param price the last received trading price
     * @return true or false
     */
    isPlaceLongSafetyOrder(price) {
        return this.config.type == "LONG" && price <= this.safetyPrice
    }

    /**
     * Check conditions for placing a safety order when performing SHORT operations 
     * @param price the last received trading price
     * @return true or false
     */
    isPlaceShortSafetyOrder(price) {
        return this.config.type == "SHORT" && price >= this.safetyPrice
    }

    /**
     * Check conditions for placing a take profit order when performing LONG operations 
     * @param price the last received trading price
     * @return true or false
     */
    isPlaceLongTakeProfitOrder(price) {
        return this.config.type == "LONG" && price >= this.targetPrice
    }

    /**
     * Check conditions for placing a take profit order when performing SHORT operations 
     * @param price the last received trading price
     * @return true or false
     */
    isPlaceShortTakeProfitOrder(price) {
        return this.config.type == "SHORT" && price <= this.targetPrice
    }

    async placeShortOrders(initialBase, currentPrice) {
        const CONFIG = this.config;
        try {
            this.baseOrder = await this.exchange.marketSell(initialBase, currentPrice, CONFIG.symbolInfo) // Placing market sell base order (SHORT operation)
            this.baseOrder.price = this.baseOrder.cummulativeQuoteQty / this.baseOrder.executedQty; // Getting the final market price of the resulting order

            if (this.debug)
                console.log("Short Base Order", baseOrder);
            
            if (this.baseOrder.fills) {
                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0) // Gets the total comission paid
            }

            this.amountIn += this.baseOrder.cummulativeQuoteQty; // In a SHORT operation, this is the resulting sum of total quote asset acquired when selling the base asset
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.baseOrder.executedQty * this.baseOrder.price)) / ((this.totalAllocated + this.baseOrder.executedQty)); //calculates the average price of all orders
            this.totalAllocated += this.baseOrder.executedQty; // Total base asset already used on this trade
            if (this.safetyStep > 0) {
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${this.baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / this.baseOrder.price < 1 ? (1 - (this.safetyPrice/this.baseOrder.price)) : ((this.safetyPrice/this.baseOrder.price) - 1)}%]`);
            }

            this.safetyPrice = this.baseOrder.price * (1 + CONFIG.deviation); // Calculating the next safety price based on user definitions
            this.targetPrice = this.avgPrice * (1 - CONFIG.targetProfit); // Calculating the next target take profit price based on user definitions

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Sold ${this.baseOrder.executedQty} ${CONFIG.base} for ${this.baseOrder.cummulativeQuoteQty} ${CONFIG.quote} | comission: ${this.comission} ${CONFIG.comissionCurrency} [price: ${this.baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.quote} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.base}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Price: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Price: ${this.safetyPrice}`);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;
        }
    }

    async placeLongOrders(initialQuote, currentPrice) {
        const CONFIG = this.config;

        try {
            this.baseOrder = await this.exchange.marketBuy(initialQuote, currentPrice, CONFIG.symbolInfo) // Placing market sell base order (LONG operation)
            this.baseOrder.price = this.baseOrder.cummulativeQuoteQty / this.baseOrder.executedQty; // Getting the final market price of the resulting order

            if (this.debug)
                console.log("Long Base Order", baseOrder);
            
            if (this.baseOrder.fills) {
                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0) // Gets the total comission paid
            }

            this.amountIn  += this.baseOrder.executedQty; // In a LONG operation, this is the resulting sum of total base asset acquired
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.baseOrder.cummulativeQuoteQty * this.baseOrder.price)) / ((this.totalAllocated + this.baseOrder.cummulativeQuoteQty)); //calculates the average price of all orders
            this.totalAllocated += this.baseOrder.cummulativeQuoteQty; // Total base asset already used on this trade
            if (this.safetyStep > 0) {
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${this.baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / this.baseOrder.price < 1 ? (1 - (this.safetyPrice/this.baseOrder.price))*100 : ((this.safetyPrice/this.baseOrder.price) - 1)*100}%]`);
            }

            this.safetyPrice = this.baseOrder.price * (1 - CONFIG.deviation); // Calculating the next safety price based on user definitions
            this.targetPrice = this.avgPrice * (1 + CONFIG.targetProfit); // Calculating the next target take profit price based on user definitions

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Bought ${this.baseOrder.executedQty} ${CONFIG.base} with ${this.baseOrder.cummulativeQuoteQty} ${CONFIG.quote} | comission: ${this.comission} ${CONFIG.comissionCurrency} [price: ${this.baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.base} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Price: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Price: ${this.safetyPrice}`);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order");
            throw err;
        }
    }

    async init() {
        const CONFIG = this.config;
        CONFIG.symbolInfo = await this.exchange.exchangeInfo(CONFIG.symbol);
        var url = `wss://stream.binance.com:9443/ws/${CONFIG.symbol.toLowerCase()}@trade/${CONFIG.com}@ticker`;
        this.ws = new WebSocket(url);
        this.ws.onmessage = async (event) => {
            var obj = JSON.parse(event.data);
            if (obj.e == "trade") {
                obj.p = parseFloat(obj.p);
                if (!this.active && !this.tradeFinished) {
                    this.active = true;
                    try {
                        if (CONFIG.type == "LONG")
                            await this.placeLongOrders(CONFIG.this.baseOrderSize, obj.p)
                        else if (CONFIG.type == "SHORT") {
                            await this.placeShortOrders(CONFIG.this.baseOrderSize, obj.p)
                        }
                    }
                    catch(err) {
                        console.log("Err msg:", err);
                        return;
                    }
                } else  if (!this.pause && !this.tradeFinished) {
                    if (this.safetyPrice && ( this.isPlaceLongSafetyOrder(obj.p) || this.isPlaceShortSafetyOrder(obj.p))) { // Price has fallen (LONG) or risen(SHORT) beyond the defined % threshold, will place a safety market order
                        if (this.safetyStep < CONFIG.numSafetyOrders) { // Still have safety orders available
                            this.pause = true; // Sets this flag so no order is placed until the safety order creation is done
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Unable to reach current target, placing Safety Order at ${this.safetyPrice}`);
                            this.safetyStep++; // Advances safety order step
                            let nextStepStartQuantity = CONFIG.safetyOrderSize * Math.pow(CONFIG.volumeScaling, this.safetyStep - 1); // Defines the quantity of base or quote order to be used on the next safety order (see user-defined configurations for scaling)

                            try {
                                if (CONFIG.type == "LONG") {
                                    await this.placeLongOrders(nextStepStartQuantity, obj.p);
                                }
                                else if (CONFIG.type == "SHORT") {
                                    await this.placeShortOrders(nextStepStartQuantity, obj.p)
                                }
                            }
                            catch(err) {
                                console.log("Err msg:", err);
                                this.pause = false;
                                return;
                            }
                            this.pause = false; // Resumes the program's flow
                        }
                        else if (!this.onHold) { // When out of safety orders, the bot will hold the last average price until it goes up again
                            this.onHold = true;
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Out of safety orders, on hold: ${this.amountIn} ${CONFIG.symbol}, spent ${this.totalAllocated} with an average price of ${this.avgPrice}`);
                        }
                    }
                    else if (this.targetPrice && ( this.isPlaceLongTakeProfitOrder(obj.p) || this.isPlaceShortTakeProfitOrder(obj.p) ) ) { // Price has risen (LONG) or fallen(SHORT) beyond the defined % threshold, will place a take profit market order
                        this.pause = true;
                        let result = {};
                        if (CONFIG.type == "LONG") {
                            if (!this.tradeFinished) {
                                this.tradeFinished = true;
                                try {
                                    result = await this.exchange.marketSell(this.amountIn,obj.p,CONFIG.symbolInfo);
                                } catch(err) {
                                    console.log(err)
                                }
                            }
                        }
                        else if (CONFIG.type == "SHORT") {
                            if (!this.tradeFinished) {
                                this.tradeFinished = true;
                                try {
                                    result = await this.exchange.marketBuy(this.amountIn,obj.p,CONFIG.symbolInfo);
                                } catch(err) {
                                    console.log(err)
                                }
                            }
                        }
                        if (result.orderId) {
                            result.price = result.cummulativeQuoteQty / result.executedQty; // Gets the actual price of the resulting take profit order
                            if (this.debug)
                                console.log("Take Profit Order Result", result);

                            if (this.baseOrder.fills) {
                                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0); // Gets the total comission paid
                            }

                            if (this.ws) { // Closes websocket connection
                                this.ws.terminate() 
                                this.ws = null;
                            }
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Triggered target order at price ${this.targetPrice} ${CONFIG.quote}, executed at  with ${result.price} ${CONFIG.quote} [diff: ${this.targetPrice / result.price < 1 ? (1 - (this.targetPrice/result.price))*100 : ((this.targetPrice/result.price) - 1)*100}%]`);
                            if (CONFIG.type == "LONG") {
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `SOLD ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.cummulativeQuoteQty/(result.executedQty * this.avgPrice))-1)*100}%) | comission: ${this.comission} ${CONFIG.comissionCurrency} [price: ${result.price}]`);
                                CONFIG.callback(parseFloat(result.cummulativeQuoteQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol); //  Trade is finished, closes this trader
                            }
                            else if (CONFIG.type == "SHORT") {
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `BOUGHT ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.executedQty/this.totalAllocated)-1)*100}%) | comission: ${this.comission} ${CONFIG.comissionCurrency} [price: ${result.price}]`);
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Price converted: (${(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) * result.price} ${CONFIG.quote})`);
                                CONFIG.callback(parseFloat(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol); //  Trade is finished, closes this trader
                            }
                        }
                        else {
                            this.tradeFinished = false;
                        }
                    }
                }
            }
            else if (obj.e == "24hrTicker" && obj.s == "BNBBUSD") {
                this.lastBnbValue = obj.c;
            }
        }
    }
}