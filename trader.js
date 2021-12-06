const Config = require('./config.js')
const WebSocket = require('ws');
const Exchange = require('./exchanges/binance');


const getDate = require('./util.js');

module.exports = class Trader  {

    exchange = new Exchange();

    constructor() {
        this.config = null;
        this.active = false;
        this.pause = false;
        this.amountIn = 0
        this.tradeFinished = false;
        this.startTime = new Date();
        this.avgPrice = 0;
        this.target = 0;
        this.nextSafetyOrder = 0;
        this.safetyStep = 0;
        this.ws = null;
        this.currentOrders = {};
        this.onHold = false;
        this.totalAllocated = 0;
        this.safetyPrice = 0;
        this.targetPrice = 0;
    }

    setConfig() {
        this.config = new Config()
    }

    async placeShortOrders(initialBase, currentPrice) {
        const CONFIG = this.config;
        let baseOrder, targetOrder, safetyOrder = null;
        let targetPrice, safetyPrice = 0;

        try {
            baseOrder = await this.exchange.marketSell(initialBase, currentPrice, CONFIG.symbolInfo) // Placing market base order
            baseOrder.price = baseOrder.cummulativeQuoteQty / baseOrder.executedQty;

            this.currentOrders.baseOrder = baseOrder;
            this.amountIn += baseOrder.cummulativeQuoteQty;
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (baseOrder.executedQty * baseOrder.price)) / ((this.totalAllocated + baseOrder.executedQty));
            this.totalAllocated += baseOrder.executedQty;

            this.safetyPrice = baseOrder.price * (1 + CONFIG.deviation);
            this.targetPrice = this.avgPrice * (1 - CONFIG.targetProfit);

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Sold ${baseOrder.executedQty} ${CONFIG.base} for ${baseOrder.cummulativeQuoteQty} ${CONFIG.quote} [price: ${baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.quote} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.base}`);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;            
        }

        try {
            targetOrder = await this.exchange.limitBuy(this.amountIn, targetPrice, CONFIG.symbolInfo) // Seting target take profit order
            this.currentOrders.targetOrder = targetOrder;
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Order Placed: ${this.currentOrders.targetOrder.price} ${CONFIG.quote}`);    
        }
        catch(err) {
            console.log(getDate(),"Error placing target order")
            throw err;   
        }

        try {
            safetyOrder = await this.exchange.limitSell(CONFIG.safetyOrderSize, safetyPrice, CONFIG.symbolInfo) // Setting safety order
            this.currentOrders.safetyOrder = safetyOrder;
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Placed: ${this.currentOrders.safetyOrder.price}`);    
        }
        catch(err){
            console.log(getDate(),"Error placing safety order");
            throw err;   
        }

            
    }

    async placeLongOrders(initialQuote, currentPrice) {
        const CONFIG = this.config;
        let baseOrder, targetOrder, safetyOrder = null;
        let targetPrice, safetyPrice = 0;
        try {
            baseOrder = await this.exchange.marketBuy(initialQuote, currentPrice, CONFIG.symbolInfo) // Placing market base order
            baseOrder.price = baseOrder.cummulativeQuoteQty / baseOrder.executedQty;
                        
            this.currentOrders.baseOrder = baseOrder;
            this.amountIn  += baseOrder.executedQty;            
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (baseOrder.cummulativeQuoteQty * baseOrder.price)) / ((this.totalAllocated + baseOrder.cummulativeQuoteQty));                                
            this.totalAllocated += baseOrder.cummulativeQuoteQty;
            if (this.safetyStep > 0)            
                console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered safety order at price ${this.safetyPrice} ${CONFIG.quote}, executed at  with ${baseOrder.price} ${CONFIG.quote} [diff: ${this.safetyPrice / baseOrder.price < 1 ? (1 - (this.safetyPrice/baseOrder.price)) : ((this.safetyPrice/baseOrder.price) - 1)}%]`);    

            this.safetyPrice = baseOrder.price * (1 - CONFIG.deviation);
            this.targetPrice = this.avgPrice * (1 + CONFIG.targetProfit);

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Bought ${baseOrder.executedQty} ${CONFIG.base} with ${baseOrder.cummulativeQuoteQty} ${CONFIG.quote} [price: ${baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.base} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Order Placed: ${this.targetPrice} ${CONFIG.quote}`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Placed: ${this.safetyPrice}`);  
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;            
        }
    }

    isPlaceLongSafetyOrder(price) {
        return this.config.type == "LONG" && price <= this.safetyPrice
    }

    isPlaceShortSafetyOrder(price) {
        return this.config.type == "SHORT" && price >= this.safetyPrice
    }

    isPlaceLongTakeProfitOrder(price) {
        return this.config.type == "LONG" && price >= this.targetPrice
    }

    isPlaceShortTakeProfitOrder(price) {
        return this.config.type == "SHORT" && price <= this.targetPrice
    }
    
    async init() {
        const CONFIG = this.config;
        CONFIG.symbolInfo = await this.exchange.exchangeInfo(CONFIG.symbol)
        var url = `wss://stream.binance.com:9443/ws/${CONFIG.symbol.toLowerCase()}@trade`;        
        this.ws = new WebSocket(url);
        this.ws.onmessage = async (event) => {        
            var obj = JSON.parse(event.data);
            if (obj.e == "trade" && !this.tradeFinished) {
                obj.p = parseFloat(obj.p)
                if (!this.active) {
                    // setting main order;
                    this.active = true;
                    try {
                        if (CONFIG.type == "LONG")
                            await this.placeLongOrders(CONFIG.baseOrderSize, obj.p)
                        else if (CONFIG.type == "SHORT") {
                            await this.placeShortOrders(CONFIG.baseOrderSize, obj.p)
                        }  
                    }
                    catch(err) {
                        console.log("Err msg:", err);
                        return;
                    }
                                      
                    
                } else  if (!this.pause) {
                    if (this.safetyPrice && ( this.isPlaceLongSafetyOrder(obj.p) || this.isPlaceShortSafetyOrder(obj.p))) {
                        if (this.safetyStep < CONFIG.numSafetyOrders) {
                            this.pause = true;
                            this.safetyStep++;
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Unable to reach current target, triggering Safety Order at ${this.safetyPrice}`);
                            let nextStepStartQuantity = CONFIG.safetyOrderSize * Math.pow(CONFIG.volumeScaling, this.safetyStep - 1);   

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
                            this.pause = false;
                        }
                        else if (!this.onHold) {     
                            this.onHold = true;                    
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Out of safety orders, on hold: ${this.amountIn} ${CONFIG.symbol}, spent ${this.totalAllocated} with an average price of ${this.avgPrice}`);
                        }
                    }
                    else if (this.targetPrice && ( this.isPlaceLongTakeProfitOrder(obj.p) || this.isPlaceShortTakeProfitOrder(obj.p) ) ) { 
                        this.pause = true;
                        let result = {};
                        if (CONFIG.type == "LONG") {
                            result = await this.exchange.marketSell(this.amountIn,obj.p,CONFIG.symbolInfo);
                        }
                        else if (CONFIG.type == "SHORT") {
                            result = await this.exchange.marketBuy(this.amountIn,obj.p,CONFIG.symbolInfo);
                        }
                        result.price = result.cummulativeQuoteQty / result.executedQty;              
                        console.log(result)      
                        this.onHold = false;
                        this.pause = false;   
                        console.log(getDate(), `[Safety Step ${this.safetyStep}]`, `Triggered target order at price ${this.targetPrice} ${CONFIG.quote}, executed at  with ${result.price} ${CONFIG.quote} [diff: ${this.targetPrice / result.price < 1 ? (1 - (this.targetPrice/result.price)) : ((this.targetPrice/result.price) - 1)}%]`);                      
                        if (CONFIG.type == "LONG") {
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `SOLD ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.cummulativeQuoteQty/(result.executedQty * this.avgPrice))-1)*100}%)  [price: ${result.price}]`);
                            if (result.status == "FILLED") {
                                if (this.ws) {
                                    this.ws.terminate() 
                                    this.ws = null;
                                }
                                CONFIG.callback(parseFloat(result.cummulativeQuoteQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol);
                            }                                
                        }
                        else if (CONFIG.type == "SHORT") {
                            console.log("Total allocated", this.totalAllocated)
                            console.log("Exec qty", result.executedQty)
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `BOUGHT ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.executedQty/this.totalAllocated)-1)*100}%)  [price: ${result.price}]`);
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Price converted: (${(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) * result.price} ${CONFIG.quote})`)
                            if (result.status == "FILLED") { 
                                if (this.ws) {
                                    this.ws.terminate() 
                                    this.ws = null;
                                }
                                CONFIG.callback(parseFloat(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol);
                            }
                        }

                        
                    }
                }

            }            
        };
    }
}