const ccxt = require('ccxt');
const binance = new ccxt.binance();
const indicators = require('technicalindicators')
const axios = require('axios')


const WebSocket = require('ws');
var markets;
var balance = 0;
var traders = {};
var hasCrossed = false;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const SIMULTANEOUS_REQUESTS = 10;

const FEE = 0.00075;
const FEE_DOWN = 1 - FEE;
const BASE_ORDER_SIZE = 10;
const SAFETY_ORDER_SIZE = 10;
const TARGET_PROFIT = 0.005;
const NUM_SAFETY_ORDERS = 30;
const DEVIATION = 0.01 ;
const STEP_VOLUME_SCALING = 1.05;
  
async function init() {
    let markets = await(await binance.fetchMarkets())
    console.log("Starting Trailing + Safety Trader");
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET_PROFIT);
    let totalQuoteNeeded = 0;
    for (var i = 1; i < NUM_SAFETY_ORDERS + 1; i++) {
        totalQuoteNeeded += SAFETY_ORDER_SIZE * (Math.pow(STEP_VOLUME_SCALING,i));
    }
    console.log(totalQuoteNeeded)
    while (true) {        
        markets = ["ETHBRL"]
        markets.forEach(market => {
            if (!traders.hasOwnProperty(market)) {
                traders[market] = new Trader();
                traders[market].symbol = market;
                traders[market].callback = changeBalance;
                traders[market].init();
            }
        })
        await sleep(1000)
    }
}

function changeBalance(value, symbol) {
    console.log(getDate(),`Removing trader ${symbol}`)
    traders[symbol] = null;
    delete traders[symbol];
    console.log(getDate(),`${Object.keys(traders).length} Traders now running: ${JSON.stringify(Object.keys(traders))}`)    
    balance += value;
    console.log(getDate(),"Balance is now ", balance)
}



init();


class Trader  {

    constructor() {
        this.symbol = ""
        this.amountUsdt =  0
        this.startUsdt = 0
        this.active = false;
        this.amountCoin = 0
        this.data = []
        this.callback = null;
        this.tradeFinished = false;
        this.startTime = new Date();
        this.zombieLoops = 0;
        this.lastPing = 0;
        this.avgPrice = 0;
        this.splitQty = 0;
        this.target = 0;
        this.nextSafetyOrder = 0;
        this.safetyStep = 0;
        this.stepQuoteAmount = 0;
        this.ws = null;
    }    

    init() {
        console.log(getDate(),"Initializing Trader:" , this.symbol)
        var url = "wss://stream.binance.com:9443/ws"
        url += `/${this.symbol.toLowerCase()}@trade`
        this.ws = new WebSocket(url);
        this.ws.onmessage = (event) => {        
            var obj = JSON.parse(event.data);
            this.ping();
            
            if (obj.e == "trade" && !this.tradeFinished) {
                obj.p = parseFloat(obj.p)
                if (!this.active) {
                    // setting main order;
                    this.active = true;                    
                    this.target = obj.p * (1 + TARGET_PROFIT);
                    this.nextSafetyOrder = obj.p * (1 - DEVIATION)
                    this.avgPrice = obj.p;
                    this.quoteSpent = BASE_ORDER_SIZE
                    this.amountCoin = (this.quoteSpent*FEE_DOWN) / obj.p;
                    console.log(getDate(),`Bought ${this.amountCoin} ${this.symbol} with ${BASE_ORDER_SIZE} [price: ${obj.p}]`);
                    console.log(getDate(),`Target: ${this.target}, setting Next Safety Order at ${this.nextSafetyOrder}`);                                     
                } else  {
                    if (obj.p <= this.nextSafetyOrder) {
                        if (this.safetyStep < NUM_SAFETY_ORDERS) {                            
                            this.safetyStep++;   
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Unable to reach current target, triggering Safety Order at ${this.nextSafetyOrder}`);
                            this.stepQuoteAmount = SAFETY_ORDER_SIZE * Math.pow(STEP_VOLUME_SCALING, this.safetyStep - 1);                      
                            var stepQty = this.stepQuoteAmount * FEE_DOWN  / obj.p;
                            this.amountCoin += stepQty; 
                            this.avgPrice = (this.quoteSpent * this.avgPrice) + (this.stepQuoteAmount * obj.p) / (this.quoteSpent + this.stepQuoteAmount)
                            this.quoteSpent += this.stepQuoteAmount
                            this.target = this.avgPrice * (1 + (TARGET_PROFIT));        
                            this.nextSafetyOrder = this.nextSafetyOrder * (1 - DEVIATION)                            
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Bought ${stepQty} ${this.symbol} with ${this.stepQuoteAmount} [price: ${obj.p}]`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Holding ${this.amountCoin} at an avg. price of ${this.avgPrice}, total spent ${this.quoteSpent}`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Target: ${this.target}, setting Next Safety Order at ${this.nextSafetyOrder}`);                            
                        }
                        else {
                            this.tradeFinished = true;
                            var tradeAmount = this.amountCoin * obj.p * FEE_DOWN;
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Leaving position: Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((this.amountUsdt/this.startUsdt)-1)*100}%) ? [price: ${obj.p}]`);
                            this.lastPing = new Date().getTime();
                            this.ws.terminate() 
                            this.ws = null;
                            this.callback(tradeAmount - this.quoteSpent, this.symbol);
                        }
                    }
                    else if (obj.p >= this.target) {
                        this.tradeFinished = true;
                        var tradeAmount = this.amountCoin * obj.p * FEE_DOWN;
                        if (this.safetyStep > 0)
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((tradeAmount/this.quoteSpent)-1)*100}%) ? [price: ${obj.p}]`);
                        else
                            console.log(getDate(), `Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((tradeAmount/this.quoteSpent)-1)*100}%) ? [price: ${obj.p}]`);
                        this.lastPing = new Date().getTime();
                        this.ws.terminate() 
                        this.ws = null;
                        this.callback(tradeAmount - this.quoteSpent, this.symbol);
                    }                   
                    
                }

            }            
        };
    }

    ping() {
        if (this.tradeFinished && this.lastPing) {
            if (new Date().getTime() - this.lastPing >= 10000) {
                this.lastPing = new Date().getTime(); 
                this.zombieLoops++;
                console.log(getDate(),`Trader ${this.symbol} is still running, ${this.zombieLoops} loops`);
            }
        }
    }
}

function getDate() {
    var d = new Date();
    var month = d.getMonth() + 1 ;
    month = month > 9 ? month : "0" + month;
    var day = d.getDate() > 9 ? d.getDate() : "0" + d.getDate();
    var hours = d.getHours() > 9 ? d.getHours() : "0" + d.getHours();
    var minutes = d.getMinutes() > 9 ? d.getMinutes() : "0" + d.getMinutes();
    var seconds = d.getSeconds() > 9 ? d.getSeconds() : "0" + d.getSeconds();
    return `[ ${d.getFullYear()}/${month}/${day} ${hours}:${minutes}:${seconds} ] `;
}
