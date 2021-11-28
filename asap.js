const Config = require('./config.js')
const Trader = require('./trader.js')
const getDate = require('./util.js');


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

var balance = 0;
var traders = {};
var halt = false;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const FEE = 0.00075;
const BASE_ORDER_SIZE = 10;
const SAFETY_ORDER_SIZE = 10;
const TARGET_PROFIT = 0.005; //0.005
const NUM_SAFETY_ORDERS = 15;
const DEVIATION = 0.01 ; //0.01
const STEP_VOLUME_SCALING = 1.05;

/*const FEE = 0.00075;
const BASE_ORDER_SIZE = 0.0005;
const SAFETY_ORDER_SIZE = 0.0005;
const TARGET_PROFIT = 0.005; //0.005
const NUM_SAFETY_ORDERS = 15;
const DEVIATION = 0.01 ; //0.01
const STEP_VOLUME_SCALING = 1.05;
  */
async function init() {
    let markets = []
    console.log("Starting Safety Trader");
    console.log("Safety Orders:", NUM_SAFETY_ORDERS)
    console.log("Target Stop: ", TARGET_PROFIT);
    let totalQuoteNeeded = 0;
    for (var i = 1; i < NUM_SAFETY_ORDERS + 1; i++) {
        totalQuoteNeeded += SAFETY_ORDER_SIZE * (Math.pow(STEP_VOLUME_SCALING,i));
    }
    console.log(totalQuoteNeeded)
    while (true) {        
        markets = [args[0]+args[1]]
        markets.forEach(market => {
            if (!traders.hasOwnProperty(market) && !halt) {
                traders[market] = new Trader();
                traders[market].config = new Config(
                    base,
                    quote,
                    "LONG",
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






