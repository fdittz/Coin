const ccxt = require('ccxt');
const binance = new ccxt.binance();
const indicators = require('technicalindicators')
const axios = require('axios')


const WebSocket = require('ws');
var markets;
var balance = 0;
var traders = {};



function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const INTERVAL = "5m"
const SIMULTANEOUS_REQUESTS = 10;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;


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

    console.log("Starting RSI Trader");
    console.log("Candle interval: ", INTERVAL);
    console.log("RSI Oversold threshold", RSI_OVERSOLD);
    console.log("RSI Overbought threshold", RSI_OVERBOUGHT);

    markets = await(await binance.fetchMarkets())
        .filter(item => item.type == "spot")
        .filter(item => item.active = true)
        .filter(item => item.info.status == "TRADING")
        .filter(item => item.symbol.indexOf("USDT") >= 0)
        .filter( item => item.symbol != "BTC/USDT")
        .filter(item => item.spot == true)
        .map(item => item.info.symbol)
    //markets = ["ETHUSDT"]
    console.log(getDate(),"Found ", markets.length, " pairs")

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
           
            var data = symbolData[obj.s].map( item => item.value);
            let rsiInput = {
                values: data,
                period: 14
            }
            var result = indicators.RSI.calculate(rsiInput).reverse()[0]            
            if (result < RSI_OVERSOLD && !traders.hasOwnProperty(obj.s)) {                
                traders[obj.s] = new Trader();
                traders[obj.s].symbol = obj.s;
                traders[obj.s].amountUsdt = 10;
                traders[obj.s].data = data;
                traders[obj.s].interval = INTERVAL;
                traders[obj.s].startUsdt = traders[obj.s].amountUsdt;
                traders[obj.s].callback = changeBalance;                
                console.log(getDate(),"RSI for ", obj.s, " is ", result);
                traders[obj.s].init();
                

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
        this.interval = "15m"
        this.amountCoin = 0
        this.data = []
        this.callback = null;
        this.tradeFinished = false;
        this.startTime = new Date();
        this.zombieLoops = 0;
        this.lastPing = 0;
        this.buyPrice
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
                if (this.amountCoin == 0) {
                    this.amountCoin = (this.amountUsdt*0.99925) / obj.p;
                    console.log(getDate(),`bought ${this.amountCoin} ${this.symbol} with ${this.amountUsdt} [price: ${obj.p}]`);
                    this.amountUsdt = 0;                    
                } else  {
                    let rsiInput = {
                        values: this.data,
                        period: 14
                    }
                    var rsi = (indicators.RSI.calculate(rsiInput).reverse()[0]);
                    if (rsi >= RSI_OVERBOUGHT) {
                        this.amountUsdt = this.amountCoin * obj.p * 0.99925;
                        console.log(getDate(),`sold ${this.amountCoin} ${this.symbol} for ${this.amountUsdt} (${(this.amountUsdt - 10)*100}%) ? [price: ${obj.p}]`);
                        this.tradeFinished = true;
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
