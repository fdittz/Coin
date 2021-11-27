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
    }

    setConfig() {
        this.config = new Config()
    }
    
    async init() {
        const CONFIG = this.config;
        CONFIG.symbolInfo = await this.exchange.exchangeInfo(CONFIG.symbol)
        var url = `wss://stream.binance.com:9443/ws/${CONFIG.symbol.toLowerCase()}@trade`;
        let baseOrder, targetOrder, safetyOrder = null;
        let targetPrice, safetyPrice = 0;
        this.ws = new WebSocket(url);
        this.ws.onmessage = async (event) => {        
            var obj = JSON.parse(event.data);
            if (obj.e == "trade" && !this.tradeFinished) {
                obj.p = parseFloat(obj.p)
                if (!this.active) {
                    // setting main order;
                    this.active = true;                    

                    try {
                        baseOrder = await this.exchange.marketBuy(CONFIG.baseOrderSize, obj.p, CONFIG.symbolInfo) // Placing market base order
                        baseOrder.price = baseOrder.cummulativeQuoteQty / baseOrder.executedQty;

                        this.avgPrice = baseOrder.price;
                        this.quoteSpent = baseOrder.cummulativeQuoteQty;
                        this.amountIn = baseOrder.executedQty;

                        safetyPrice = baseOrder.price * (1 - CONFIG.deviation);
                        targetPrice = baseOrder.price * (1 + CONFIG.targetProfit);
                        this.currentOrders.baseOrder = baseOrder;
                        console.log(getDate(),`Bought ${this.amountIn} ${CONFIG.symbol} with ${this.quoteSpent} ${CONFIG.quote} [price: ${this.currentOrders.baseOrder.price}]`);
                    }
                    catch (err) {
                        console.log(err)
                        console.log(getDate(),"Error placing base order")
                        return;
                    }

                    try {
                        targetOrder = await this.exchange.limitSell(this.amountIn, targetPrice, CONFIG.symbolInfo) // Seting target take profit order
                        this.currentOrders.targetOrder = targetOrder;
                        console.log(getDate(),`Target Take Price Order Placed: ${this.currentOrders.targetOrder.price} ${CONFIG.quote}`);
                    }
                    catch(err) {
                        console.log(err)
                        console.log(getDate(),"Error placing target order")
                        return;
                    }

                    try {
                        safetyOrder = await this.exchange.limitBuy(CONFIG.safetyOrderSize, safetyPrice, CONFIG.symbolInfo) // Setting safety order
                        this.currentOrders.safetyOrder = safetyOrder;
                        console.log(getDate(),`Safety Order Placed: ${this.currentOrders.safetyOrder.price}`);
                    }
                    catch(err) {
                        console.log(err)
                        console.log(getDate(),"Error placing safety order")
                        return;
                    }                    
                    
                } else  {
                    if (this.currentOrders.safetyOrder && obj.p <= this.currentOrders.safetyOrder.price && !this.processingSafetyOrder) {
                        if (this.safetyStep < CONFIG.numSafetyOrders) {

                            this.processingSafetyOrder = true;                        
                            this.safetyStep++;
                            let currentSafetyOrderPrice = this.currentOrders.safetyOrder.price;
                            console.log(" ");
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Unable to reach current target, triggering Safety Order at ${this.currentOrders.safetyOrder.price}`);
                            await this.exchange.cancelAllOrders(CONFIG.symbolInfo); //cancels all current orders
                            this.amountOut = CONFIG.safetyOrderSize * Math.pow(CONFIG.volumeScaling, this.safetyStep - 1);   

                            try {
                                baseOrder = await this.exchange.marketBuy(this.amountOut, obj.p, CONFIG.symbolInfo) // Placing market base order
                                this.amountOut = baseOrder.cummulativeQuoteQty;
                                baseOrder.price = baseOrder.cummulativeQuoteQty / baseOrder.executedQty;
                                this.currentOrders.baseOrder = baseOrder;
                                this.amountIn  += baseOrder.executedQty;
                                this.avgPrice = ((this.quoteSpent * this.avgPrice) + (this.amountOut * baseOrder.price)) / ((this.quoteSpent + this.amountOut));                                
                                this.quoteSpent += this.amountOut;

                                safetyPrice = currentSafetyOrderPrice * (1 - CONFIG.deviation);
                                targetPrice = this.avgPrice * (1 + CONFIG.targetProfit);
                                console.log(getDate(), `[Safety Step ${this.safetyStep}] Bought ${baseOrder.executedQty} ${CONFIG.base} with ${this.amountOut} ${CONFIG.quote} [price: ${baseOrder.price}]`);
                                console.log(getDate(), `[Safety Step ${this.safetyStep}] Holding ${this.amountIn} ${CONFIG.base} at an avg. price of ${this.avgPrice} ${CONFIG.quote}, total spent ${this.quoteSpent} ${CONFIG.quote}`);
                            }
                            catch (err) {
                                console.log(getDate(),"Error placing base order")
                                this.processingSafetyOrder = false;
                                return;
                            }

                            try {
                                targetOrder = await this.exchange.limitSell(this.amountIn, targetPrice, CONFIG.symbolInfo) // Seting target take profit order
                                this.currentOrders.targetOrder = targetOrder;
                                console.log(getDate(), `[Safety Step ${this.safetyStep}] Target Take Profit Order Placed: ${this.currentOrders.targetOrder.price} ${CONFIG.quote}`);    
                            }
                            catch(err) {
                                console.log(getDate(),"Error placing target order")
                                this.processingSafetyOrder = false;
                                return;
                            }

                            try {
                                safetyOrder = await this.exchange.limitBuy(CONFIG.safetyOrderSize, safetyPrice, CONFIG.symbolInfo) // Setting safety order
                                this.currentOrders.safetyOrder = safetyOrder;
                                console.log(getDate(), `[Safety Step ${this.safetyStep}] Safety Order Placed: ${this.currentOrders.safetyOrder.price}`);    
                            }
                            catch(err){
                                console.log(getDate(),"Error placing safety order");
                                this.processingSafetyOrder = false;
                                return;
                            };
                            this.processingSafetyOrder = false;
                        }
                        else if (!this.onHold) {     
                            this.onHold = true;                    
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Out of safety orders, on hold: ${this.amountIn} ${CONFIG.symbol}, spent ${this.quoteSpent} with an average price of ${this.avgPrice}`);
                        }
                    }
                    else if (this.currentOrders.targetOrder && obj.p >= this.currentOrders.targetOrder.price) {
                        this.tradeFinished = true;
                        let result = await this.exchange.getOrderInfo(CONFIG.symbolInfo, this.currentOrders.targetOrder.orderId);
                        result.executedQty = result.executedQty;
                        if (this.safetyStep > 0) {                            
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Sold ${this.amountIn} ${CONFIG.symbol} for ${result.cummulativeQuoteQty} (${((result.cummulativeQuoteQty/this.quoteSpent)-1)*100}%)  [price: ${result.price}]`);
                        }
                        else {
                            console.log(getDate(), `Sold ${this.amountIn} ${CONFIG.symbol} for ${result.cummulativeQuoteQty} (${((result.cummulativeQuoteQty/this.quoteSpent)-1)*100}%)  [price: ${result.price}]`);
                        }
                        this.onHold = false;
                        this.lastPing = new Date().getTime();
                        this.ws.terminate() 
                        this.ws = null;
                        CONFIG.callback(parseFloat(result.cummulativeQuoteQty * CONFIG.feeDown * CONFIG.feeDown) - this.quoteSpent, CONFIG.symbol);
                    }
                }

            }            
        };
    }
}