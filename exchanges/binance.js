const crypto = require("crypto");
const axios = require('axios').default;
const querystring = require('querystring');
const auth = require('../keys/binancekey');


module.exports = class Binance {

    isMarketBuy = false;
    isMarketSell = false;

    async privateCall(path, data = {}, method = 'GET') {
        if (!auth.apiKey || !auth.apiSecret)
            throw new Error('You need to fill your API KEY and SECRET KEY');
     
        const timestamp = Date.now();
        const recvWindow = 60000; // max allowed, default 5000;
        
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
            console.log("Error while performing:", data)
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

    async marketBuy(toSpend, price, symbolInfo) {
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
        return this.privateCall("/v3/order",data,'POST').then(result => {    
            this.marketBuy = false;
            if (result.orderId)
                return new Promise((resolve, reject) => resolve(this.convertNumbersToFloat(result)));
            return new Promise((resolve, reject) => resolve(result));
        });
    }

    async limitBuy(toSpend, price, symbolInfo) {
        const minNotional = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'MIN_NOTIONAL').map(item => item.minNotional)[0]);
        const priceSize = symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0];
        const pricePrecision = priceSize.slice(priceSize.indexOf(".")).indexOf(1)
        const lotSize = symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0];
        const lotStepSize = parseFloat(symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.stepSize)[0]);
        let lotPrecision = lotSize.slice(lotSize.indexOf(".")).indexOf(1)
        price = price.toFixed(pricePrecision)     
        let quantity = parseFloat((toSpend/price).toFixed(lotPrecision));         
        while ( quantity * price < minNotional) {
            quantity = parseFloat(quantity) + lotStepSize;            
        }
        quantity = parseFloat(quantity).toFixed(lotPrecision);
        let data = {
            symbol:symbolInfo.symbol,
            side:"buy",
            type:"LIMIT",
            quantity: quantity,
            price: price,
            timeInForce: 'GTC'
        }
        return this.privateCall("/v3/order",data,'POST').then(result => {
            if (result.orderId)
                return new Promise((resolve, reject) => resolve(this.convertNumbersToFloat(result)));
            return new Promise((resolve, reject) => resolve(result));
        });;
    }

    async marketSell(toSell, price, symbolInfo) {
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
        return this.privateCall("/v3/order",data,'POST').then(result => {
            this.isMarketSell = false;
            if (result.orderId)
                return new Promise((resolve, reject) => resolve(this.convertNumbersToFloat(result)));
            return new Promise((resolve, reject) => resolve(result));
        });
    }
    
    async limitSell(toSell, price, symbolInfo) {
        const priceSize = symbolInfo.filters.filter(item => item.filterType == 'PRICE_FILTER').map(item => item.minPrice)[0];
        const pricePrecision = priceSize.slice(priceSize.indexOf(".")).indexOf(1)
        const lotSize = symbolInfo.filters.filter(item => item.filterType == 'LOT_SIZE').map(item => item.minQty)[0];
        let lotPrecision = lotSize.slice(lotSize.indexOf(".")).indexOf(1)
        price = price.toFixed(pricePrecision)
        toSell = toSell.toFixed(lotPrecision);
        let data = {
            symbol:symbolInfo.symbol,
            side:"sell",
            type:"LIMIT",
            quantity: parseFloat(toSell),
            price: price,
            timeInForce: 'GTC'
        }
        return this.privateCall("/v3/order",data,'POST').then(result => {
            if (result.orderId)
                return new Promise((resolve, reject) => resolve(this.convertNumbersToFloat(result)));
            return new Promise((resolve, reject) => resolve(result));
        });
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
        return this.privateCall("/v3/order", data, 'DELETE')
    }

    async getOrderInfo(symbolInfo, orderId) {
        let data = {
            symbol:symbolInfo.symbol,
            orderId: orderId
        }
        return this.privateCall("/v3/order", data, 'GET').then(result => {
            if (result.orderId)
                return new Promise((resolve, reject) => resolve(this.convertNumbersToFloat(result)));
            return new Promise((resolve, reject) => resolve(result));
        });
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



