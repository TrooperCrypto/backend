// SPDX-License-Identifier: BUSL-1.1
import fetch from 'isomorphic-fetch'
import { EventEmitter } from 'events'
import { zksyncOrderSchema } from 'src/schemas'
import { WebSocket } from 'ws'
import type { Pool } from 'pg'
import type { RedisClientType } from 'redis'
import * as services from 'src/services'
import type {
  ZkTx,
  WSocket,
  WSMessage,
  ZZMarketInfo,
  ZZMarketSide,
  ZZFillOrder,
  AnyObject,
  ZZMarket,
  ZZHttpServer,
  ZZSocketServer,
  ZZMarketSummary,
} from 'src/types'

export default class API extends EventEmitter {
  USER_CONNECTIONS: AnyObject = {}
  MAKER_CONNECTIONS: AnyObject = {}
  V1_TOKEN_IDS: AnyObject = {}
  MARKET_MAKER_TIMEOUT = 300
  SET_MM_PASSIVE_TIME = 20
  VALID_CHAINS: number[] = [1, 1000, 1001]

  watchers: NodeJS.Timer[] = []
  started = false
  wss: ZZSocketServer
  redis: RedisClientType
  http: ZZHttpServer
  db: Pool

  constructor(
    wss: ZZSocketServer,
    db: Pool,
    http: ZZHttpServer,
    redis: RedisClientType
  ) {
    super()
    this.db = db
    this.redis = redis
    this.http = http
    this.wss = wss
    this.http.api = this
    this.wss.api = this
  }

  serviceHandler = (msg: WSMessage, ws?: WSocket): any => {
    if (!Object.prototype.hasOwnProperty.call(services, msg.op)) {
      console.error(`Operation failed: ${msg.op}`)
      return false
    }

    return (services as any)[msg.op].apply(this, [
      this,
      ws,
      Array.isArray(msg.args) ? msg.args : [],
    ])
  }

  start = async (port: number) => {
    if (this.started) return

    await this.redis.connect()

    this.watchers = [
      setInterval(this.updatePriceHighLow, 300000),
      setInterval(this.updateVolumes, 120000),
      setInterval(this.clearDeadConnections, 60000),
      setInterval(this.updatePendingOrders, 60000),
      setInterval(this.updateMarketInfo, 10000),
      // setInterval(this.updatePassiveMM, 10000),
      setInterval(this.broadcastLiquidity, 4000),
    ]

    // update updatePriceHighLow once
    setTimeout(this.updatePriceHighLow, 10000)

    // reset redis mm timeouts
    this.VALID_CHAINS.map(async (chainid) => {
      const redisPatternBussy = `bussymarketmaker:${chainid}:*`
      const keysBussy = await this.redis.keys(redisPatternBussy)
      keysBussy.forEach(async (key: string) => {
        this.redis.del(key)
      })
      const redisPatternPassiv = `passivews:${chainid}:*`
      const keysPassiv = await this.redis.keys(redisPatternPassiv)
      keysPassiv.forEach(async (key: string) => {
        this.redis.del(key)
      })
    })

    this.started = true

    this.http.listen(port, () => {
      console.log(`Server listening on port ${port}.`)
    })
  }

  stop = async () => {
    if (!this.started) return
    await this.redis.disconnect()
    this.watchers.forEach((watcher) => clearInterval(watcher))
    this.watchers = []
    this.started = false
  }

  fetchMarketInfoFromMarkets = async (
    markets: string[],
    chainid: number
  ): Promise<ZZMarketInfo | null> => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30000)
    const url = `https://zigzag-markets.herokuapp.com/markets?id=${markets.join(
      ','
    )}&chainid=${chainid}`
    const marketInfoList = (await fetch(url, {
      signal: controller.signal,
    }).then((r: any) => r.json())) as ZZMarketInfo
    if (!marketInfoList) throw new Error(`No marketinfo found.`)
    for (let i = 0; i < marketInfoList.length; i++) {
      const marketInfo = marketInfoList[i]
      if (!marketInfo) return null
      const oldMarketInfo = await this.redis.get(
        `marketinfo:${chainid}:${marketInfo.alias}`
      )
      if (oldMarketInfo !== JSON.stringify(marketInfo)) {
        const market_id = marketInfo.alias
        const redis_key = `marketinfo:${chainid}:${market_id}`
        this.redis.set(redis_key, JSON.stringify(marketInfo), { EX: 1800 })

        const marketInfoMsg = { op: 'marketinfo', args: [marketInfo] }
        this.broadcastMessage(chainid, market_id, marketInfoMsg)
      }
    }

    return marketInfoList
  }

  getMarketInfo = async (
    market: ZZMarket,
    chainid: number
  ): Promise<ZZMarketInfo> => {
    const redis_key = `marketinfo:${chainid}:${market}`
    let marketinfo = await this.redis.get(redis_key)
    try {
      if (marketinfo) {
        return JSON.parse(marketinfo) as ZZMarketInfo
      }

      marketinfo = await this.fetchMarketInfoFromMarkets(
        [market],
        chainid
      ).then((r: any) => r[0])
    } catch (err) {
      console.log(err)
    }

    return marketinfo as any as ZZMarketInfo
  }

  updateMarketInfo = async () => {
    console.time('updating market info')
    const chainIds = [1, 1000]
    for (let i = 0; i < chainIds.length; i++) {
      try {
        const chainid = chainIds[i]
        const markets = await this.redis.SMEMBERS(`activemarkets:${chainid}`)
        // eslint-disable-next-line no-continue
        if (!markets || markets.length === 0) continue
        await this.fetchMarketInfoFromMarkets(markets, chainid)
      } catch (e) {
        console.error(e)
      }
    }
    console.timeEnd('updating market info')
  }

  updateOrderFillStatus = async (
    chainid: number,
    orderid: number,
    newstatus: string
  ) => {
    chainid = Number(chainid)
    orderid = Number(orderid)

    if (chainid === 1001) throw new Error('Not for Starknet orders')

    let update
    let fillId
    let market
    let fillPrice
    let side
    let maker_user_id
    try {
      const valuesOffers = [newstatus, chainid, orderid]
      update = await this.db.query(
        "UPDATE offers SET order_status=$1, update_timestamp=NOW() WHERE chainid=$2 AND id=$3 AND order_status IN ('b', 'm') RETURNING side, market",
        valuesOffers
      )
      if (update.rows.length > 0) {
        side = update.rows[0].side
        market = update.rows[0].market
      }
    } catch (e) {
      console.error('Error while updateOrderFillStatus offers.')
      console.error(e)
      return false
    }

    const marketInfo = await this.getMarketInfo(market, chainid)
    let feeAmount
    let feeToken
    let timestamp
    try {
      if (marketInfo) {
        if(side === 's') {
          feeAmount = marketInfo.baseFee
          feeToken =  marketInfo.baseAsset.symbol
        } else {
          feeAmount = marketInfo.quoteFee
          feeToken =  marketInfo.quoteAsset.symbol
        }
      } else {
        feeAmount = 0.5
        feeToken = "USDC"
      }
    } catch (err: any) {
      feeAmount = 0.5
      feeToken = "USDC"
    }

    if (newstatus === 'r') {
      feeAmount = 0
    }

    try {
      const valuesFills = [newstatus, feeAmount, feeToken, orderid, chainid]
      const update2 = await this.db.query(
        "UPDATE fills SET fill_status=$1,feeamount=$2,feetoken=$3 WHERE taker_offer_id=$4 AND chainid=$5 AND fill_status IN ('b', 'm') RETURNING id, market, price, amount, maker_user_id, insert_timestamp",
        valuesFills
      )
      if (update2.rows.length > 0) {
        fillId = update2.rows[0].id
        fillPrice = update2.rows[0].price
        maker_user_id = update2.rows[0].maker_user_id
        timestamp = update2.rows[0].insert_timestamp
      }
    } catch (e) {
      console.error('Error while updateOrderFillStatus fills.')
      console.error(e)
      return false
    }

    const success = update.rowCount > 0
    if (success && ['f', 'pf'].includes(newstatus)) {
      const today = new Date().toISOString().slice(0, 10)
      const redis_key_today_price = `dailyprice:${chainid}:${market}:${today}`
      this.redis.HSET(`lastprices:${chainid}`, `${market}`, `${fillPrice}`)
      this.redis.SET(`${redis_key_today_price}`, `${fillPrice}`, { EX: 604800 })
    }
    return {
      success,
      fillId,
      market,
      fillPrice,
      maker_user_id,
      feeAmount,
      feeToken,
      timestamp,
    }
  }

  updateMatchedOrder = async (
    chainid: number,
    orderid: number,
    newstatus: string,
    txhash: string
  ) => {
    chainid = Number(chainid)
    orderid = Number(orderid)
    let update
    let fillId
    let market
    const values = [newstatus, txhash, chainid, orderid]
    try {
      update = await this.db.query(
        "UPDATE offers SET order_status=$1, txhash=$2, update_timestamp=NOW() WHERE chainid=$3 AND id=$4 AND order_status='m'",
        values
      )
    } catch (e) {
      console.error('Error while updateMatchedOrder offers.')
      console.error(e)
      return false
    }

    try {
      const update2 = await this.db.query(
        'UPDATE fills SET fill_status=$1, txhash=$2 WHERE chainid=$3 AND taker_offer_id=$4 RETURNING id, market',
        values
      )
      if (update2.rows.length > 0) {
        fillId = update2.rows[0].id
        market = update2.rows[0].market
      }
    } catch (e) {
      console.error('Error while updateMatchedOrder fills.')
      console.error(e)
      return false
    }

    return { success: update.rowCount > 0, fillId, market }
  }

  processorderzksync = async (
    chainid: number,
    market: ZZMarket,
    zktx: ZkTx
  ) => {
    chainid = Number(chainid)

    const inputValidation = zksyncOrderSchema.validate(zktx)
    if (inputValidation.error) throw inputValidation.error

    // TODO: Activate nonce check here
    // if(NONCES[zktx.accountId] && NONCES[zktx.accountId][chainid] && NONCES[zktx.accountId][chainid] > zktx.nonce) {
    //    throw new Error("badnonce");
    // }

    // Prevent DOS attacks. Rate limit one order every 3 seconds.
    const redis_rate_limit_key = `ratelimit:zksync:${chainid}:${zktx.accountId}`
    const ratelimit = await this.redis.get(redis_rate_limit_key)
    if (ratelimit) throw new Error('Only one order per 3 seconds allowed')
    else {
      await this.redis.set(redis_rate_limit_key, '1')
    }
    await this.redis.expire(redis_rate_limit_key, 3)

    const marketInfo = await this.getMarketInfo(market, chainid)
    let side
    let base_quantity
    let quote_quantity
    let price

    if (
      zktx.tokenSell === marketInfo.baseAssetId &&
      zktx.tokenBuy === marketInfo.quoteAssetId
    ) {
      side = 's'
      price =
        zktx.ratio[1] /
        10 ** marketInfo.quoteAsset.decimals /
        (zktx.ratio[0] / 10 ** marketInfo.baseAsset.decimals)
      base_quantity = zktx.amount / 10 ** marketInfo.baseAsset.decimals
      quote_quantity = base_quantity * price
    } else if (
      zktx.tokenSell === marketInfo.quoteAssetId &&
      zktx.tokenBuy === marketInfo.baseAssetId
    ) {
      side = 'b'
      price =
        zktx.ratio[0] /
        10 ** marketInfo.quoteAsset.decimals /
        (zktx.ratio[1] / 10 ** marketInfo.baseAsset.decimals)
      quote_quantity = zktx.amount / 10 ** marketInfo.quoteAsset.decimals
      base_quantity =
        ((quote_quantity / price) as any).toFixed(
          marketInfo.baseAsset.decimals
        ) / 1
    } else {
      throw new Error('Buy/sell tokens do not match market')
    }

    if (side === 's' && base_quantity < marketInfo.baseFee) {
      throw new Error('Order size inadequate to pay fee')
    }
    if (side === 'b' && quote_quantity < marketInfo.quoteFee) {
      throw new Error('Order size inadequate to pay fee')
    }
    const order_type = 'limit'
    const expires = zktx.validUntil
    const userid = zktx.accountId
    const queryargs = [
      chainid,
      userid,
      zktx.nonce,
      market,
      side,
      price,
      base_quantity,
      quote_quantity,
      order_type,
      'o',
      expires,
      JSON.stringify(zktx),
      base_quantity,
    ]
    // save order to DB
    const query =
      'INSERT INTO offers(chainid, userid, nonce, market, side, price, base_quantity, quote_quantity, order_type, order_status, expires, zktx, insert_timestamp, unfilled) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13) RETURNING id'
    const insert = await this.db.query(query, queryargs)
    const orderId = insert.rows[0].id
    const orderreceipt = [
      chainid,
      orderId,
      market,
      side,
      price,
      base_quantity,
      quote_quantity,
      expires,
      userid.toString(),
      'o',
      null,
      base_quantity,
    ]

    // broadcast new order
    this.broadcastMessage(chainid, market, {
      op: 'orders',
      args: [[orderreceipt]],
    })
    try {
      const userconnkey = `${chainid}:${userid}`
      this.USER_CONNECTIONS[userconnkey].send(
        JSON.stringify({ op: 'userorderack', args: orderreceipt })
      )
    } catch (e) {
      // user connection doesn't exist. just pass along
    }

    return { op: 'userorderack', args: orderreceipt }
  }

  // async processorderstarknet(chainid: number, market: string, zktx: AnyObject) {
  //   for (let i in zktx) {
  //     if (typeof zktx[i] !== 'string')
  //       throw new Error('All order arguments must be cast to string')
  //   }
  //   const user = zktx[1]
  //   const baseCurrency = starknetContracts[zktx[2]]
  //   const quoteCurrency = starknetContracts[zktx[3]]
  //   if (zktx[4] != 1 && zktx[4] != 0) throw new Error('Invalid side')
  //   const side = zktx[4] == 0 ? 'b' : 's'
  //   const base_quantity = zktx[5] / 10 ** starknetAssets[baseCurrency].decimals
  //   const price =
  //     (zktx[6] / zktx[7]) *
  //     10 **
  //       (starknetAssets[baseCurrency].decimals -
  //         starknetAssets[quoteCurrency].decimals)
  //   const quote_quantity = price * base_quantity
  //   const expiration = zktx[8]
  //   const order_type = 'limit'

  //   const query = 'SELECT * FROM match_limit_order($1, $2, $3, $4, $5, $6, $7)'
  //   let values = [
  //     chainid,
  //     user,
  //     market,
  //     side,
  //     price,
  //     base_quantity,
  //     JSON.stringify(zktx),
  //   ]
  //   console.log(values)
  //   const matchquery = await this.db.query(query, values)
  //   const fill_ids = matchquery.rows
  //     .slice(0, matchquery.rows.length - 1)
  //     .map((r) => r.id)
  //   const offer_id = matchquery.rows[matchquery.rows.length - 1].id

  //   const fills = await this.db.query(
  //     'SELECT fills.*, maker_offer.unfilled AS maker_unfilled, maker_offer.zktx AS maker_zktx, maker_offer.side AS maker_side FROM fills JOIN offers AS maker_offer ON fills.maker_offer_id=maker_offer.id WHERE fills.id = ANY ($1)',
  //     [fill_ids]
  //   )
  //   console.log('fills', fills.rows)
  //   const offerquery = await this.db.query('SELECT * FROM offers WHERE id = $1', [
  //     offer_id,
  //   ])
  //   const offer = offerquery.rows[0]
  //   console.log('offer', offer)

  //   const orderupdates = []
  //   const marketFills = []
  //   fills.rows.forEach((row) => {
  //     if (row.maker_unfilled > 0)
  //       orderupdates.push([
  //         chainid,
  //         row.maker_offer_id,
  //         'pm',
  //         row.amount,
  //         row.maker_unfilled,
  //       ])
  //     else orderupdates.push([chainid, row.maker_offer_id, 'm'])
  //     marketFills.push([
  //       chainid,
  //       row.id,
  //       market,
  //       side,
  //       row.price,
  //       row.amount,
  //       row.fill_status,
  //       row.txhash,
  //       row.taker_user_id,
  //       row.maker_user_id,
  //     ])

  //     let buyer, seller
  //     if (row.maker_side == 'b') {
  //       buyer = row.maker_zktx
  //       seller = offer.zktx
  //     } else if (row.maker_side == 's') {
  //       buyer = offer.zktx
  //       seller = row.maker_zktx
  //     }
  //     relayStarknetMatch(
  //       JSON.parse(buyer),
  //       JSON.parse(seller),
  //       row.amount,
  //       row.price,
  //       row.id,
  //       row.maker_offer_id,
  //       offer.id
  //     )
  //   })
  //   const order = [
  //     chainid,
  //     offer.id,
  //     market,
  //     offer.side,
  //     offer.price,
  //     offer.base_quantity,
  //     offer.price * offer.base_quantity,
  //     offer.expires,
  //     offer.userid,
  //     offer.order_status,
  //     null,
  //     offer.unfilled,
  //   ]
  //   broadcastMessage(chainid, market, { op: 'orders', args: [[order]] })
  //   if (orderupdates.length > 0)
  //     broadcastMessage(chainid, market, {
  //       op: 'orderstatus',
  //       args: [orderupdates],
  //     })
  //   if (marketFills.length > 0)
  //     broadcastMessage(chainid, market, { op: 'fills', args: [marketFills] })
  // }

  // async relayStarknetMatch(
  //   buyer,
  //   seller,
  //   fillQty,
  //   fillPrice,
  //   fillId,
  //   makerOfferId,
  //   takerOfferId
  // ) {
  //   const baseCurrency = starknetContracts[buyer[2]]
  //   const quoteCurrency = starknetContracts[buyer[3]]
  //   const baseAssetDecimals = starknetAssets[baseCurrency].decimals
  //   const quoteAssetDecimals = starknetAssets[quoteCurrency].decimals
  //   const decimalDifference = baseAssetDecimals - quoteAssetDecimals
  //   const fillPriceRatio = [
  //     '1',
  //     ((1 / fillPrice) * 10 ** decimalDifference).toFixed(0),
  //   ]
  //   fillQty = (fillQty * 10 ** baseAssetDecimals).toFixed(0)
  //   buyer[1] = BigInt(buyer[1]).toString()
  //   buyer[2] = BigInt(buyer[2]).toString()
  //   buyer[3] = BigInt(buyer[3]).toString()
  //   buyer[9] = BigInt(buyer[9]).toString()
  //   buyer[10] = BigInt(buyer[10]).toString()
  //   seller[1] = BigInt(seller[1]).toString()
  //   seller[2] = BigInt(seller[2]).toString()
  //   seller[3] = BigInt(seller[3]).toString()
  //   seller[9] = BigInt(seller[9]).toString()
  //   seller[10] = BigInt(seller[10]).toString()
  //   const calldata = [...buyer, ...seller, ...fillPriceRatio, fillQty]
  //   try {
  //     const transactionDetails = {
  //       type: 'INVOKE_FUNCTION',
  //       contract_address: process.env.STARKNET_CONTRACT_ADDRESS,
  //       entry_point_selector: starknet.stark.getSelectorFromName('fill_order'),
  //       calldata,
  //     }
  //     const relayResult = await starknet.defaultProvider.addTransaction(
  //       transactionDetails
  //     )
  //
  //   TODO we want to add fees here
  //
  //     console.log('Starknet tx success')
  //     const fillupdate = await this.db.query(
  //       "UPDATE fills SET fill_status='f', txhash=$1 WHERE id=$2 RETURNING id, fill_status, txhash",
  //       [relayResult.transaction_hash, fillId]
  //     )
  //     const orderupdate = await this.db.query(
  //       "UPDATE offers SET order_status=(CASE WHEN order_status='pm' THEN 'pf' ELSE 'f' END), update_timestamp=NOW() WHERE id IN ($1, $2) RETURNING id, order_status",
  //       [makerOfferId, takerOfferId]
  //     )
  //     const chainid = parseInt(buyer[0])
  //     const orderUpdates = orderupdate.rows.map((row) => [
  //       chainid,
  //       row.id,
  //       row.order_status,
  //     ])
  //     const fillUpdates = fillupdate.rows.map((row) => [
  //       chainid,
  //       row.id,
  //       row.fill_status,
  //       row.txhash,
  //     ])
  //     const market = baseCurrency + '-' + quoteCurrency
  //     broadcastMessage(chainid, market, {
  //       op: 'orderstatus',
  //       args: [orderUpdates],
  //     })
  //     broadcastMessage(chainid, market, { op: 'fillstatus', args: [fillUpdates] })
  //   } catch (e) {
  //     console.error(e)
  //     console.error('Starknet tx failed')
  //     const orderupdate = await this.db.query(
  //       "UPDATE offers SET order_status='r', update_timestamp=NOW() WHERE id IN ($1, $2) RETURNING id, order_status",
  //       [makerOfferId, takerOfferId]
  //     )
  //     const chainid = parseInt(buyer[0])
  //     const orderUpdates = orderupdate.rows.map((row) => [
  //       chainid,
  //       row.id,
  //       row.order_status,
  //     ])
  //     const market = baseCurrency + '-' + quoteCurrency
  //     broadcastMessage(chainid, market, {
  //       op: 'orderstatus',
  //       args: [orderUpdates],
  //     })
  //   }
  // }

  cancelallorders = async (userid: string | number): Promise<string[]> => {
    const values = [userid]
    const select = await this.db.query(
      "SELECT id FROM offers WHERE userid=$1 AND order_status='o'",
      values
    )
    const ids = select.rows.map((s) => s.id)

    await this.db.query(
      "UPDATE offers SET order_status='c',zktx=NULL, update_timestamp=NOW() WHERE userid=$1 AND order_status='o'",
      values
    )

    return ids
  }

  cancelorder = async (chainid: number, orderId: string, ws?: WSocket) => {
    const values = [orderId, chainid]
    const select = await this.db.query(
      'SELECT userid FROM offers WHERE id=$1 AND chainid=$2',
      values
    )

    if (select.rows.length === 0) {
      throw new Error('Order not found')
    }

    const { userid } = select.rows[0]
    const userconnkey = `${chainid}:${userid}`

    if (this.USER_CONNECTIONS[userconnkey] !== ws) {
      throw new Error('Unauthorized')
    }

    const updatevalues = [orderId]
    const update = await this.db.query(
      "UPDATE offers SET order_status='c', zktx=NULL, update_timestamp=NOW() WHERE id=$1 RETURNING market",
      updatevalues
    )
    let market
    if (update.rows.length > 0) {
      market = update.rows[0].market
    }

    return { success: true, market }
  }

  matchorder = async (
    chainid: number,
    orderId: string,
    fillOrder: ZZFillOrder,
    ws: WSocket
  ) => {
    const values = [orderId, chainid]
    const select = await this.db.query(
      "SELECT userid, price, base_quantity, quote_quantity, market, zktx, side FROM offers WHERE id=$1 AND chainid=$2 AND order_status='o'",
      values
    )
    if (select.rows.length === 0) {
      ws.send(
        JSON.stringify(
          { 
            op: 'error',
            args: [
              'fillrequest',
              fillOrder.accountId.toString(),
              `Order ${orderId} is not open`] 
          }
        )
      )
      return
    }

    const selectresult = select.rows[0]
    
    // Determine fill price
    const marketInfo = await this.getMarketInfo(selectresult.market, chainid)
    let baseQuantity: number
    let quoteQuantity: number
    
    if (selectresult.side === 's') {
      baseQuantity = selectresult.base_quantity
      quoteQuantity = Number(fillOrder.amount) / 10 ** marketInfo.quoteAsset.decimals
    } else if (selectresult.side === 'b') {
      baseQuantity = Number(fillOrder.amount) / 10 ** marketInfo.baseAsset.decimals
      quoteQuantity = selectresult.quote_quantity
    } else {
      throw new Error(`Side ${selectresult.side} is not valid!`)
    }

    const fillPrice = (quoteQuantity / baseQuantity).toFixed(
      marketInfo.pricePrecisionDecimals
    )
    const redis_members: any = {
      score: fillPrice,
      value: JSON.stringify({
        "zktx": JSON.parse(selectresult.zktx),
        "market": selectresult.market,
        "baseQuantity": selectresult.base_quantity,
        "quoteQuantity": selectresult.quote_quantity,
        "userId": selectresult.userid,
        "fillOrder": fillOrder,
        "wsUUID": ws.uuid
      })
    }

    const redisKey = `matchingorders:${chainid}:${orderId}`
    const existingMembers = await this.redis.ZCOUNT(redisKey, -Infinity, Infinity)
    this.redis.ZADD(redisKey, redis_members)
    this.redis.EXPIRE(redisKey, 10)
    console.log(`ADDING: orderId: ${orderId}, side: ${selectresult.side}, price: ${fillPrice}`)
    if(existingMembers === 0) {
      setTimeout(
        this.senduserordermatch,
        500,
        chainid,
        orderId,
        selectresult.side)
    }
  }

  senduserordermatch = async (
    chainid: number,
    orderId: string,
    side: string
  ) => {
    console.log(`MATCHING: orderId: ${orderId}, side: ${side}`)
    const redisKeyOrders = `matchingorders:${chainid}:${orderId}`
    const existingMembers = await this.redis.ZCOUNT(redisKeyOrders, -Infinity, Infinity)
    if(existingMembers === 0) {
      return
    }

    let redis_members
    if(side === 'b') {
      redis_members = await this.redis.ZPOPMIN(redisKeyOrders)
    } else {
      redis_members = await this.redis.ZPOPMAX(redisKeyOrders)
    }
    if (!redis_members) {
      return
    }

    const fillPrice = redis_members.score
    const value = JSON.parse(redis_members.value)
    const {fillOrder} = value
    const makerAccountId = fillOrder.accountId.toString()
    const makerConnId = `${chainid}:${value.wsUUID}`
    const ws = this.MAKER_CONNECTIONS[makerConnId]
    console.log(`SELECTED: orderId: ${orderId}, side: ${side}, price: ${fillPrice}`)

    let fill
    const redisKeyBussy = `bussymarketmaker:${chainid}:${makerAccountId}`
    try {      
      const redisBusyMM = (await this.redis.get(redisKeyBussy)) as string
      if (redisBusyMM) {
        const processingOrderId: number = (JSON.parse(redisBusyMM) as any).orderId
        const remainingTime = await this.redis.ttl(redisKeyBussy)
        ws.send(
          JSON.stringify({
            op: 'error',
            args: [
              'fillrequest',
              makerAccountId,
              // eslint-disable-next-line prefer-template
              'Your address did not respond to order (' +
                processingOrderId +
                ') yet. Remaining timeout: ' +
                remainingTime +
                '.',
            ],
          })
        )
        throw new Error('fillrequest - market maker is timed out.') 
      }
      
      const marketInfo = await this.getMarketInfo(value.market, chainid)
      let priceWithoutFee: string
      if(marketInfo) {
        if(side === 's') {
          const quoteQuantity = Number(fillOrder.amount) / 10 ** marketInfo.quoteAsset.decimals
          const baseQuantityWithoutFee = value.baseQuantity - marketInfo.baseFee
          priceWithoutFee = (quoteQuantity / baseQuantityWithoutFee).toFixed(
            marketInfo.pricePrecisionDecimals
          )
        } else {
          const baseQuantity = Number(fillOrder.amount) / 10 ** marketInfo.baseAsset.decimals
          const quoteQuantityWithoutFee = value.quoteQuantity - marketInfo.quoteFee
          priceWithoutFee = (quoteQuantityWithoutFee / baseQuantity).toFixed(
            marketInfo.pricePrecisionDecimals
          )
        }
      } else {
        priceWithoutFee = fillPrice.toString()
      }

      let values = [orderId, chainid]
      const update1 = await this.db.query(
        "UPDATE offers SET order_status='m' WHERE id=$1 AND chainid=$2 AND order_status='o' RETURNING id",
        values
      )
      if (update1.rows.length === 0)
        // this *should* not happen, so no need to send to ws
        throw new Error(`Order ${orderId} is not open`)  
      
      values = [
        chainid,
        value.market,
        orderId,
        value.userId,
        makerAccountId,
        priceWithoutFee,
        value.baseQuantity,
        side,
      ]
      const update2 = await this.db.query(
        "INSERT INTO fills (chainid, market, taker_offer_id, taker_user_id, maker_user_id, price, amount, side, fill_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'm') RETURNING id",
        values
      )
      const fill_id = update2.rows[0].id
      fill = [
        chainid,
        fill_id,
        value.market,
        side,
        priceWithoutFee,
        value.baseQuantity,
        'm',
        null,
        value.userId,
        makerAccountId,
        null,
        null,
      ]
    } catch (e: any) {
      // try next best one
      this.senduserordermatch(
        chainid, 
        orderId, 
        side
      )
    }   
    
    console.log(`SEND: orderId: ${orderId}, side: ${side}, userordermatch to ${fillOrder.accountId.toString()}`)
    ws.send(
      JSON.stringify({
        op: 'userordermatch',
        args: [chainid, orderId, value.zktx, fillOrder],
      })
    )
    
    // send result to other mm's, remove set
    const otherMakerList: any[] = await this.redis.ZRANGE(redisKeyOrders, 0, -1)
    otherMakerList.map(async (otherMaker: any) => {
      const otherValue = JSON.parse(otherMaker)
      const otherFillOrder = otherValue.fillOrder
      const otherMakerAccountId = otherFillOrder.accountId.toString()
      console.log(`SEND: orderId: ${orderId}, side: ${side}, filled by better offer to ${otherMakerAccountId}`)
      const otherMakerConnId = `${chainid}:${otherValue.wsUUID}`
      const otherWs = this.MAKER_CONNECTIONS[otherMakerConnId]
      otherWs.send(
        JSON.stringify(
          { 
            op: 'error',
            args: [
              'fillrequest',
              otherMakerAccountId,
              "The Order was filled by better offer."
            ] 
          }
        )
      )
    })

    this.redis.set(
      redisKeyBussy,
      JSON.stringify({ "orderId": orderId, "ws_uuid": ws.uuid }),
      { EX: this.MARKET_MAKER_TIMEOUT }
    )

    this.broadcastMessage(chainid, value.market, {
      op: 'orderstatus',
      args: [[[chainid, orderId, 'm']]],
    })

    this.broadcastMessage(chainid, value.market, {
      op: 'fills',
      args: [[fill]],
    })
  }

  broadcastMessage = async (
    chainid: number | null = null,
    market: ZZMarket | null = null,
    msg: WSMessage | null = null
  ) => {
    ;(this.wss.clients as Set<WSocket>).forEach((ws: WSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (chainid && ws.chainid !== chainid) return
      if (market && !ws.marketSubscriptions.includes(market)) return
      ws.send(JSON.stringify(msg))
    })
  }

  /**
   * Returns the liquidity for a given market.
   * @param {number} chainid The reqested chain (1->zkSync, 1000->zkSync_rinkeby)
   * @param {ZZMarket} market The reqested market
   * @param {number} depth Depth of returned liquidity (depth/2 buckets per return)
   * @param {number} level Level of returned liquidity (1->best ask/bid, 2->0.05% steps, 3->all)
   * @return {number} The resulting liquidity -> {"timestamp": _, "bids": _, "asks": _}
   */
  getLiquidityPerSide = async (
    chainid: number,
    market: ZZMarket,
    depth = 0,
    level = 3
  ) => {
    const timestamp = Date.now()
    const liquidity = await this.getLiquidity(chainid, market)
    if (liquidity.length === 0) {
      return {
        timestamp,
        bids: [],
        asks: [],
      }
    }

    // sort for bids and asks
    let bids: number[][] = liquidity
      .filter((l) => l[0] === 'b')
      .map((l) => [Number(l[1]), Number(l[2])])
      .reverse()
    let asks: number[][] = liquidity
      .filter((l) => l[0] === 's')
      .map((l) => [Number(l[1]), Number(l[2])])

    // if depth is set, only used every n entrys
    if (depth > 1) {
      depth *= 0.5
      const newBids: number[][] = []
      const newAsks: number[][] = []

      for (let i = 0; i < bids.length; i++) {
        const index = Math.floor(i / depth)
        if (newBids[index]) {
          newBids[index][1] += bids[i][1]
        } else {
          newBids[index] = bids[i]
        }
      }
      for (let i = 0; i < asks.length; i++) {
        const index = Math.floor(i / depth)
        if (newAsks[index]) {
          newAsks[index][1] += asks[i][1]
        } else {
          newAsks[index] = asks[i]
        }
      }
      asks = newAsks
      bids = newBids
    }

    if (level === 1) {
      // Level 1 – Only best bid and ask.
      return {
        timestamp,
        bids: [bids[0]],
        asks: [asks[0]],
      }
    } 
    if (level === 2) {
      // Level 2 – Arranged by best bids and asks.
      const marketInfo = await this.getMarketInfo(market, chainid)
      // get mid price
      const redis_key_prices = `lastprices:${chainid}`
      const midPrice = Number(await this.redis.HGET(redis_key_prices, market))
      const returnBids: number[][] = []
      const returnAsks: number[][] = []
      const step = midPrice * 0.0005

      // group bids by steps
      const stepBidValues: any = {}
      bids.forEach((b) => {
        const stepCount = Math.ceil(Math.abs(b[0] - midPrice) % step)
        const stepValue = midPrice - stepCount * step
        if (stepBidValues[stepValue]) {
          stepBidValues[stepValue] += b[1]
        } else {
          // eslint-disable-next-line prefer-destructuring
          stepBidValues[stepValue] = b[1]
        }
      })
      // create new bids array
      const bidSteps = Object.keys(stepBidValues)
      bidSteps.forEach((bid) => {
        returnBids.push([
          (+bid).toFixed(marketInfo.pricePrecisionDecimal),
          stepBidValues[bid],
        ])
      })

      // group asks by steps
      const stepAskValues: any = {}
      asks.forEach((a) => {
        const stepCount = Math.ceil(Math.abs(a[0] - midPrice) % step)
        const stepValue = midPrice + stepCount * step
        if (stepAskValues[stepValue]) {
          stepAskValues[stepValue] += a[1]
        } else {
          // eslint-disable-next-line prefer-destructuring
          stepAskValues[stepValue] = a[1]
        }
      })
      // create new asks array
      const askSteps = Object.keys(stepAskValues)
      askSteps.forEach((ask) => {
        returnAsks.push([
          (+ask).toFixed(marketInfo.pricePrecisionDecimal),
          stepAskValues[ask],
        ])
      })

      return {
        timestamp,
        bids: returnBids,
        asks: returnAsks,
      }
    } 
    if (level === 3) {
      // Level 3 – Complete order book, no aggregation.
      return {
        timestamp,
        bids,
        asks,
      }
    }
    throw new Error(
      `level': ${level} is not supported for getLiquidityPerSide. Use 1, 2 or 3`
    )
  }

  getLiquidity = async (chainid: number, market: ZZMarket) => {
    const redis_key_liquidity = `liquidity:${chainid}:${market}`
    let liquidity = await this.redis.ZRANGEBYSCORE(
      redis_key_liquidity,
      '0',
      '1000000'
    )

    if (liquidity.length === 0) return []

    liquidity = liquidity.map((json) => JSON.parse(json))

    const now = (Date.now() / 1000) | 0
    const expired_values = liquidity
      .filter((l) => Number(l[3]) < now || !l[3])
      .map((l) => JSON.stringify(l))
    expired_values.forEach((v) => this.redis.ZREM(redis_key_liquidity, v))

    const active_liquidity = liquidity.filter((l) => Number(l[3]) > now)
    return active_liquidity
  }

  getopenorders = async (chainid: number, market: string) => {
    chainid = Number(chainid)
    const query = {
      text: "SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status,unfilled,txhash FROM offers WHERE market=$1 AND chainid=$2 AND order_status IN ('o', 'pm', 'pf')",
      values: [market, chainid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  getorder = async (chainid: number, orderid: string) => {
    chainid = Number(chainid)
    const query = {
      text: 'SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status,unfilled,txhash FROM offers WHERE chainid=$1 AND id=$2',
      values: [chainid, orderid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    if (select.rows.length === 0) throw new Error('Order not found')
    const order = select.rows[0]
    return order
  }

  getuserfills = async (chainid: number, userid: string) => {
    chainid = Number(chainid)
    const query = {
      text: 'SELECT chainid,id,market,side,price,amount,fill_status,txhash,taker_user_id,maker_user_id,feeamount,feetoken,insert_timestamp FROM fills WHERE chainid=$1 AND (maker_user_id=$2 OR taker_user_id=$2) ORDER BY id DESC LIMIT 25',
      values: [chainid, userid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  getuserorders = async (chainid: number, userid: string) => {
    const query = {
      text: "SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status FROM offers WHERE chainid=$1 AND userid=$2 AND order_status IN ('o','pm','pf') ORDER BY id DESC LIMIT 25",
      values: [chainid, userid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  /**
   * Returns fills for a given market.
   * @param {number} chainid reqested chain (1->zkSync, 1000->zkSync_rinkeby)
   * @param {ZZMarket} market reqested market
   * @param {number} limit number of trades returnd (MAX 25)
   * @param {number} orderId orderId to start at
   * @param {number} type side of returned fills 's', 'b', 'buy' or 'sell'
   * @param {number} startTime time for first fill
   * @param {number} endTime time for last fill
   * @param {number} accountId accountId to search for (maker or taker)
   * @param {string} direction used to set ASC or DESC ('older' or 'newer')
   * @return {number} array of fills [[chainid,id,market,side,price,amount,fill_status,txhash,taker_user_id,maker_user_id,feeamount,feetoken,insert_timestamp],...]
   */
  getfills = async (
    chainid: number,
    market: ZZMarket,
    limit?: number,
    orderId?: number,
    type?: string,
    startTime?: number,
    endTime?: number,
    accountId?: number,
    direction?: string
  ) => {
    let text = "SELECT chainid,id,market,side,price,amount,fill_status,txhash,taker_user_id,maker_user_id,feeamount,feetoken,insert_timestamp FROM fills WHERE chainid=$1 AND fill_status='f'"
    
    if(market) {
      text += ` AND market = '${market}'`
    }

    let sqlDirection = "DESC"
    if(direction) {
      if(direction === "older") {
        sqlDirection = "DESC"
      } else if(direction === "newer") {
        sqlDirection = "ASC"
      } else {
        throw new Error("Only direction 'older' or 'newer' is allowed.")
      }
    }

    if (orderId) {
      if(sqlDirection === "DESC") {
        text += ` AND id <= '${orderId}'`
      } else {
        text += ` AND id >= '${orderId}'`
      }      
    }

    if (type) {
      let side
      switch (type) {
        case 's':
          side = 's'
          break
        case 'b':
          side = 'b'
          break
        case 'sell':
          side = 's'
          break
        case 'buy':
          side = 'b'
          break
        default:
          throw new Error("Only type 's', 'b', 'sell' or 'buy' is allowed.")
      }
      text += ` AND side = '${side}'`
    }

    if (startTime) {
      const date = new Date(startTime).toISOString()
      text += ` AND insert_timestamp >= '${date}'`
    }

    if (endTime) {
      const date = new Date(endTime).toISOString()
      text += ` AND insert_timestamp <= '${date}'`
    }

    if (accountId) {
      text += ` AND (maker_user_id='${accountId}' OR taker_user_id='${accountId}')`
    }

    limit = limit ? Math.min(25, Number(limit)) : 25
    text += ` ORDER BY id ${sqlDirection} LIMIT ${limit}`

    try {
      const query = {
        text,
        values: [chainid],
        rowMode: 'array',
      }
      const select = await this.db.query(query)
      return select.rows
    } catch (e: any) {
      console.log(`Error in getFills: ${text}, Error: ${e.message}`)
      return []
    }
  }

  updateVolumes = async () => {
    const one_day_ago = new Date(Date.now() - 86400 * 1000).toISOString()
    const query = {
      text: "SELECT chainid, market, SUM(amount) AS base_volume FROM fills WHERE fill_status IN ('m', 'f', 'b') AND insert_timestamp > $1 AND chainid IS NOT NULL GROUP BY (chainid, market)",
      values: [one_day_ago],
    }
    const select = await this.db.query(query)
    select.rows.forEach(async (row) => {
      try {
        const price = Number(
          await this.redis.HGET(`lastprices:${row.chainid}`, row.market)
        )
        let quoteVolume = (row.base_volume * price).toPrecision(6)
        let baseVolume = row.base_volume.toPrecision(6)
        // Prevent exponential notation
        if (quoteVolume.includes('e')) {
          quoteVolume = (row.base_volume * price).toFixed(0)
        }
        if (baseVolume.includes('e')) {
          baseVolume = row.base_volume.toFixed(0)
        }
        const redis_key_base = `volume:${row.chainid}:base`
        const redis_key_quote = `volume:${row.chainid}:quote`
        this.redis.HSET(redis_key_base, row.market, baseVolume)
        this.redis.HSET(redis_key_quote, row.market, quoteVolume)
      } catch (err) {
        console.error(err)
        console.log('Could not update volumes')
      }
    })

    try {
      // remove zero volumes
      this.VALID_CHAINS.forEach(async (chainId) => {
        const nonZeroMarkets = select.rows.filter(row => row.chainid===chainId)
          .map(row => row.market)

        const baseVolumeMarkets = await this.redis.HKEYS(`volume:${chainId}:base`)
        const quoteVolumeMarkets = await this.redis.HKEYS(`volume:${chainId}:quote`)

        const keysToDelBase = baseVolumeMarkets.filter(m => !nonZeroMarkets.includes(m))
        const keysToDelQuote = quoteVolumeMarkets.filter(m => !nonZeroMarkets.includes(m))

        keysToDelBase.forEach(key => {
          this.redis.HDEL(`volume:${chainId}:base`, key)
        })
        keysToDelQuote.forEach(key => {
          this.redis.HDEL(`volume:${chainId}:quote`, key)
        })
      })    
    } catch (err) {
      console.error(err)
      console.log('Could not remove zero volumes')
    }
    return true
  }

  updatePendingOrders = async () => {
    const one_min_ago = new Date(Date.now() - 60 * 1000).toISOString()
    const query = {
      text: "UPDATE offers SET order_status='c', update_timestamp=NOW() WHERE (order_status IN ('m', 'b', 'pm') AND insert_timestamp < $1) OR (order_status='o' AND unfilled = 0) RETURNING chainid, id, order_status;",
      values: [one_min_ago],
    }
    const update = await this.db.query(query)
    if (update.rowCount > 0) {
      const orderUpdates = update.rows.map((row) => [
        row.chainid,
        row.id,
        row.order_status,
      ])
      this.broadcastMessage(null, null, {
        op: 'orderstatus',
        args: [orderUpdates],
      })
    }

    // Update fills
    const fillsQuery = {
      text: "UPDATE fills SET fill_status='e', feeamount=0 WHERE fill_status IN ('m', 'b', 'pm') AND insert_timestamp < $1",
      values: [one_min_ago],
    }
    await this.db.query(fillsQuery)

    const expiredQuery = {
      text: "UPDATE offers SET order_status='e', zktx=NULL, update_timestamp=NOW() WHERE order_status = 'o' AND expires < EXTRACT(EPOCH FROM NOW()) RETURNING chainid, id, order_status",
      values: [],
    }
    const updateExpires = await this.db.query(expiredQuery)
    if (updateExpires.rowCount > 0) {
      const orderUpdates = updateExpires.rows.map((row) => [
        row.chainid,
        row.id,
        row.order_status,
      ])
      this.broadcastMessage(null, null, {
        op: 'orderstatus',
        args: [orderUpdates],
      })
    }
    return true
  }

  getLastPrices = async (chainid: number) => {
    const lastprices: any[] = []
    const redis_key_prices = `lastprices:${chainid}`
    const redisKeyVolumesQuote = `volume:${chainid}:quote`
    const redisKeyVolumesBase = `volume:${chainid}:base`
    const redis_prices = await this.redis.HGETALL(redis_key_prices)
    const redisPricesQuote = await this.redis.HGETALL(redisKeyVolumesQuote)
    const redisVolumesBase = await this.redis.HGETALL(redisKeyVolumesBase)
    const markets = await this.redis.SMEMBERS(`activemarkets:${chainid}`)

    // eslint-disable-next-line no-restricted-syntax
    const results: Promise<any>[] = markets.map(async (market_id) => {
      const marketInfo = await this.getMarketInfo(market_id, chainid)
      if (!marketInfo || marketInfo.error) {
        return
      }
      const yesterday = new Date(Date.now() - 86400 * 1000)
        .toISOString()
        .slice(0, 10)
      const yesterdayPrice = Number(
        await this.redis.get(`dailyprice:${chainid}:${market_id}:${yesterday}`)
      )
      const price = +redis_prices[market_id]
      const priceChange = +(price - yesterdayPrice).toFixed(
        marketInfo.pricePrecisionDecimals
      )
      const quoteVolume = redisPricesQuote[market_id] || 0
      const baseVolume = redisVolumesBase[market_id] || 0
      lastprices.push([market_id, price, priceChange, quoteVolume, baseVolume])
    })
    await Promise.all(results)
    return lastprices
  }

  getMarketSummarys = async (chainid: number, marketReq = '') => {
    const redisKeyMarketSummary = `marketsummary:${chainid}`
    let markets
    if (marketReq === '') {
      const cache = await this.redis.GET(redisKeyMarketSummary)
      if (cache) {
        return JSON.parse(cache)
      }
      markets = await this.redis.SMEMBERS(`activemarkets:${chainid}`)
    } else {
      markets = [marketReq]
    }
    const marketSummarys: any = {}
    const redisKeyPrices = `lastprices:${chainid}`
    const redisPrices = await this.redis.HGETALL(redisKeyPrices)

    const redisKeyVolumesQuote = `volume:${chainid}:quote`
    const redisKeyVolumesBase = `volume:${chainid}:base`
    const redisVolumesQuote = await this.redis.HGETALL(redisKeyVolumesQuote)
    const redisVolumesBase = await this.redis.HGETALL(redisKeyVolumesBase)

    const redisKeyLow = `price:${chainid}:low`
    const redisKeyHigh = `price:${chainid}:high`
    const redisPricesLow = await this.redis.HGETALL(redisKeyLow)
    const redisPricesHigh = await this.redis.HGETALL(redisKeyHigh)

    const results: Promise<any>[] = markets.map(async (market: ZZMarket) => {
      const marketInfo = await this.getMarketInfo(market, chainid)
      if (!marketInfo || marketInfo.error) return
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString()
      const yesterdayPrice = Number(
        await this.redis.get(
          `dailyprice:${chainid}:${market}:${yesterday.slice(0, 10)}`
        )
      )
      const lastPrice = +redisPrices[market]
      const priceChange = +(lastPrice - yesterdayPrice).toFixed(
        marketInfo.pricePrecisionDecimals
      )
      const priceChangePercent_24h = +(priceChange / lastPrice).toFixed(
        marketInfo.pricePrecisionDecimals
      )

      // get low/high price
      const lowestPrice_24h = Number(redisPricesLow[market])
      const highestPrice_24h = Number(redisPricesHigh[market])

      // get volume
      const quoteVolume = Number(redisVolumesQuote[market] || 0)
      const baseVolume = Number(redisVolumesBase[market] || 0)

      // get best ask/bid
      const liquidity = await this.getLiquidityPerSide(chainid, market, 0, 1)
      const lowestAsk: number = liquidity.asks[0]?.[0]
      const highestBid: number = liquidity.bids[0]?.[0]

      const marketSummary: ZZMarketSummary = {
        market,
        baseSymbol: marketInfo.baseAsset.symbol,
        quoteSymbol: marketInfo.quoteAsset.symbol,
        lastPrice,
        lowestAsk,
        highestBid,
        baseVolume,
        quoteVolume,
        priceChange,
        priceChangePercent_24h,
        highestPrice_24h,
        lowestPrice_24h,
      }
      marketSummarys[market] = marketSummary
    })
    await Promise.all(results)
    if (marketReq === '') {
      this.redis.SET(redisKeyMarketSummary, JSON.stringify(marketSummarys), {
        EX: 10,
      })
    }
    return marketSummarys
  }

  updatePriceHighLow = async () => {
    const one_day_ago = new Date(Date.now() - 86400 * 1000).toISOString()
    const select = await this.db.query(
      "SELECT chainid, market, MIN(price) AS min_price, MAX(price) AS max_price FROM fills WHERE insert_timestamp > $1 AND fill_status='f' AND chainid IS NOT NULL GROUP BY (chainid, market)",
      [one_day_ago]
    )
    select.rows.forEach(async (row) => {
      const redisKeyLow = `price:${row.chainid}:low`
      const redisKeyHigh = `price:${row.chainid}:high`
      this.redis.HSET(redisKeyLow, row.market, row.min_price)
      this.redis.HSET(redisKeyHigh, row.market, row.max_price)
    })

    // delete inactive markets
    this.VALID_CHAINS.forEach(async (chainid) => {
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainid}`)
      const priceKeysLow = await this.redis.HKEYS(`price:${chainid}:low`)
      const delKeysLow = priceKeysLow.filter((k) => !markets.includes(k))
      delKeysLow.forEach(async (key) => {
        this.redis.HDEL(`price:${chainid}:low`, key)
      })
      const priceKeysHigh = await this.redis.HKEYS(`price:${chainid}:high`)
      const delKeysHigh = priceKeysHigh.filter((k) => !markets.includes(k))
      delKeysHigh.forEach(async (key) => {
        this.redis.HDEL(`price:${chainid}:high`, key)
      })
    })
  }

  // Ladder has to be a sorted 2-D array contaning price and quantity
  // Example: [ [3500,1], [3501,2] ]
  static getQuoteFromLadder(ladder: any[][], qty: number): number {
    let sum = 0
    let unfilledQuantity = qty

    for (let i = 0; i < ladder.length; i++) {
      const askPrice = ladder[i][0]
      const askQuantity = ladder[i][1]
      if (askQuantity >= unfilledQuantity) {
        sum += unfilledQuantity * askPrice
        unfilledQuantity = 0
        break
      } else {
        sum += askQuantity * askPrice
        unfilledQuantity -= askQuantity
      }
    }
    if (unfilledQuantity > 0) throw new Error('Insufficient liquidity')
    const avgPrice = sum / qty
    return avgPrice
  }

  genquote = async (
    chainid: number,
    market: ZZMarket,
    side: ZZMarketSide,
    baseQuantity: number,
    quoteQuantity: number
  ) => {
    if (baseQuantity && quoteQuantity)
      throw new Error('Only one of baseQuantity or quoteQuantity should be set')
    if (![1, 1000].includes(chainid))
      throw new Error('Quotes not supported for this chain')
    if (!['b', 's'].includes(side)) throw new Error('Invalid side')

    if (baseQuantity) baseQuantity = Number(baseQuantity)
    if (quoteQuantity) quoteQuantity = Number(quoteQuantity)
    if (baseQuantity && baseQuantity <= 0)
      throw new Error('Quantity must be positive')
    if (quoteQuantity && quoteQuantity <= 0)
      throw new Error('Quantity must be positive')

    const marketInfo = await this.getMarketInfo(market, chainid)
    const liquidity = await this.getLiquidity(chainid, market)
    if (liquidity.length === 0) throw new Error('No liquidity for pair')

    let softQuoteQuantity: any
    let hardQuoteQuantity: any
    let softBaseQuantity: any
    let hardBaseQuantity: any
    let softPrice: any
    let hardPrice: any
    let ladderPrice: any

    if (baseQuantity) {
      if (baseQuantity < marketInfo.baseFee)
        throw new Error('Amount is inadequate to pay fee')

      if (side !== 'b' && side !== 's') {
        throw new Error('Side must be "s" or "b"')
      }

      if (side === 'b') {
        const asks = liquidity
          .filter((l: string) => l[0] === 's')
          .map((l: string) => l.slice(1, 3)) as any[]
        ladderPrice = API.getQuoteFromLadder(asks, baseQuantity)
      } else {
        const bids = liquidity
          .filter((l: string) => l[0] === 'b')
          .map((l: string) => l.slice(1, 3))
          .reverse() as any[]
        ladderPrice = API.getQuoteFromLadder(bids, baseQuantity)
      }

      hardBaseQuantity = +baseQuantity.toFixed(marketInfo.baseAsset.decimals)

      if (side === 'b') {
        hardQuoteQuantity = +(
          baseQuantity * ladderPrice +
          marketInfo.quoteFee
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = +(hardQuoteQuantity / hardBaseQuantity).toFixed(
          marketInfo.pricePrecisionDecimals
        )
        softPrice = +(hardPrice * 1.001).toFixed(
          marketInfo.pricePrecisionDecimals
        )
      } else {
        hardQuoteQuantity = (
          (baseQuantity - marketInfo.baseFee) *
          ladderPrice
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = (hardQuoteQuantity / hardBaseQuantity).toFixed(
          marketInfo.pricePrecisionDecimals
        )
        softPrice = (hardPrice * 0.999).toFixed(
          marketInfo.pricePrecisionDecimals
        )
      }

      softBaseQuantity = baseQuantity.toFixed(marketInfo.baseAsset.decimals)
      softQuoteQuantity = (baseQuantity * softPrice).toFixed(
        marketInfo.quoteAsset.decimals
      )
    } else if (quoteQuantity) {
      if (quoteQuantity < marketInfo.quoteFee)
        throw new Error('Amount is inadequate to pay fee')

      hardQuoteQuantity = quoteQuantity.toFixed(marketInfo.quoteAsset.decimals)

      if (side === 'b') {
        const asks: any[] = liquidity
          .filter((l: any) => l[0] === 's')
          .map((l: any) => [l[1], Number(l[1]) * Number(l[2])])
        ladderPrice = API.getQuoteFromLadder(asks, quoteQuantity)

        hardBaseQuantity = (
          (quoteQuantity - marketInfo.quoteFee) /
          ladderPrice
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = (hardQuoteQuantity / hardBaseQuantity).toFixed(
          marketInfo.pricePrecisionDecimals
        )
        softPrice = (hardPrice * 1.0005).toFixed(
          marketInfo.pricePrecisionDecimals
        )
      } else {
        const bids = liquidity
          .filter((l: any) => l[0] === 'b')
          .map((l: any) => [l[1], Number(l[1]) * Number(l[2])])
        ladderPrice = API.getQuoteFromLadder(bids, quoteQuantity)

        hardBaseQuantity = (
          quoteQuantity / ladderPrice +
          marketInfo.baseFee
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = (hardQuoteQuantity / Number(hardBaseQuantity)).toFixed(
          marketInfo.pricePrecisionDecimals
        )
        softPrice = (hardPrice * 0.9995).toFixed(
          marketInfo.pricePrecisionDecimals
        )
      }

      softQuoteQuantity = quoteQuantity.toFixed(marketInfo.quoteAsset.decimals)
      softBaseQuantity = (quoteQuantity / softPrice).toFixed(
        marketInfo.baseAsset.decimals
      )
    }

    if (Number.isNaN(softPrice) || Number.isNaN(hardPrice))
      throw new Error('Internal Error. No price generated.')

    return {
      softPrice,
      hardPrice,
      softQuoteQuantity,
      hardQuoteQuantity,
      softBaseQuantity,
      hardBaseQuantity,
    }
  }

  clearDeadConnections = () => {
    ;(this.wss.clients as Set<WSocket>).forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate()
      } else {
        ws.isAlive = false
        ws.ping()
      }
    })

    console.log(`${this.wss.clients.size} dead connections cleared.`)
  }

  broadcastLiquidity = async () => {
    const result = this.VALID_CHAINS.map(async (chainid) => {
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainid}`)
      if (!markets || markets.length === 0) return
      const results: Promise<any>[] = markets.map(async (market_id) => {
        const liquidity = await this.getLiquidity(chainid, market_id)
        if (liquidity.length === 0) {
          await this.redis.SREM(`activemarkets:${chainid}`, market_id)
          await this.redis.HDEL(`lastprices:${chainid}`, market_id)
          try {
            await this.db.query(
              "UPDATE offers SET order_status='c',zktx=NULL,update_timestamp=NOW() WHERE market=$1 AND order_status='o'",
              [market_id]
            )
          } catch(err: any) {
            console.log(`Error while cancling offers for not active pair: ${market_id}, ${err.message}`)
          }
          return
        }
        this.broadcastMessage(chainid, market_id, {
          op: 'liquidity2',
          args: [chainid, market_id, liquidity],
        })

        // Update last price while you're at it
        const asks = liquidity.filter((l) => l[0] === 's')
        const bids = liquidity.filter((l) => l[0] === 'b')
        if (asks.length === 0 || bids.length === 0) return
        let askPrice = 0
        let askVolume = 0
        let bidPrice = 0
        let bidVolume = 0
        asks.forEach(ask => {
          askPrice += (+ask[1] * +ask[2])
          askVolume += +ask[2]
        })
        bids.forEach(bid => {
          bidPrice += (+bid[1] * +bid[2])
          bidVolume += +bid[2]
        })
        const mid = (askPrice / askVolume + bidPrice / bidVolume) / 2
        const marketInfo = await this.getMarketInfo(market_id, chainid)
        this.redis.HSET(
          `lastprices:${chainid}`,
          market_id,
          mid.toFixed(marketInfo.pricePrecisionDecimals)
        )
      })
      // Broadcast last prices
      const lastprices = (await this.getLastPrices(chainid)).map((l) =>
        l.splice(0, 3)
      )
      this.broadcastMessage(chainid, null, {
        op: 'lastprice',
        args: [lastprices],
      })

      // eslint-disable-next-line consistent-return
      return Promise.all(results)
    })

    return Promise.all(result)
  }

  updateLiquidity = async (
    chainid: number,
    market: ZZMarket,
    liquidity: any[],
    client_id: string
  ) => {
    const FIFTEEN_SECONDS = ((Date.now() / 1000) | 0) + 15
    const marketInfo = await this.getMarketInfo(market, chainid)

    const redisKey = `passivews:${chainid}:${client_id}`
    const waitingOrderId = await this.redis.get(redisKey)
    if (waitingOrderId) {
      const remainingTime = await this.redis.ttl(redisKey)
      throw new Error(
        // eslint-disable-next-line prefer-template
        'Your address did not respond to order ' +
          waitingOrderId +
          ' yet. Remaining timeout: ' +
          remainingTime +
          '.'
      )
    }

    // validation
    liquidity = liquidity.filter(
      (l: any[]) =>
        ['b', 's'].includes(l[0]) &&
        !Number.isNaN(parseFloat(l[1])) &&
        !Number.isNaN(parseFloat(l[2])) &&
        parseFloat(l[2]) > marketInfo.baseFee
    )

    // Add expirations to liquidity if needed
    Object.keys(liquidity).forEach((i: any) => {
      const expires = liquidity[i][3]
      if (!expires || expires > FIFTEEN_SECONDS) {
        liquidity[i][3] = FIFTEEN_SECONDS
      }
      liquidity[i][4] = client_id
    })

    const redis_key_liquidity = `liquidity:${chainid}:${market}`

    // Delete old liquidity by same client
    if (client_id) {
      let old_liquidity = await this.redis.ZRANGEBYSCORE(
        redis_key_liquidity,
        '0',
        '1000000'
      )
      old_liquidity = old_liquidity.map((json: string) => JSON.parse(json))
      const old_values = old_liquidity
        .filter((l: any) => l[4] && l[4] === client_id)
        .map((l: string) => JSON.stringify(l))
      old_values.forEach((v: string) => this.redis.ZREM(redis_key_liquidity, v))
    }

    // Set new liquidity
    const redis_members = liquidity.map((l) => ({
      score: l[1],
      value: JSON.stringify(l),
    }))
    try {
      if (liquidity.length > 0) {
        await this.redis.ZADD(redis_key_liquidity, redis_members)
      }
      await this.redis.SADD(`activemarkets:${chainid}`, market)
    } catch (e) {
      console.error(e)
      console.log(liquidity)
    }
  }

  updatePassiveMM = async () => {
    const orders = this.VALID_CHAINS.map(async (chainid: number) => {
      const redisPattern = `bussymarketmaker:${chainid}:*`
      const keys = await this.redis.keys(redisPattern)
      const results = keys.map(async (key: any) => {
        const remainingTime = await this.redis.ttl(key)
        // key is waiting for more than set SET_MM_PASSIVE_TIME
        if (
          remainingTime > 0 &&
          remainingTime < this.MARKET_MAKER_TIMEOUT - this.SET_MM_PASSIVE_TIME
        ) {
          const marketmaker = JSON.parse(`${await this.redis.get(key)}`)
          if (marketmaker) {
            const redisKey = `passivews:${chainid}:${marketmaker.ws_uuid}`
            const passivews = await this.redis.get(redisKey)
            if (!passivews) {
              this.redis.set(redisKey, JSON.stringify(marketmaker.orderId), {
                EX: remainingTime,
              })
            }
          }
        }
      })

      return Promise.all(results)
    })

    return Promise.all(orders)
  }

  populateV1TokenIds = async () => {
    for (let i = 0; ; ) {
      const result: any = (await fetch(
        `https://api.zksync.io/api/v0.2/tokens?from=${i}&limit=100&direction=newer`
      ).then((r: any) => r.json())) as AnyObject
      const { list } = result.result
      if (list.length === 0) {
        break
      } else {
        list.forEach((l: any) => {
          this.V1_TOKEN_IDS[l.id] = l.symbol
        })
        i += 100
      }
    }
  }

  getV1Markets = async (chainid: number) => {
    const v1Prices = await this.getLastPrices(chainid)
    const v1markets = v1Prices.map((l) => l[0])
    return v1markets
  }

  dailyVolumes = async (chainid: number) => {
    const redis_key = `volume:history:${chainid}`
    const cache = await this.redis.get(redis_key)
    if (cache) return JSON.parse(cache)
    const query = {
      text: "SELECT chainid, market, DATE(insert_timestamp) AS trade_date, SUM(base_quantity) AS base_volume, SUM(quote_quantity) AS quote_volume FROM offers WHERE order_status IN ('m', 'f', 'b') AND chainid = $1 GROUP BY (chainid, market, trade_date)",
      values: [chainid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    const volumes = select.rows
    await this.redis.set(redis_key, JSON.stringify(volumes))
    await this.redis.expire(redis_key, 1200)
    return volumes
  }

  getUsdPrice = async (chainid: number, tokenSymbol: string) => {
    const redisKey = `usdprice:${chainid}:&{tokenSymbol}`
    const cache = await this.redis.GET(redisKey)
    if (cache) return +cache

    const stablePrice = await this.getUsdStablePrice(chainid, tokenSymbol)
    if (stablePrice) {
      this.redis.set(redisKey, stablePrice, { EX: 30 })
      return stablePrice
    }

    const linkedPrice = await this.getUsdLinkedPrice(chainid, tokenSymbol)
    if (linkedPrice) {
      this.redis.set(redisKey, linkedPrice, { EX: 60 })
      return linkedPrice
    }

    return null
  }

  getUsdStablePrice = async (chainid: number, tokenSymbol: string) => {
    const redisKeyPrices = `lastprices:${chainid}`
    const redisPrices = await this.redis.HGETALL(redisKeyPrices)
    const stabels = ['DAI', 'FRAX', 'USDC', 'USDT', 'UST']

    const prices: number[] = []
    stabels.forEach((stabel) => {
      const possibleMarket = `${tokenSymbol}-${stabel}`
      const price = redisPrices[possibleMarket]
      if (price) prices.push(+price)
    })

    if (prices.length > 0) {
      const sum = prices.reduce((pv, cv) => pv + cv, 0)
      return sum / prices.length
    }
    return null
  }

  getUsdLinkedPrice = async (chainid: number, tokenSymbol: string) => {
    const redisKeyPrices = `lastprices:${chainid}`
    const redisPrices = await this.redis.HGETALL(redisKeyPrices)
    const markets = Object.keys(redisPrices)

    const prices: number[] = []
    const results: Promise<any>[] = markets.map(async (market) => {
      const [baseAsset, quoteAsset] = market.split('-')
      if (baseAsset === tokenSymbol) {
        const quotePrice = await this.getUsdStablePrice(chainid, quoteAsset)
        if (quotePrice) prices.push(quotePrice)
      } else if (quoteAsset === tokenSymbol) {
        const basePrice = await this.getUsdStablePrice(chainid, baseAsset)
        if (basePrice) prices.push(1 / basePrice)
      }
    })
    await Promise.all(results)

    if (prices.length > 0) {
      const sum = prices.reduce((pv, cv) => pv + cv, 0)
      return sum / prices.length
    }
    return null  
  }
}
