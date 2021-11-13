const async = require('async');
const rsi = require('trading-indicator').rsi
const ccxt = require('ccxt');
const talib = require('talib');
const binance = new ccxt.binance();
const Queue = require('async-await-queue');



const myq = new Queue(20, 100);

const myPriority = -1; 

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
async function moin() {
   // (await    binance.loadMarkets())
   var markets = await(await binance.fetchMarkets()).filter(item => item.symbol.indexOf("USDT") >= 0).filter( item => item.symbol != "BTC/USDT").filter(item => item.spot == true).map(item => item.symbol)
    //var markets = (await binance.fetchMarkets()).filter(item => item.symbol.indexOf("USDT") >= 0);
   // console.log(markets)

   /* var q = async.queue(function(task, callback) {
        getRsi(task)
    }, markets.length)
    
    q.drain = function() {
        console.log('all items have been processed');
    }*/
    await sleep(11000);
    var i = 0;
    var pending = []
   for(let symbol of markets){
        if (pending.length < 10) {
            pending.push(
                getRsi(symbol).then(data => {
                    console.log(  symbol + ": " + data.reverse().slice(0,2));
                }).catch(err => {
                    console.log(symbol, err)
                })
            )
            console.log(pending.length)
        } 
        if (pending.length == 10) {
            var startDate = new Date();
            await Promise.all(pending).then( async(data) => {
                var endDate   = new Date();
                var ms = (endDate.getTime() - startDate.getTime())
                if (ms < 11000) {
                    console.log("Waiting for", 11000 - ms, "ms to perform next batch");
                    await sleep(10000);
                }
                pending = [];
            })
        }

       

       await sleep(110);

    };
    /*var symbol = "ETH/USDT"
    getRsi(symbol).then(data => {
        console.log(  symbol + data.reverse().slice(0,2));
    }).catch(err => {
        console.log(symbol , err)
    });*/

}

async function getRsi(symbol) {
     return rsi(14, "close", "binance", symbol, "15m", false);
}

async function main() {
    
}
moin();




