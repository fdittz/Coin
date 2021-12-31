const crypto = require("crypto");
const axios = require('axios').default;
const querystring = require('querystring');
const auth = require('../keys/binancekey');


class Binance {

    async privateCall(path, data = {}, method = 'GET') {
        if (!auth.apiKey || !auth.apiSecret)
            throw new Error('Preencha corretamente sua API KEY e SECRET KEY');
     
        const timestamp = Date.now();
        const recvWindow = 60000;//máximo permitido, default 5000
        
        const signature = crypto
            .createHmac('sha256', auth.apiSecret)
            .update(`${querystring.stringify({ ...data, timestamp, recvWindow })}`)
            .digest('hex');
     
        const newData = { ...data, timestamp, recvWindow, signature };
        const qs = `?${querystring.stringify(newData)}`;
     
        try {
            const result = await axios({
                method,
                url: `https://api.binance.com/api${path}${qs}`,
                headers: { 'X-MBX-APIKEY': auth.apiKey }
            });
            return result.data;
        } catch (err) {
            console.log(err.response.data);
            return err;
        }
    }

    async publicCall(path, data = {}, method = 'GET') {
        const qs = `?${querystring.stringify(data)}`;
        try {
            const result = await axios({
                method,
                url: `https://api.binance.com/api${path}${qs}`,
            });
            return result.data;
        } catch (err) {
            console.log(err.response.data);
            return err;
        }
    }

    async exchangeInfo(symbol) {
        return await this.publicCall("/v3/exchangeInfo",{symbol: symbol}).then(res =>{
            return res.symbols[0];
        }).catch(async (err) => {
            console.log(err)
            return await this.exchangeInfo(symbol);
        });
    }

    async marketBuyBase(quantity, symbolInfo, price, bnbValue) {
        if (this.isMarketBuy)
            return new Promise((resolve, reject) => reject("Already placing a market buy order"));
        this.isMarketBuy = true;
        const lotSize = symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0];
        const lotStepSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.stepSize)[0]);
        const lotPrecisionMult = 1/lotSize;
        const lotPrecision = lotSize.slice(lotSize.indexOf(".")).indexOf(1)
        quantity = Math.round(quantity * lotPrecisionMult) / lotPrecisionMult;
        quantity = quantity.toFixed(lotPrecision);
        let data = {
            symbol:symbolInfo.symbol,
            side:"buy",
            type:"MARKET",
            quantity: quantity,
        }

        return new Promise((resolve, reject) => {
            this.isMarketBuy = false;
            resolve(
                {
                    symbol: 'ETHBUSD',
                    orderId: Math.floor(Math.random() * 65535),
                    orderListId: -1,
                    clientOrderId: 'r0OMqsASU0B9hIzAnHFYlU',
                    transactTime: 1639677605314,
                    price: price,
                    origQty: quantity,
                    executedQty: quantity,
                    cummulativeQuoteQty: quantity * price,
                    status: 'FILLED',
                    timeInForce: 'GTC',
                    type: 'MARKET',
                    side: 'BUY',
                    fills: [
                      {
                        price: price,
                        qty: quantity,
                        commission: (quantity * price) * 0.9925 * bnbValue,
                        commissionAsset: 'BNB',
                        tradeId: 243054534
                      }
                    ]
                  }
            )
        })
    }


    async marketBuy(toSpend, price, symbolInfo, bnbValue) {
        if (this.isMarketBuy)
            return new Promise((resolve, reject) => reject("Already placing a market buy order"));
        this.isMarketBuy = true;
        const minNotional = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'MIN_NOTIONAL').map(item => item.minNotional)[0]);
        const priceSize = symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0];
        const pricePrecision = priceSize.slice(priceSize.indexOf(".")).indexOf(1)
        const lotSize = symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0];
        const lotStepSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.stepSize)[0]);
        let lotPrecision = lotSize.slice(lotSize.indexOf(".")).indexOf(1)
        price = price.toFixed(pricePrecision)
        if (toSpend < minNotional) {
            toSpend = minNotional;
        }
        let quantity = parseFloat((toSpend/price).toFixed(lotPrecision));        
        while ( quantity * price < minNotional) {
            quantity = parseFloat(quantity) + lotStepSize;            
        }
        quantity = parseFloat(quantity).toFixed(lotPrecision);
        let data = {
            symbol:symbolInfo.symbol,
            side:"buy",
            type:"MARKET",
            quantity: quantity,
        }
        return new Promise((resolve, reject) => {
            this.isMarketBuy = false;
            resolve(
                {
                    symbol: 'ETHBUSD',
                    orderId: Math.floor(Math.random() * 65535),
                    orderListId: -1,
                    clientOrderId: 'r0OMqsASU0B9hIzAnHFYlU',
                    transactTime: 1639677605314,
                    price: price,
                    origQty: quantity,
                    executedQty: quantity,
                    cummulativeQuoteQty: quantity * price,
                    status: 'FILLED',
                    timeInForce: 'GTC',
                    type: 'MARKET',
                    side: 'BUY',
                    fills: [
                      {
                        price: price,
                        qty: quantity,
                        commission: (quantity * price) * 0.9925 * bnbValue,
                        commissionAsset: 'BNB',
                        tradeId: 243054534
                      }
                    ]
                  }
            )
        })
    }

    async limitBuy(toSpend, price, symbolInfo) {
        const minNotional = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'MIN_NOTIONAL').map(item => item.minNotional)[0]);
        const priceSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0]);
        const pricePrecisionMult = 1/priceSize;
        const lotSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0]);
        const lotStepSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.stepSize)[0]);
        let lotPrecisionMult = 1/lotSize;
        price = Math.floor(price * pricePrecisionMult) / pricePrecisionMult;        
        let quantity = parseFloat((toSpend/price).toFixed(symbolInfo.baseAssetPrecision));        
        quantity = Math.ceil(quantity * lotPrecisionMult) / lotPrecisionMult;
        while ( quantity * price < minNotional) 
            quantity += lotStepSize;
        let data = {
            symbol:symbolInfo.symbol,
            side:"buy",
            type:"LIMIT",
            quantity: quantity,
            price: price,
            timeInForce: 'GTC'
        }
        return new Promise((resolve, reject) => {
            resolve(
                {
                    "symbol": data.symbol,
                    "orderId": Math.floor(Math.random() * 65535),
                    "orderListId": -1, //Unless OCO, value will be -1
                    "clientOrderId": "6gCrw2kRUAF9CvJDGP16IP",
                    "transactTime": new Date().getTime(),
                    "price": data.price,
                    "origQty": data.quantity,
                    "executedQty": data.quantity,
                    "cummulativeQuoteQty": data.quantity,
                    "status": "FILLED",
                    "timeInForce": "GTC",
                    "type": "LIMIT",
                    "side": "BUY"
                }
            )
        })
    }

    async marketSell(toSell, price, symbolInfo, bnbValue) {
        if (this.isMarketSell)
            return new Promise((resolve, reject) => reject("Already placing a market sell order"));
        this.isMarketSell = true;
        const minNotional = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'MIN_NOTIONAL').map(item => item.minNotional)[0]);
        const priceSize = symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0];
        const pricePrecision = priceSize.slice(priceSize.indexOf(".")).indexOf(1)
        const lotSize = symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0];
        const lotStepSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.stepSize)[0]);
        let lotPrecision = lotSize.slice(lotSize.indexOf(".")).indexOf(1)
        price = price.toFixed(pricePrecision)
        toSell = toSell.toFixed(lotPrecision);
        while ( toSell * price < minNotional) {
            toSell = parseFloat(toSell) + lotStepSize;          
        }
        toSell = parseFloat(toSell).toFixed(lotPrecision);
        let data = {
            symbol:symbolInfo.symbol,
            side:"sell",
            type:"MARKET",
            quantity: toSell,
        }
        return new Promise((resolve, reject) => {
            this.isMarketSell = false;
            resolve(
                {
                    symbol: data.symbol,
                    orderId: Math.floor(Math.random() * 65535),
                    orderListId: -1,
                    clientOrderId: 'pPCc1PgS3wLG4ccyVGz3YZ',
                    transactTime: 1639668636953,
                    price:  price,
                    origQty: data.quantity,
                    executedQty: data.quantity,
                    cummulativeQuoteQty: data.quantity * price,
                    status: 'FILLED',
                    timeInForce: 'GTC',
                    type: 'MARKET',
                    side: 'SELL',
                    fills: [
                      {
                        price: price,
                        qty: data.quantity,
                        commission: (data.quantity * price) * 0.9925 * bnbValue,
                        commissionAsset: 'BNB',
                        tradeId: 242992998
                      }
                    ]
                  }
            )
        })        
    }

    async limitSell(toSell, price, symbolInfo) {
        const priceSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0]);
        const pricePrecisionMult = 1/priceSize;
        const lotSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0]);
        let lotPrecisionMult = 1/lotSize;        
        price = Math.floor(price * pricePrecisionMult) / pricePrecisionMult;
        toSell = Math.ceil(toSell * lotPrecisionMult) / lotPrecisionMult;  
        let data = {
            symbol:symbolInfo.symbol,
            side:"sell",
            type:"LIMIT",
            quantity: parseFloat(toSell),
            price: price,
            timeInForce: 'GTC'
        }
        return new Promise((resolve, reject) => {
            resolve(
                {
                    "symbol": data.symbol,
                    "orderId": Math.floor(Math.random() * 65535),
                    "orderListId": -1, //Unless OCO, value will be -1
                    "clientOrderId": "6gCrw2kRUAF9CvJDGP16IP",
                    "transactTime": new Date().getTime(),
                    "price": data.price,
                    "origQty": data.quantity,
                    "executedQty": data.quantity,
                    "cummulativeQuoteQty": data.quantity,
                    "status": "FILLED",
                    "timeInForce": "GTC",
                    "type": "LIMIT",
                    "side": "BUY"
                }
            )
        })
    }

    async cancelAllOrders(symbolInfo) {
        let data = {
            symbol:symbolInfo.symbol,
        }
        return this.privateCall("/v3/openOrders", data, 'DELETE')
    }

    async cancelOrder(symbolInfo, orderId) {
        let data = {
            symbol:symbolInfo.symbol,
            orderId: orderId
        }
        return new Promise((resolve, reject) => {
            resolve(
                {
                    "symbol": data.symbol,
                    "orderId": data.orderId,
                    "orderListId": -1, //Unless OCO, value will be -1
                    "clientOrderId": "6gCrw2kRUAF9CvJDGP16IP",
                    "transactTime": new Date().getTime(),
                    "price": "11",
                    "origQty": "11",
                    "executedQty": "11",
                    "cummulativeQuoteQty": "11",
                    "status": "FILLED",
                    "timeInForce": "GTC",
                    "type": "LIMIT",
                    "side": "BUY"
                }
            )
        })
    }

    async getOrderInfo(symbolInfo, orderId) {
        let data = {
            symbol:symbolInfo.symbol,
            orderId: orderId
        }
        return new Promise((resolve, reject) => {
            resolve(
                {
                    "symbol": data.symbol,
                    "orderId": Math.floor(Math.random() * 65535),
                    "orderListId": -1, //Unless OCO, value will be -1
                    "clientOrderId": "6gCrw2kRUAF9CvJDGP16IP",
                    "transactTime": new Date().getTime(),
                    "price": 11,
                    "origQty": 11,
                    "executedQty": 11,
                    "cummulativeQuoteQty": 11,
                    "status": "FILLED",
                    "timeInForce": "GTC",
                    "type": "LIMIT",
                    "side": "BUY"
                }
            )
        })
    }

    convertNumbersToFloat(order) {
        order.price ? order.price = parseFloat(order.price) : "";
        order.origQty ? order.origQty = parseFloat(order.origQty) : "";
        order.executedQty ? order.executedQty = parseFloat(order.executedQty) : "";
        order.cummulativeQuoteQty ? order.cummulativeQuoteQty = parseFloat(order.cummulativeQuoteQty) : "";
        order.fills && order.fills.length > 0 ? order.fills = order.fills.map(fill => {
            fill.price ? fill.price = parseFloat(fill.price) : "";
            fill.qty ? fill.qty = parseFloat(fill.qty) : "";
            fill.commission ? fill.commission = parseFloat(fill.commission) : "";
            return fill;
        }) : "";
        return order;
    }

}



class Singleton {

    constructor() {
        if (!Singleton.instance) {
            Singleton.instance = new Binance();
        }
    }
  
    getInstance() {
        return Singleton.instance;
    }
  
  }
  
  module.exports = Singleton;