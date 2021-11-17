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
const INTERVAL = "1m"
const NUM_SAFETY_ORDERS = 30;
const EMA_FAST = 10;
const EMA_MID = 25;
const EMA_SLOW = 50
const FEE = 0.00075;
const FEE_UP = 1 + FEE;
const FEE_DOWN = 1 - FEE;
const TARGET = 0.01; 
const DEVIATION = 0.01;
const STEP_SCALING = 1.005;

function fetchKline(symbol) {
    return  axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=1000`)
    .then(function (response) {
        var data = response.data;
        data = data.map(item => ({value: item[4], time: item[6]}));
        data.pop(); //removes last candle (not closed)
        return data;
    })
    .catch(function (error) {

        console.log(getDate(),error);
    })
}  

async function fetchMarkets() {
    let markets = await(await binance.fetchMarkets())
        .filter(item => item.type == "spot")
        .filter(item => item.active = true)
        .filter(item => item.info.status == "TRADING")
        .filter(item => item.quoteId.indexOf("USDT") >= 0)
        .filter( item => item.symbol != "BTC/USDT")
        .filter(item => item.spot == true)
        .map(item => item.symbol)
    let tickers = await binance.fetchTickers(markets);
    tickers = Object.keys(tickers).map( item => {
        return tickers[item]
    }).filter(item => {
        return item.quoteVolume > 50000000
    }).map(item => {
        return item.info.symbol
    })
    return  axios.post(`https://scanner.tradingview.com/crypto/scan`, {"filter":[{"left":"exchange","operation":"equal","right":"BINANCE"}],"columns":["name","Recommend.All"], "sort":{"sortBy":"Recommend.All","sortOrder":"desc"}})
    .then(function (response) {
        var responseMarkets = response.data.data;
        responseMarkets = responseMarkets.filter(item => {
            return (tickers.indexOf(item.d[0]) >= 0) && (item.s.indexOf("PREMIUM") == -1) && (item.d[1] != null)
        })
        return responseMarkets
    })
    .catch(function (error) {

        console.log(getDate(),error);
        return fetchMarkets();
    })
    
}
async function fetchRecommendation(symbol) {
    return  axios.post(`https://scanner.tradingview.com/crypto/scan`, {"filter":[{"left":"exchange","operation":"equal","right":"BINANCE"},{"left":"name,description","operation":"equal","right":symbol}],"columns":["name","Recommend.All"]})
    .then(function (response) {
        return response.data;
    })
    .catch(function (error) {

        console.log(getDate(),error);
    })
}
  
async function init() {
    var symbolData = {};
    var pending = [];
    var url = "";    
    console.log("Starting Trailing + Safety Trader");
    console.log("Candle interval: ", INTERVAL);
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET);
    
    console.log(getDate(),"Fetching data from tradingview")
    while(true) {        
        if (Object.keys(traders) < 1) {
            var markets = await fetchMarkets();
            console.log("Top Recommendations")
            console.log(markets.slice(0,10));
            var best = markets[0].d;
            traders[best[0]] = new Trader();
            traders[best[0]].symbol = best[0];
            traders[best[0]].amountUsdt = 100;
            traders[best[0]].interval = INTERVAL;
            traders[best[0]].startUsdt = traders[best[0]].amountUsdt;
            traders[best[0]].callback = changeBalance;                
            console.log(getDate(),`Market ${best[0]} recommendation: ${best[1]}`);
            traders[best[0]].init();
        }
        await sleep(30000)

        /*for (var market of markets) {
            var recommendationData = await fetchRecommendation(market);
            let recommendation = recommendationData.data[0].d[1];
            if (recommendation > 0 && !traders.hasOwnProperty(market)) {
                hasCrossed = true;
                traders[market] = new Trader();
                traders[market].symbol = market;
                traders[market].amountUsdt = 100;
                traders[market].interval = INTERVAL;
                traders[market].startUsdt = traders[market].amountUsdt;
                traders[market].callback = changeBalance;                
                console.log(getDate(),`Market recommendation: ${recommendation}`);
                traders[market].init();
            //}
            }
        }*/
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
        this.buyPrice = 0;
        this.avgPrice = 0;
        this.splitQty = 0;
        this.target = 0;
        this.nextSafetyOrder = 0;
        this.safetyStep = 0;
        this.ws = null;
    }    

    init() {
        console.log(getDate(),"Initializing Trader:" , this.symbol, "with: ", this.amountUsdt )
        var url = "wss://stream.binance.com:9443/ws"
        url += `/${this.symbol.toLowerCase()}@kline_${INTERVAL}`
        url += `/${this.symbol.toLowerCase()}@trade`
        this.ws = new WebSocket(url);
        this.ws.onmessage = (event) => {        
            var obj = JSON.parse(event.data);
            this.ping();
            
            if (obj.e == "kline") {
                obj = obj.k;
                if (obj.x) {
                    this.data.push(obj.c);                  
                }
            }
            else if (obj.e == "trade" && !this.tradeFinished) {
                obj.p = parseFloat(obj.p)
                if (!this.active) {
                    // setting main order;
                    this.active = true;
                    this.splitQty = Math.floor(this.amountUsdt/NUM_SAFETY_ORDERS);
                    this.amountCoin = (this.splitQty*FEE_DOWN) / obj.p;
                    this.amountUsdt -= this.splitQty;   
                    this.target = obj.p * (1 + TARGET);
                    this.nextSafetyOrder = obj.p * (1 - DEVIATION)
                    this.avgPrice = obj.p;
                    console.log(getDate(),`Bought ${this.amountCoin} ${this.symbol} with ${this.splitQty} [price: ${obj.p}]`);
                    console.log(getDate(),`Target: ${this.target}, setting Next Safety Order at ${this.nextSafetyOrder}`);                                     
                } else  {
                    if (obj.p <= this.nextSafetyOrder) {
                        if (this.safetyStep < NUM_SAFETY_ORDERS) {                            
                            this.safetyStep++;   
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Unable to reach current target, triggering next Safety Order at ${this.nextSafetyOrder}`);                         
                            var stepQty = (this.splitQty*FEE_DOWN) / obj.p;
                            this.amountCoin += stepQty;
                            this.amountUsdt -= this.splitQty;
                            this.avgPrice = ((this.avgPrice*this.safetyStep) + obj.p) / (this.safetyStep + 1);                              
                            let step = TARGET/NUM_SAFETY_ORDERS;
                            this.target = this.avgPrice * (1 + (TARGET - (step*this.safetyStep)));        
                            this.nextSafetyOrder = this.nextSafetyOrder * (1 - DEVIATION * STEP_SCALING)                            
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Bought ${stepQty} ${this.symbol} with ${this.splitQty} [price: ${obj.p}]`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Target % at ${(1 + (TARGET - (step*this.safetyStep)))}`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Holding ${this.amountCoin} at an avg. price of ${this.avgPrice}, total spent ${this.splitQty}`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Target: ${this.target}, setting Next Safety Order at ${this.nextSafetyOrder}`);                            
                        }
                        else {
                            this.tradeFinished = true;
                            var tradeAmount = this.amountCoin * obj.p * FEE_DOWN;
                            this.amountUsdt += tradeAmount;
                            console.log(getDate(),`[Safety Step ${this.safetyStep}] Leaving position: Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((this.amountUsdt/this.startUsdt)-1)*100}%) ? [price: ${obj.p}]`);
                            this.lastPing = new Date().getTime();
                            this.ws.terminate() 
                            this.ws = null;
                            this.callback(this.amountUsdt - this.startUsdt, this.symbol);
                        }
                    }
                    else if (obj.p >= this.target) {
                        this.tradeFinished = true;
                        var tradeAmount = this.amountCoin * obj.p * FEE_DOWN;
                        this.amountUsdt += tradeAmount;
                        if (this.safetyStep > 0)
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((this.amountUsdt/this.startUsdt)-1)*100}%) ? [price: ${obj.p}]`);
                        else
                            console.log(getDate(), `Sold ${this.amountCoin} ${this.symbol} for ${tradeAmount} (${((this.amountUsdt/this.startUsdt)-1)*100}%) ? [price: ${obj.p}]`);
                        this.lastPing = new Date().getTime();
                        this.ws.terminate() 
                        this.ws = null;
                        this.callback(this.amountUsdt - this.startUsdt, this.symbol);
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
