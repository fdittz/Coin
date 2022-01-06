const Config = require('./config.js')
const WebSocket = require('ws');
const CliProgress = require('cli-progress');
var keypress = require('keypress');
const getDate = require('./util.js');
const fs = require('fs');
const Exchange = require('./exchanges/binance');
var keypress = require('keypress');
var hash = require('object-hash');
keypress(process.stdin); 




module.exports = class Trader  {

    exchange = new Exchange().getInstance();

    constructor(name) {
        this.name = name;
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
        this.lastBnbValue = 0;      // Current BNB value in the user-defined currency, used to calculate commission
        this.commission = 0;         // Total commission (in user-defined currency) paid
        this.awaitingTrade = false;
        this.bar = null;
        this.tradeFinished = false;

        var self = this;
        // listen for the "keypress" event
        process.stdin.on('keypress', function (ch, key) {
            if (key && key.ctrl && key.name == 'up')
                self.increaseSafetyOrders();
            else if (key && key.ctrl && key.name == 'down')
                self.decreaseSafetyOrders();
        });        
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding( 'utf8' );        
        console.log(getDate(), `Using Exchange Hash: ${hash(this.exchange)}`)
        
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
        return (this.config.type == "SHORT" || this.config.type == "SHORT-QUOTE") && price >= this.safetyPrice
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
        return (this.config.type == "SHORT" || this.config.type == "SHORT-QUOTE") && price <= this.targetPrice
    }

    updateBar(price) {
        if (this.config.type == "SHORT" || this.config.type == "SHORT-QUOTE") {
            this.bar.update(this.safetyPrice - price);
            return this.safetyPrice - price;
        }
        else if (this.config.type == "LONG") {
            this.bar.update(price - this.safetyPrice);
            return price - this.safetyPrice;
        }
    }

    getTotalFundsNeeded() {
        const CONFIG = this.config;
        let totalAssetNeeded = CONFIG.baseOrderSize;
        for (var i = 1; i < CONFIG.numSafetyOrders + 1; i++) {
            totalAssetNeeded += CONFIG.safetyOrderSize * (Math.pow(CONFIG.volumeScaling,i));
        }
        return totalAssetNeeded
    }

    async increaseSafetyOrders() {
        const CONFIG = this.config;
        CONFIG.numSafetyOrders++
        console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Increasing the number of safety orders from ${CONFIG.numSafetyOrders-1} to ${CONFIG.numSafetyOrders}, new Total Asset needed: ${this.getTotalFundsNeeded()}`);
        if (this.onHold)
            this.onHold = false;
    }

    async decreaseSafetyOrders() {
        const CONFIG = this.config;
        console.log(CONFIG.numSafetyOrders)
        if (this.safetyStep < CONFIG.numSafetyOrders) {
            CONFIG.numSafetyOrders--;
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Decreasing the number of safety orders from ${CONFIG.numSafetyOrders+1} to ${CONFIG.numSafetyOrders}, new Total Asset needed: ${this.getTotalFundsNeeded()}`);            
        }
        else {
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Can't decrease the number of safety orders to a number below the active count`);            
        }
    }

    initLongBar() {
        var self = this
        this.bar = new CliProgress.SingleBar({
            format: `Last: \x1b[33m{value}\x1b[0m | \x1b[33m{percentage}%\x1b[0m >> \x1b[31m${this.safetyPrice}\x1b[0m {bar} \x1b[32m${this.targetPrice}\x1b[0m`,
            formatValue: function(v, options, type) {
                if (options.autopadding !== true){
                    if (type == 'percentage')
                        return v;
                    else
                        return self.safetyPrice + v
                }
                function autopadding(value, length){
                    return (options.autopaddingChar + value).slice(-length);
                }                
                switch (type){
                    case 'percentage':
                        return autopadding(v, 3);
            
                    default: 
                        return v;
                }
            },
        }, CliProgress.Presets.shades_classic);
        let range = (this.targetPrice - this.safetyPrice);
        this.bar.start(range,0);
    }

    initShortBar() {
        var self = this
        this.bar = new CliProgress.SingleBar({
            format: `Last: \x1b[33m{value}\x1b[0m | \x1b[33m{percentage}%\x1b[0m >> \x1b[31m${this.safetyPrice}\x1b[0m {bar} \x1b[32m${this.targetPrice}\x1b[0m`,
            formatValue: function(v, options, type) {
                if (options.autopadding !== true){
                    if (type == 'percentage')
                        return v;
                    else
                        return self.safetyPrice - v
                }
                function autopadding(value, length){
                    return (options.autopaddingChar + value).slice(-length);
                }
                switch (type){
                    case 'percentage':
                        return autopadding(v, 3);
            
                    default: 
                        return v;
                }
            },
        }, CliProgress.Presets.shades_classic);
        let range = (this.safetyPrice - this.targetPrice);
        this.bar.start(range,0);
    }

    stopBar() {
        if (this.bar) {
            this.bar.stop();
            //process.stdout.write("\r\x1b[K");
        }
    }

    checkAndLoadData() {
        var data = null
        try {
            data = JSON.parse(fs.readFileSync(`./saves/${this.name}.json`));
            console.log("Found previous trader datafile, starting where it stopped");            
        }
        catch(err) {
            console.log("No previous trader datafile found, starting from scratch");
        }
        if (data) {
            Object.keys(data).forEach( prop => {
                if (prop != "config" && prop != "exchange") {
                    this[prop] = data[prop]
                }
            })
            data.ws = null;
            const CONFIG = this.config;
            if (CONFIG.type == "LONG") {
                this.initLongBar();
            }
            else if (CONFIG.type == "SHORT" || CONFIG.type == "SHORT-QUOTE") {
                this.initShortBar();
            }
        }
    }

    writeDataFile() {
        var data = {}
        if (this) {
            Object.keys(this).forEach( prop => {
                if (!(prop.indexOf("_") == 0 && prop == "ws" ))
                    data[prop] = this[prop]
            })
            data.ws = null;
            data.bar = null;
        }
        try {
            const result = fs.writeFileSync(`./saves/${this.name}.json`, JSON.stringify(data, null, 4))
            //file written successfully
          } catch (err) {
            console.error(err)
          }
    }

    eraseDataFile() {
        try {
            const result = fs.unlinkSync(`./saves/${this.name}.json`)
            //file written successfully
          } catch (err) {
            console.error(err)
          }
    }

    async placeShortOrder(initialBase, currentPrice) {
        const CONFIG = this.config;
        try {
            this.baseOrder = await this.exchange.marketSell(initialBase, currentPrice, CONFIG.symbolInfo, this.lastBnbValue) // Placing market sell base order (SHORT operation)
            this.baseOrder.price = this.baseOrder.cummulativeQuoteQty / this.baseOrder.executedQty; // Getting the final market price of the resulting order

            if (this.debug)
                console.log("Short Base Order", this.baseOrder);            
                
            if (this.baseOrder.fills) {
                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0) // Gets the total commission paid
            }

            this.amountIn += this.baseOrder.cummulativeQuoteQty; // In a SHORT operation, this is the resulting sum of total quote asset acquired when selling the base asset
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.baseOrder.executedQty * this.baseOrder.price)) / ((this.totalAllocated + this.baseOrder.executedQty)); //calculates the average price of all orders
            this.totalAllocated += this.baseOrder.executedQty; // Total base asset already used on this trade
            if (this.safetyStep > 0) {
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${this.baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / this.baseOrder.price < 1 ? (1 - (this.safetyPrice/this.baseOrder.price)) : ((this.safetyPrice/this.baseOrder.price) - 1)}%]`);
            }

            this.safetyPrice = this.baseOrder.price * (1 + CONFIG.deviation); // Calculating the next safety price based on user definitions
            this.targetPrice = this.avgPrice * (1 - CONFIG.targetProfit); // Calculating the next target take profit price based on user definitions

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Sold ${this.baseOrder.executedQty} ${CONFIG.base} for ${this.baseOrder.cummulativeQuoteQty} ${CONFIG.quote} | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${this.baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.quote} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.base}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Price: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Price: ${this.safetyPrice}`);
            
            this.initShortBar()
            if (this.currentPrice > 0)
                this.updateBar(currentPrice);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;
        }
    }

    async placeShortQuoteOrder(initialBase, currentPrice) {
        const CONFIG = this.config;
        try {
            this.baseOrder = await this.exchange.marketSell(initialBase, currentPrice, CONFIG.symbolInfo, this.lastBnbValue) // Placing market sell base order (SHORT operation)
            this.baseOrder.price = this.baseOrder.cummulativeQuoteQty / this.baseOrder.executedQty; // Getting the final market price of the resulting order

            if (this.debug)
                console.log("Short Base Order", this.baseOrder);            
                
            if (this.baseOrder.fills) {
                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0) // Gets the total commission paid
            }

            this.amountIn += this.baseOrder.executedQty; // In this kind of SHORT operation we keep track of how much base we need to buy at a lower price (same amount we sold)
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.baseOrder.cummulativeQuoteQty * this.baseOrder.price)) / ((this.totalAllocated + this.baseOrder.cummulativeQuoteQty)); //calculates the average price of all orders
            this.totalAllocated += this.baseOrder.cummulativeQuoteQty; // Total quote asset already locked on this trade
            if (this.safetyStep > 0) {
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${this.baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / this.baseOrder.price < 1 ? (1 - (this.safetyPrice/this.baseOrder.price)) : ((this.safetyPrice/this.baseOrder.price) - 1)}%]`);
            }

            this.safetyPrice = this.baseOrder.price * (1 + CONFIG.deviation); // Calculating the next safety price based on user definitions
            this.targetPrice = this.avgPrice * (1 - CONFIG.targetProfit); // Calculating the next target take profit price based on user definitions

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Sold ${this.baseOrder.executedQty} ${CONFIG.base} for ${this.baseOrder.cummulativeQuoteQty} ${CONFIG.quote} | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${this.baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Waiting to buy ${this.amountIn} ${CONFIG.base} with a current avg. price of ${this.avgPrice} ${CONFIG.quote}, total quote earned ${this.totalAllocated} ${CONFIG.base}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Price: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Price: ${this.safetyPrice}`);
            
            this.initShortBar()
            if (this.currentPrice > 0)
                this.updateBar(currentPrice);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;
        }
    }

    async placeLongOrder(initialQuote, currentPrice) {
        const CONFIG = this.config;

        try {
            this.baseOrder = await this.exchange.marketBuy(initialQuote, currentPrice, CONFIG.symbolInfo, this.lastBnbValue) // Placing market sell base order (LONG operation)
            this.baseOrder.price = this.baseOrder.cummulativeQuoteQty / this.baseOrder.executedQty; // Getting the final market price of the resulting order

            if (this.debug)
                console.log("Long Base Order", this.baseOrder);
                
            if (this.baseOrder.fills) {
                this.commission = this.baseOrder.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0) // Gets the total commission paid
            }

            this.amountIn  += this.baseOrder.executedQty; // In a LONG operation, this is the resulting sum of total base asset acquired
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.baseOrder.cummulativeQuoteQty * this.baseOrder.price)) / ((this.totalAllocated + this.baseOrder.cummulativeQuoteQty)); //calculates the average price of all orders
            this.totalAllocated += this.baseOrder.cummulativeQuoteQty; // Total base asset already used on this trade
            if (this.safetyStep > 0) {
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${this.baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / this.baseOrder.price < 1 ? (1 - (this.safetyPrice/this.baseOrder.price))*100 : ((this.safetyPrice/this.baseOrder.price) - 1)*100}%]`);
            }

            this.safetyPrice = this.baseOrder.price * (1 - CONFIG.deviation); // Calculating the next safety price based on user definitions
            this.targetPrice = this.avgPrice * (1 + CONFIG.targetProfit); // Calculating the next target take profit price based on user definitions

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Bought ${this.baseOrder.executedQty} ${CONFIG.base} with ${this.baseOrder.cummulativeQuoteQty} ${CONFIG.quote} | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${this.baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.base} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Price: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Price: ${this.safetyPrice}`);

            this.initLongBar();
            if (this.currentPrice > 0)
                this.updateBar(currentPrice);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order");
            throw err;
        }
    }

    async init() {
        this.checkAndLoadData();
        const CONFIG = this.config;  
        CONFIG.symbolInfo = await this.exchange.exchangeInfo(CONFIG.symbol);
        var url = `wss://stream.binance.com:9443/ws/${CONFIG.symbol.toLowerCase()}@trade/${CONFIG.commissionSymbol.toLowerCase()}@ticker`;
        if (this.ws) { // Closes websocket connection
            this.ws.terminate() 
            this.ws = null;
        }
        this.ws = new WebSocket(url);
        this.ws.onmessage = async (event) => {
            const CONFIG = this.config;
            var obj = JSON.parse(event.data);
            if (obj.e == "trade" && this.lastBnbValue > 0 && !this.awaitingTrade) {
                this.writeDataFile();
                obj.p = parseFloat(obj.p);
                if (this.bar) {                    
                    this.updateBar(obj.p);
                }
                if (!this.active) {
                    this.active = true;
                    this.awaitingTrade = true;                    
                    try {
                        if (CONFIG.type == "LONG")
                            await this.placeLongOrder(CONFIG.baseOrderSize, obj.p);
                        else if (CONFIG.type == "SHORT") {
                            await this.placeShortOrder(CONFIG.baseOrderSize, obj.p);
                        }
                        else if (CONFIG.type == "SHORT-QUOTE") {
                            await this.placeShortQuoteOrder(CONFIG.baseOrderSize, obj.p);
                        }
                    }
                    catch(err) {
                        console.log("Err msg:", err);
                        this.awaitingTrade = false;
                        return;
                    }
                    this.awaitingTrade = false;
                    
                } else  if (!this.awaitingTrade) {
                    this.awaitingTrade = true;                                                                                             // Sets this flag so no order is placed until the safety order creation is done  
                    if (this.safetyPrice && ( this.isPlaceLongSafetyOrder(obj.p) || this.isPlaceShortSafetyOrder(obj.p))) {                // Price has fallen (LONG) or risen(SHORT) beyond the defined % threshold, will place a safety market order
                        if (this.safetyStep < CONFIG.numSafetyOrders) {                                                                    // Still have safety orders available                                                                                                                    
                            this.stopBar();
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Unable to reach current target, placing Safety Order at ${this.safetyPrice}`);
                            this.safetyStep++;                                                                                             // Advances safety order step
                            let nextStepStartQuantity = CONFIG.safetyOrderSize * Math.pow(CONFIG.volumeScaling, this.safetyStep - 1);      // Defines the quantity of base or quote order to be used on the next safety order (see user-defined configurations for scaling)
                                                           
                            try {
                                if (CONFIG.type == "LONG") {
                                    await this.placeLongOrder(nextStepStartQuantity, obj.p);
                                }
                                else if (CONFIG.type == "SHORT") {
                                    await this.placeShortOrder(nextStepStartQuantity, obj.p);
                                }
                                else if (CONFIG.type == "SHORT-QUOTE") {
                                    await this.placeShortQuoteOrder(nextStepStartQuantity, obj.p);
                                }
                            }
                            catch(err) {
                                console.log("Err msg:", err);
                                this.awaitingTrade = false;
                                return;
                            }
                            
                            this.awaitingTrade = false;                                                                                    // Resumes the program's flow
                        }
                        else if (!this.onHold) {                                                                                           // When out of safety orders, the bot will hold the last average price until it goes up again
                            this.onHold = true;
                            this.awaitingTrade = false
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Out of safety orders, on hold: ${this.amountIn} ${CONFIG.symbol}, spent ${this.totalAllocated} with an average price of ${this.avgPrice}`);
                        }
                    }
                    else if (this.targetPrice && ( this.isPlaceLongTakeProfitOrder(obj.p) || this.isPlaceShortTakeProfitOrder(obj.p) ) ) { // Price has risen (LONG) or fallen(SHORT) beyond the defined % threshold, will place a take profit market order
                        let result = {};
                        this.awaitingTrade = true;
                        try {
                            if (CONFIG.type == "LONG") 
                                result = await this.exchange.marketSell(this.amountIn,obj.p,CONFIG.symbolInfo, this.lastBnbValue);
                            else if (CONFIG.type == "SHORT")
                                result = await this.exchange.marketBuy(this.amountIn,obj.p,CONFIG.symbolInfo, this.lastBnbValue); 
                            else if (CONFIG.type == "SHORT-QUOTE") 
                                result = await this.exchange.marketBuyBase(this.amountIn,CONFIG.symbolInfo, obj.p, this.lastBnbValue)
                        } catch(err) {
                            console.log(err)
                            this.awaitingTrade = false
                            return;
                        }
                        
                        this.stopBar();
                        if (result.orderId) {
                            result.price = result.cummulativeQuoteQty / result.executedQty;                                                           // Gets the actual price of the resulting take profit order
                            if (this.debug)
                                console.log("Take Profit Order Result", result);

                            if (result.fills) {
                                this.commission = result.fills.reduce((prev,current) =>  (prev + current.commission) * this.lastBnbValue, 0); // Gets the total commission paid
                            }

                            if (this.ws) { // Closes websocket connection
                                this.tradeFinished = true;
                                process.stdin.removeAllListeners('keypress');
                                this.ws.terminate() 
                                this.ws = null;
                            }
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Triggered target order at price ${this.targetPrice} ${CONFIG.quote}, executed at  with ${result.price} ${CONFIG.quote} [diff: ${this.targetPrice / result.price < 1 ? (1 - (this.targetPrice/result.price))*100 : ((this.targetPrice/result.price) - 1)*100}%]`);
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Trader hash: ${hash(this)}`);
                            this.eraseDataFile();
                            if (CONFIG.type == "LONG") {                                
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `SOLD ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} ${CONFIG.quote} (${((result.cummulativeQuoteQty/(result.executedQty * this.avgPrice))-1)*100}%) | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${result.price}]`);
                                CONFIG.callback(parseFloat(result.cummulativeQuoteQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol); //  Trade is finished, closes this trader
                            }
                            else if (CONFIG.type == "SHORT") {
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `BOUGHT ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} ${CONFIG.quote} (${((result.executedQty/this.totalAllocated)-1)*100}%) | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${result.price}]`);
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Price converted: (${(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) * result.price} ${CONFIG.quote})`);
                                CONFIG.callback(parseFloat(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol); //  Trade is finished, closes this trader
                            }
                            else if (CONFIG.type == "SHORT-QUOTE") {
                                console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `BOUGHT ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} ${CONFIG.quote} (${((this.totalAllocated/result.cummulativeQuoteQty)-1)*100}%) | commission: ${this.commission} ${CONFIG.commissionCurrency} [price: ${result.price}]`);
                                CONFIG.callback(parseFloat(this.totalAllocated * CONFIG.feeDown * CONFIG.feeDown) - result.cummulativeQuoteQty, CONFIG.symbol); //  Trade is finished, closes this trader
                            }                            
                        }
                    }
                    this.awaitingTrade = false
                }
            }
            else if (obj.e == "24hrTicker" && obj.s == CONFIG.commissionSymbol) {
                this.lastBnbValue = parseFloat(obj.c);
            }
        };

        this.ws.onerror = async (err) => {
            if (!this.tradeFinished) {
                console.log(err);
                this.ws.terminate()
                this.ws = null;
                console.log(getDate(), `Websocket error, reconnecting...`);
                this.init();
            }
            return;
        }

        this.ws.onclose = async (err) => {
            if (!this.tradeFinished) {
                this.ws.terminate()
                this.ws = null;
                console.log(getDate(), `Websocket closed, reconnecting...`);
                this.init();
                return;
            }
        }
    }
}