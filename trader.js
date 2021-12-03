const Config = require('./config.js')
const WebSocket = require('ws');
const Exchange = require('./exchanges/binance');


const getDate = require('./util.js');

module.exports = class Trader  {

    exchange = new Exchange();

    constructor() {
        this.config = null;
        this.active = false;
        this.processingSafetyOrder = false;
        this.amountIn = 0
        this.tradeFinished = false;
        this.startTime = new Date();
        this.avgPrice = 0;
        this.target = 0;
        this.nextSafetyOrder = 0;
        this.safetyStep = 0;
        this.amountOut = 0;
        this.ws = null;
        this.currentOrders = {};
        this.onHold = false;
        this.totalAllocated = 0;
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

            this.amountOut = baseOrder.executedQty;
            this.currentOrders.baseOrder = baseOrder;
            this.amountIn += baseOrder.cummulativeQuoteQty;
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.amountOut * baseOrder.price)) / ((this.totalAllocated + this.amountOut));
            this.totalAllocated += this.amountOut;

            safetyPrice = baseOrder.price * (1 + CONFIG.deviation);
            targetPrice = this.avgPrice * (1 - CONFIG.targetProfit);

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
            
            this.amountOut = baseOrder.cummulativeQuoteQty;                                
            this.currentOrders.baseOrder = baseOrder;
            this.amountIn  += baseOrder.executedQty;            
            this.avgPrice = ((this.totalAllocated * this.avgPrice) + (this.amountOut * baseOrder.price)) / ((this.totalAllocated + this.amountOut));                                
            this.totalAllocated += this.amountOut;

            safetyPrice = baseOrder.price * (1 - CONFIG.deviation);
            targetPrice = this.avgPrice * (1 + CONFIG.targetProfit);

            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Bought ${baseOrder.executedQty} ${CONFIG.base} with ${this.amountOut} ${CONFIG.quote} [price: ${baseOrder.price}]`);
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Holding ${this.amountIn} ${CONFIG.base} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.totalAllocated} ${CONFIG.quote}`);
        }
        catch (err) {
            console.log(getDate(),"Error placing base order")
            throw err;            
        }

        try {
            targetOrder = await this.exchange.limitSell(this.amountIn, targetPrice, CONFIG.symbolInfo) // Seting target take profit order
            this.currentOrders.targetOrder = targetOrder;
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Target Take Profit Order Placed: ${this.currentOrders.targetOrder.price} ${CONFIG.quote}`);    
        }
        catch(err) {
            console.log(getDate(),"Error placing target order")
            throw err;   
        }

        try {
            safetyOrder = await this.exchange.limitBuy(CONFIG.safetyOrderSize, safetyPrice, CONFIG.symbolInfo) // Setting safety order
            this.currentOrders.safetyOrder = safetyOrder;
            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Safety Order Placed: ${this.currentOrders.safetyOrder.price}`);    
        }
        catch(err){
            console.log(getDate(),"Error placing safety order");
            throw err;   
        };
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
                                      
                    
                } else  {
                    if (this.currentOrders.safetyOrder && ( (CONFIG.type == "LONG" && obj.p <= this.currentOrders.safetyOrder.price) || (CONFIG.type == "SHORT" && obj.p >= this.currentOrders.safetyOrder.price)) && !this.processingSafetyOrder) {
                        if (this.safetyStep < CONFIG.numSafetyOrders) {

                            this.processingSafetyOrder = true;                        
                            this.safetyStep++;
                            console.log(" ");
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Unable to reach current target, triggering Safety Order at ${this.currentOrders.safetyOrder.price}`);
                            await this.exchange.cancelOrder(CONFIG.symbolInfo, this.currentOrders.targetOrder.orderId); //cancels previous target take profit order
                            this.amountOut = CONFIG.safetyOrderSize * Math.pow(CONFIG.volumeScaling, this.safetyStep - 1);   

                            try {
                                if (CONFIG.type == "LONG")
                                    await this.placeLongOrders(this.amountOut, obj.p)
                                else if (CONFIG.type == "SHORT") {
                                    await this.placeShortOrders(this.amountOut, obj.p)
                                }   
                            }
                            catch(err) {
                                console.log("Err msg:", err);
                                this.processingSafetyOrder = false;
                                return;
                            }
                            this.processingSafetyOrder = false;
                        }
                        else if (!this.onHold) {     
                            this.onHold = true;                    
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Out of safety orders, on hold: ${this.amountIn} ${CONFIG.symbol}, spent ${this.totalAllocated} with an average price of ${this.avgPrice}`);
                        }
                    }
                    else if (this.currentOrders.targetOrder && ( (CONFIG.type == "LONG" && obj.p >= this.currentOrders.targetOrder.price) || (CONFIG.type == "SHORT" && obj.p <= this.currentOrders.targetOrder.price) ) ) {                        
                        let result = await this.exchange.getOrderInfo(CONFIG.symbolInfo, this.currentOrders.targetOrder.orderId);
                        console.log(result)      
                        if (result.status == "FILLED") {
                            this.tradeFinished = true;
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Order FULLY FILLED, will end current trader[price: ${result.price}]`);
                            await this.exchange.cancelOrder(CONFIG.symbolInfo, this.currentOrders.safetyOrder.orderId) 
                        }
                        else {
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Order PARTIALLY FILLED, will remain on order book[price: ${result.price}]`);
                        }
                                          
                        //cancels previous safety order
                        this.onHold = false;
                        this.ws.terminate() 
                        this.ws = null;
                        if (CONFIG.type == "LONG") {
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `SOLD ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.cummulativeQuoteQty/(result.executedQty * this.avgPrice))-1)*100}%)  [price: ${result.price}]`);
                            if (result.status == "FILLED") 
                                CONFIG.callback(parseFloat(result.cummulativeQuoteQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol);
                        }
                        else if (CONFIG.type == "SHORT") {
                            console.log("Total allocated", this.totalAllocated)
                            console.log("Exec qty", result.executedQty)
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `BOUGHT ${result.executedQty} ${CONFIG.base} for ${result.cummulativeQuoteQty} (${((result.executedQty/this.totalAllocated)-1)*100}%)  [price: ${result.price}]`);
                            console.log(getDate(), this.safetyStep > 0 ? `[Safety Step ${this.safetyStep}]` : "[Base Order]", `Price converted: (${(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) * result.price} ${CONFIG.quote})`)
                            if (result.status == "FILLED") 
                                CONFIG.callback(parseFloat(result.executedQty * CONFIG.feeDown * CONFIG.feeDown) - this.totalAllocated, CONFIG.symbol, );
                        }
                        
                    }
                }

            }            
        };
    }
}