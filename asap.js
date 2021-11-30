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
  // ctrl-c ( end of text )
});
var args = process.argv.slice(2);
var base = args[0];
var quote = args[1];
var cfgfile = args[2]
var balance = 0;
var traders = {};
var halt = false;


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

const FEE = data.fee;
const TARGET_PROFIT = data.target_profit
const NUM_SAFETY_ORDERS = data.num_safety_orders
const DEVIATION = data.deviation
const STEP_VOLUME_SCALING = data.step_volume_scaling;
const BASE_ORDER_SIZE = data.base_order_size;
const SAFETY_ORDER_SIZE = data.safety_order_size;
const DIRECTION = data.direction;

async function init() {
    let markets = []
    console.log("Starting Safety Trader");
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET_PROFIT);
    console.log("Type:", DIRECTION)
    let totalQuoteNeeded = 0;
    for (var i = 1; i < NUM_SAFETY_ORDERS + 1; i++) {
        totalQuoteNeeded += SAFETY_ORDER_SIZE * (Math.pow(STEP_VOLUME_SCALING,i));
    }
    if (DIRECTION == "LONG")
        console.log("Total quote needed for all safety orders: ", totalQuoteNeeded, args[1])
    if (DIRECTION == "SHORT")
        console.log("Total base needed for all safety orders: ", totalQuoteNeeded, args[0]);
    while (true) {        
        markets = [args[0]+args[1]]
        markets.forEach(market => {
            if (!traders.hasOwnProperty(market) && !halt) {
                traders[market] = new Trader();
                traders[market].config = new Config(
                    base,
                    quote,
                    DIRECTION,
                    FEE,
                    BASE_ORDER_SIZE,
                    NUM_SAFETY_ORDERS,
                    TARGET_PROFIT,
                    DEVIATION,
                    STEP_VOLUME_SCALING,
                    changeBalance
                );
                traders[market].init();
            }
            else if (!traders.hasOwnProperty(market) && halt) {
                console.log(getDate(), "Trading ended by request, balance: ", balance)
                process.exit();
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






