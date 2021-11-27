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
const NUM_SAFETY_ORDERS = 3;
const EMA_FAST = 10;
const EMA_MID = 25;
const EMA_SLOW = 50
const RSI_OVERSOLD = 20;
const RSI_OVERBOUGHT = 70;
const FEE = 0.00075;
const FEE_UP = 1 + FEE;
const FEE_DOWN = 1 - FEE;
const TARGET = 0.004; 
const DEVIATION = 0.002;

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
  
async function init() {
    var symbolData = {};
    var pending = [];
    var url = "";    

    console.log("Starting Trailing + Safety Trader");
    console.log("Candle interval: ", INTERVAL);
    console.log("Running RSI trader");
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET);

    markets = await(await binance.fetchMarkets())
        .filter(item => item.type == "spot")
        .filter(item => item.active = true)
        .filter(item => item.info.status == "TRADING")
        .filter(item => item.symbol.indexOf("USDT") >= 0)
        .filter( item => item.symbol != "BTC/USDT")
        .filter(item => item.spot == true)
        .map(item => item.info.symbol)
    
    markets = ["ETHUSDT"]

    //console.log(getDate(),"Found ", markets.length, " pairs")

    url = "wss://stream.binance.com:9443/ws";
   
    markets.forEach(item => {
        url += `/${item.toLowerCase()}@kline_${INTERVAL}`;
    })
    
    console.log(getDate(),"Fetching market data ", markets.length, " pairs")
    for(let i = 0; i < markets.length; i++){
        let symbol = markets[i];
        if (pending.length < SIMULTANEOUS_REQUESTS) {
            pending.push(
                fetchKline(symbol).then(data => {
                    symbolData[symbol] = data;                    
                }).catch(err => {
                    console.log(getDate(),symbol, err)
                })
            )
        } 
        if (pending.length == SIMULTANEOUS_REQUESTS || i == markets.length-1) {
            await Promise.all(pending).then( async(data) => {
                pending = [];
            });                
        }
    };
    console.log(getDate(),"Listening for websocket data")
    const ws = new WebSocket(url);
    ws.onmessage = (event) => {        
        const obj = JSON.parse(event.data).k;
        if (obj.x) {
            symbolData[obj.s].push({value:obj.c, time: obj.T}); 
           
            var data = symbolData[obj.s].map( item => parseFloat(item.value));         
            let rsiInput = {
                values: data,
                period: 14
            }
            var result = indicators.RSI.calculate(rsiInput).reverse()[0]            
            if (result < RSI_OVERSOLD && !traders.hasOwnProperty(obj.s)) {   
                if (!hasCrossed) {
                    hasCrossed = true;
                    traders[obj.s] = new Trader();
                    traders[obj.s].symbol = obj.s;
                    traders[obj.s].amountUsdt = 100;
                    traders[obj.s].data = data;
                    traders[obj.s].interval = INTERVAL;
                    traders[obj.s].startUsdt = traders[obj.s].amountUsdt;
                    traders[obj.s].callback = changeBalance;                
                    console.log(getDate(),`RSI condition is favourable: ${fastValue}`);
                    traders[obj.s].init();
                }
            }
            else {
                if (hasCrossed) {
                    hasCrossed = false;
                }
            }
        }
    };
        
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
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Bought ${this.amountCoin} ${this.symbol} with ${this.splitQty} [price: ${obj.p}]`);
                            this.target *= (1 - DEVIATION);
                            this.nextSafetyOrder = obj.p * (1 - DEVIATION)
                            this.avgPrice = ((this.avgPrice*this.safetyStep) + obj.p) / (this.safetyStep + 1);                            
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Holding ${this.amountCoin} at an avg. price of ${this.avgPrice}, total spent ${this.splitQty}`);
                            console.log(getDate(), `[Safety Step ${this.safetyStep}] Target: ${this.target}, setting Next Safety Order at ${this.nextSafetyOrder}`);                            
                        }
                        else {
                            this.tradeFinished = true;
                        var tradeAmount = this.amountCoin * obj.p * 0.99925;
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
                        var tradeAmount = this.amountCoin * obj.p * 0.99925;
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
