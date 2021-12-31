const Config = require('./config.js')
const Trader = require('./trader.js')
const getDate = require('./util.js');
const fs = require('fs');


var stdin = process.stdin;

// without this, we would only get streams once enter is pressed
stdin.setRawMode( true );


// i don't want binary, do you?
stdin.setEncoding( 'utf8' );

// on any data into stdin
stdin.on( 'data', function( key ){
    // ctrl-c ( end of text )
    if ( key === '\u0003' ) {
        process.exit();
    }
    if ( key === '\u0014') {
        if (!halt) {
            console.log(getDate(), "Halt requested, finishing active trades and then closing");
            halt = true 
        }
        else {
            console.log(getDate(), "Halt cancelled");
            halt = false 
        }
    }
    if ( key === '\u0004') {
        if (!debug) {
            console.log(getDate(), "Trade Debug mode ON");
            debug = true;
            Object.keys(traders).forEach(key => {
                traders[key].debug = true;
            })
        }
        else {
            console.log(getDate(), "Trade Debug mode OFF");
            debug = false;
            Object.keys(traders).forEach(key => {
                traders[key].debug = false;
            })
        }
    }
  // ctrl-c ( end of text )
});
var args = process.argv.slice(2);
var cfgfile = args[0]
var balance = 0;
var traders = {};
var halt = false;
var debug = false;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

var data = {}
try {
    data = JSON.parse(fs.readFileSync(cfgfile));
}
catch(err) {
    console.error("Error loading cfg file", err)
    process.exit()
}

const NAME = data.name;
const BASE = data.base;
const QUOTE = data.quote;
const FEE = data.fee;
const TARGET_PROFIT = data.targetProfit
const NUM_SAFETY_ORDERS = data.numSafetyOrders
const DEVIATION = data.deviation
const STEP_VOLUME_SCALING = data.stepVolumeScaling;
const BASE_ORDER_SIZE = data.baseOrderSize;
const SAFETY_ORDER_SIZE = data.safetyOrderSize;
const DIRECTION = data.direction;
const COMMISSION_SYMBOL = data.commissionSymbol;
const COMMISSION_CURRENCY = data.commissionCurrency;

async function init() {
    let markets = []
    console.log("Starting Safety Trader");
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET_PROFIT);
    console.log("Type:", DIRECTION)
    let totalAssetNeeded = 0;
    for (var i = 1; i < NUM_SAFETY_ORDERS + 1; i++) {
        totalAssetNeeded += SAFETY_ORDER_SIZE * (Math.pow(STEP_VOLUME_SCALING,i));
    }
    if (DIRECTION == "LONG")
        console.log("Total quote needed for all safety orders: ", totalAssetNeeded, QUOTE)
    if (DIRECTION == "SHORT" || DIRECTION == "SHORT-QUOTE")
        console.log("Total base needed for all safety orders: ", totalAssetNeeded, BASE);
    while (true) {        
        markets = [BASE+QUOTE]
        markets.forEach(market => {
            if (!traders.hasOwnProperty(market) && !halt) {
                traders[market] = new Trader(NAME);
                traders[market].config = new Config(
                    BASE,
                    QUOTE,
                    DIRECTION,
                    FEE,
                    BASE_ORDER_SIZE,
                    NUM_SAFETY_ORDERS,
                    TARGET_PROFIT,
                    DEVIATION,
                    STEP_VOLUME_SCALING,
                    changeBalance,
                    COMMISSION_SYMBOL,
                    COMMISSION_CURRENCY
                );
                traders[market].init();
            }
            else if (!traders.hasOwnProperty(market) && halt) {
                console.log(getDate(), "Trading ended by request, balance: ", balance)
                process.exit();
            }
        })
        if (Object.keys(traders).length > 1) {
            console.log(`WARNING, ${Object.keys(traders).length} traders running!`);
        }
        await sleep(1000);
    }
}

function changeBalance(value, symbol) {
    console.log(getDate(),`Removing trader ${symbol}: ${hash(traders[symbol])}`)
    traders[symbol] = null;
    delete traders[symbol];
    console.log(getDate(),`${Object.keys(traders).length} Traders now running: ${JSON.stringify(Object.keys(traders))}`)    
    balance += value;
    console.log(getDate(),"Balance is now ", balance)
}

init();






