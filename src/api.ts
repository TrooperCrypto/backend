// SPDX-License-Identifier: BUSL-1.1
import fetch from 'isomorphic-fetch'
import { EventEmitter } from 'events'
import { zksyncOrderSchema, ZZMessageSchema } from 'src/schemas'
import { WebSocket } from 'ws'
import fs from 'fs'
import * as zksync from 'zksync'
import { ethers } from 'ethers'
import * as starknet from 'starknet'
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
  ZZOrder
} from 'src/types'
import { chainData } from 'src/constants'
import { 
  formatPrice,
  stringToFelt,
  get0xTokenAddress
} from 'src/utils'

export default class API extends EventEmitter {
  USER_CONNECTIONS: AnyObject = {}
  MAKER_CONNECTIONS: AnyObject = {}
  V1_TOKEN_IDS: AnyObject = {}
  SYNC_PROVIDER: AnyObject = {}
  ETHERS_PROVIDER: AnyObject = {}
  ZKSYNC_BASE_URL: AnyObject = {}
  STARKNET_EXCHANGE: AnyObject = {}
  MARKET_MAKER_TIMEOUT = 300
  SET_MM_PASSIVE_TIME = 20
  VALID_CHAINS: number[] = [1, 1000, 1001]
  VALID_CHAINS_ZKSYNC: number[] = [1, 1000]
  VALID_SMART_CONTRACT_CHAIN: number[] = [1001, 42161]
  ERC20_ABI: any
  DEFAULT_CHAIN = process.env.DEFAULT_CHAIN_ID
    ? Number(process.env.DEFAULT_CHAIN_ID)
    : 1

  watchers: NodeJS.Timer[] = []
  started = false
  wss: ZZSocketServer
  redis: RedisClientType
  redisSubscriber: any
  redisPublisher: any
  http: ZZHttpServer
  db: Pool

  constructor(
    wss: ZZSocketServer,
    db: Pool,
    http: ZZHttpServer,
    redis: RedisClientType,
    subscriber: RedisClientType,
    publisher: RedisClientType
  ) {
    super()
    this.db = db
    this.redis = redis
    this.redisSubscriber = subscriber
    this.redisPublisher = publisher
    this.http = http
    this.wss = wss
    this.http.api = this
    this.wss.api = this
  }

  serviceHandler = (msg: WSMessage, ws?: WSocket): any => {
    if (msg.op === "ping") {
      return false
    }
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
    await this.redisSubscriber.connect()
    await this.redisPublisher.connect()

    // fetch abi's
    this.ERC20_ABI = JSON.parse(
      fs.readFileSync(
        'abi/ERC20.abi',
        'utf8'
      )
    )

    const starknetContractABI = JSON.parse(
      fs.readFileSync(
        'abi/starknet_v1.abi',
        'utf8'
      )
    )

    // setup provider
    if (!process.env.STARKNET_CONTRACT_ADDRESS) throw new Error('process.env.STARKNET_CONTRACT_ADDRESS not set!')
    this.STARKNET_EXCHANGE.goerli = new starknet.Contract(
      starknetContractABI,
      process.env.STARKNET_CONTRACT_ADDRESS
    )
    this.ZKSYNC_BASE_URL.mainnet = "https://api.zksync.io/api/v0.2/"
    this.ZKSYNC_BASE_URL.rinkeby = "https://rinkeby-api.zksync.io/api/v0.2/"
    this.SYNC_PROVIDER.mainnet = await zksync.getDefaultRestProvider("mainnet")
    this.SYNC_PROVIDER.rinkeby = await zksync.getDefaultRestProvider("rinkeby")
    this.ETHERS_PROVIDER.mainnet =
      new ethers.providers.InfuraProvider("mainnet", process.env.INFURA_PROJECT_ID,)
    this.ETHERS_PROVIDER.rinkeby =
      new ethers.providers.InfuraProvider("rinkeby", process.env.INFURA_PROJECT_ID,)

    await this.updateTokenInfo()

    // setup redisSubscriber
    this.redisSubscriber.PSUBSCRIBE("broadcastmsg:*", (message: string, channel: string) => {
      const channelArgs = channel.split(':')
      if (channelArgs.length !== 4) {
        console.error(`redisSubscriber wrong channel format: ${channel}`)
        return
      }
      const op = channelArgs[0]
      const broadcastChannel = channelArgs[1]
      const chainId = Number(channelArgs[2])
      const target = channelArgs[3]

      if (!this.VALID_CHAINS.includes(chainId)) {
        console.error(`redisSubscriber wrong chainId: ${chainId}`)
        return
      }
      if (op !== "broadcastmsg") throw new Error('Sanity check failed.')
      if (broadcastChannel === "user") {
        this.sendMessageToUser(
          chainId,
          target,
          message
        )
      } else if (broadcastChannel === "all") {
        this.broadcastMessage(
          chainId,
          target,
          message
        )
      } else if (broadcastChannel === "maker") {
        this.sendMessageToMM(
          chainId,
          target,
          message
        )
      } else {
        console.error(`redisSubscriber wrong broadcastChannel: ${broadcastChannel}`)
      }
    })

    // some randomness to stagger updates between dynos
    const random = Math.floor(Math.random() * 5000)
    this.watchers = [
      setInterval(this.updatePriceHighLow, 300000),
      setInterval(this.updateVolumes, 120000),
      setInterval(this.clearDeadConnections, 60000),
      setInterval(this.updatePendingOrders, (60000 + random)),
      setInterval(this.updateUsdPrice, (10000 + random)),
      setInterval(this.updateFeesZkSync, (18000 + random)),
      // setInterval(this.updatePassiveMM, 10000),
      setInterval(this.broadcastLiquidity, 4000),
    ]

    // update updatePriceHighLow once
    setTimeout(this.updatePriceHighLow, 10000)

    // reset redis mm timeouts
    this.VALID_CHAINS.map(async (chainId) => {
      const redisPatternBussy = `bussymarketmaker:${chainId}:*`
      const keysBussy = await this.redis.keys(redisPatternBussy)
      keysBussy.forEach(async (key: string) => {
        this.redis.del(key)
      })
      const redisPatternPassiv = `passivews:${chainId}:*`
      const keysPassiv = await this.redis.keys(redisPatternPassiv)
      keysPassiv.forEach(async (key: string) => {
        this.redis.del(key)
      })
    })

    // reset liquidityKeys
    const removeOldLiquidityPromise: Promise<any>[] = this.VALID_CHAINS.map(async (chainId) => {
      const liquidityKeys = await this.redis.KEYS(`liquidity:${chainId}:*`)
      liquidityKeys.forEach(async (key) => {
        await this.redis.DEL(key)
      })
    })
    await Promise.all(removeOldLiquidityPromise)

    // add valid open orders to Liquidity
    const addLiquidityPromise: Promise<any>[] = this.VALID_SMART_CONTRACT_CHAIN.map(async (chainId) => {
      const query = {
        text: "SELECT chainid,market,side,price,expires,unfilled,id FROM offers WHERE chainid=$1 AND order_status IN ('o', 'pm', 'pf')",
        values: [chainId]
      }
      const select = await this.db.query(query)
      const rowsPromise: Promise<any>[] = select.rows.map(async (row) => {
        await this.addLiquidity(
          row.chainid,
          row.market,
          [row.side, row.price, row.unfilled, row.expires, row.id]
        )
      })
      await Promise.all(rowsPromise)
    })
    await Promise.all(addLiquidityPromise)

    this.started = true

    this.http.listen(port, () => {
      console.log(`Server listening on port ${port}.`)
    })
  }

  stop = async () => {
    if (!this.started) return
    await this.redis.disconnect()
    await this.redisSubscriber.disconnect()
    await this.redisPublisher.disconnect()
    this.watchers.forEach((watcher) => clearInterval(watcher))
    this.watchers = []
    this.started = false
  }

  /**
   * Get default market info from Arweave
   * @param market market alias or marketId
   * @returns 
   */
  getDefaultValuesFromArweave = async (
    chainId: number,
    market: string
  ) => {
    let marketInfo = null
    let marketArweaveId: string
    try {
      // get marketArweaveId 
      if (market.length > 19) {
        marketArweaveId = market
      } else {
        const select = await this.db.query(
          'SELECT marketid FROM marketids WHERE marketAlias = $1 AND chainid = $2',
          [market, chainId]
        )
        if (select.rows.length === 0) {
          return marketInfo
        }
        marketArweaveId = select.rows[0].marketid
      }

      // get arweave default marketinfo
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 15000)
      const fetchResult = await fetch(`https://arweave.net/${marketArweaveId}`, {
        signal: controller.signal,
      }).then((r: any) => r.json())

      if (!fetchResult) return marketInfo
      marketInfo = fetchResult
    } catch (err: any) {
      console.error(`Can't fetch update default marketInfo for ${market}, Error ${err.message}`)
    }
    return marketInfo
  }

  /**
   * Used to initialy fetch tokens infos on startup & updated on each recycle
   * @param chainId 
   */
  updateTokenInfo = async (
    chainId = this.DEFAULT_CHAIN
  ) => {
    let index = 0
    let tokenInfos
    const network = await this.getNetwork(chainId)
    do {
      const fetchResult = await fetch(`${this.ZKSYNC_BASE_URL[network]}tokens?from=${index}&limit=100&direction=newer`).then((r: any) => r.json())
      tokenInfos = fetchResult.result.list
      const results1: Promise<any>[] = tokenInfos.map(async (tokenInfo: any) => {
        const tokenSymbol = tokenInfo.symbol
        if (!tokenSymbol.includes("ERC20")) {
          tokenInfo.usdPrice = 0
          tokenInfo.name = await this.getTokenName(
            chainId,
            tokenInfo.address,
            tokenSymbol
          )
          this.redis.HSET(
            `tokeninfo:${chainId}`,
            tokenSymbol,
            JSON.stringify(tokenInfo)
          )
        }
      })
      await Promise.all(results1)
      index = tokenInfos[tokenInfos.length - 1].id
    } while (tokenInfos.length > 99)
  }

  /**
   * Get the full token name from L1 ERC20 contract
   * @param contractAddress 
   * @param tokenSymbol 
   * @returns full token name
   */
  getTokenName = async (
    chainId: number,
    contractAddress: string,
    tokenSymbol: string
  ) => {
    if (tokenSymbol === "ETH") {
      return "Ethereum"
    }
    const network = await this.getNetwork(chainId)
    let name
    try {
      const contract = new ethers.Contract(
        contractAddress,
        this.ERC20_ABI,
        this.ETHERS_PROVIDER[network]
      )
      name = await contract.name()
    } catch (e) {
      console.error(e)
      name = tokenSymbol
    }
    return name
  }

  /**
   * Update the fee for each token on regular basis
   */
  updateFeesZkSync = async () => {
    // only one dyno needs to update this
    const redisZkSyncFeeKey = 'update:zkSyncFee'
    const lock = await this.redis.get(redisZkSyncFeeKey)
    if (lock) {
      return
    }
    await this.redis.SET(redisZkSyncFeeKey, '1', { EX: 15 })

    console.time("Update fees")
    const results0: Promise<any>[] = this.VALID_CHAINS_ZKSYNC.map(async (chainId: number) => {
      const newFees: any = {}
      const network = await this.getNetwork(chainId)
      // get redis cache
      const tokenInfos: any = await this.redis.HGETALL(`tokeninfo:${chainId}`)
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
      // get every token form activemarkets once
      let tokenSymbols = markets.join('-').split('-')
      tokenSymbols = tokenSymbols.filter((x, i) => i === tokenSymbols.indexOf(x))
      // update fee for each
      const results1: Promise<any>[] = tokenSymbols.map(async (tokenSymbol: string) => {
        let fee = 0
        const tokenInfoString = tokenInfos[tokenSymbol]
        if (!tokenInfoString) return

        const tokenInfo = JSON.parse(tokenInfoString)
        if (!tokenInfo) return
        // enabledForFees -> get fee dircectly form zkSync
        if (tokenInfo.enabledForFees) {
          try {
            const feeReturn = await this.SYNC_PROVIDER[network].getTransactionFee(
              "Swap",
              '0x88d23a44d07f86b2342b4b06bd88b1ea313b6976',
              tokenSymbol
            )
            fee = Number(
              this.SYNC_PROVIDER[network].tokenSet
                .formatToken(
                  tokenSymbol,
                  feeReturn.totalFee
                )
            )
          } catch (e: any) {
            console.log(`Can't get fee for ${tokenSymbol}, error: ${e.message}`)
          }
        }
        // not enabledForFees -> use token price and USDC fee
        if (!fee) {
          try {
            const usdPrice: number = (tokenInfo.usdPrice) ? Number(tokenInfo.usdPrice) : 0
            const usdReferenceString = await this.redis.HGET(`tokenfee:${chainId}`, "USDC")
            const usdReference: number = (usdReferenceString) ? Number(usdReferenceString) : 0
            if (usdPrice > 0) {
              fee = (usdReference / usdPrice)
            }
          } catch (e) {
            console.log(`Can't get fee per reference for ${tokenSymbol}, error: ${e}`)
          }
        }

        // save new fee
        newFees[tokenSymbol] = fee
        if (fee) {
          this.redis.HSET(
            `tokenfee:${chainId}`,
            tokenSymbol,
            fee
          )
        }
      })
      await Promise.all(results1)

      // check if fee's have changed
      const marketInfos = await this.redis.HGETALL(`marketinfo:${chainId}`)
      const results2: Promise<any>[] = markets.map(async (market: ZZMarket) => {
        if (!marketInfos[market]) return
        const marketInfo = JSON.parse(marketInfos[market])
        const newBaseFee = newFees[marketInfo.baseAsset.symbol]
        const newQuoteFee = newFees[marketInfo.quoteAsset.symbol]
        let updated = false
        if (newBaseFee && marketInfo.baseFee !== newBaseFee) {
          marketInfo.baseFee = (Number(newFees[marketInfo.baseAsset.symbol]) * 1.05)
          updated = true
        }
        if (newQuoteFee && marketInfo.quoteFee !== newQuoteFee) {
          marketInfo.quoteFee = (Number(newFees[marketInfo.quoteAsset.symbol]) * 1.05)
          updated = true
        }
        if (updated) {
          this.redis.HSET(
            `marketinfo:${chainId}`,
            market,
            JSON.stringify(marketInfo)
          )
          this.redisPublisher.PUBLISH(
            `broadcastmsg:all:${chainId}:${market}`,
            JSON.stringify({ op: 'marketinfo', args: [marketInfo] })
          )
        }
      })
      await Promise.all(results2)
    })
    await Promise.all(results0)
    console.timeEnd("Update fees")
  }

  /**
   * get marketInfo for a given marketAlias or marketId
   * @param market marketAlias or marketId
   * @param chainId 
   * @returns marketInfo as ZZMarketInfo
   */
  getMarketInfo = async (
    market: ZZMarket,
    chainId: number
  ): Promise<ZZMarketInfo> => {
    if (!this.VALID_CHAINS.includes(chainId)) throw new Error('No valid chainId')
    if (!market) throw new Error('Bad market')

    const redisKeyMarketInfo = `marketinfo:${chainId}`
    const cache = await this.redis.HGET(
      redisKeyMarketInfo,
      market
    )

    if (cache) {
      return JSON.parse(cache) as ZZMarketInfo
    }

    const marketInfoDefaults: ZZMarketInfo = await this.getDefaultValuesFromArweave(
      chainId,
      market
    )

    if (
      market.length > 19 &&
      (!marketInfoDefaults || Number(marketInfoDefaults.zigzagChainId) !== chainId)
    ) {
      throw new Error(`Can't get marketInfo for market: ${market} and chainId: ${chainId}`)
    }

    let baseSymbol: string
    let quoteSymbol: string
    if (market.length > 19) {
      const network = await this.getNetwork(chainId)
      baseSymbol = await this.SYNC_PROVIDER[network].tokenSet.resolveTokenSymbol(marketInfoDefaults.baseAssetId)
      quoteSymbol = await this.SYNC_PROVIDER[network].tokenSet.resolveTokenSymbol(marketInfoDefaults.quoteAssetId)
    } else {
      [baseSymbol, quoteSymbol] = market.split('-')
    }

    if (baseSymbol.includes("ERC20")) throw new Error('Your base token has no symbol on zkSync. Please contact ZigZag or zkSync to get it listed properly. You can also check here: https://zkscan.io/explorer/tokens')
    if (quoteSymbol.includes("ERC20")) throw new Error('Your quote token has no symbol on zkSync. Please contact ZigZag or zkSync to get it listed properly. You can also check here: https://zkscan.io/explorer/tokens')

    // get last fee
    const [
      baseFee,
      quoteFee,
      baseAssetString,
      quoteAssetString
    ] = await Promise.all([
      this.redis.HGET(`tokenfee:${chainId}`, baseSymbol),
      this.redis.HGET(`tokenfee:${chainId}`, quoteSymbol),
      this.redis.HGET(`tokeninfo:${chainId}`, baseSymbol),
      this.redis.HGET(`tokeninfo:${chainId}`, quoteSymbol)
    ])

    if (!baseAssetString) throw new Error('Unkown base asset.')
    if (!quoteAssetString) throw new Error('Unkown quote asset.')
    const baseAsset = JSON.parse(baseAssetString) as AnyObject
    const quoteAsset = JSON.parse(quoteAssetString) as AnyObject

    const marketInfo: ZZMarketInfo = {}
    marketInfo.zigzagChainId = chainId
    marketInfo.baseAssetId = baseAsset.id
    marketInfo.quoteAssetId = quoteAsset.id
    // set fee, use arewavw fees as fallback
    marketInfo.baseFee = (baseFee)
      ? Number(baseFee)
      : Number(marketInfoDefaults?.baseFee)
    marketInfo.quoteFee = (quoteFee)
      ? Number(quoteFee)
      : Number(marketInfoDefaults?.quoteFee)
    // set tradingViewChart, use binance as fallback
    marketInfo.tradingViewChart = (marketInfoDefaults?.tradingViewChart)
      ? marketInfoDefaults.tradingViewChart
      : `BINANCE:${baseSymbol}${quoteSymbol}`
    // set pricePrecisionDecimal, use min decimals as fallback
    marketInfo.pricePrecisionDecimal = marketInfoDefaults?.pricePrecisionDecimal
      ? marketInfoDefaults.pricePrecisionDecimal
      : Math.min(baseAsset.decimals, quoteAsset.decimals)
    marketInfo.baseAsset = baseAsset
    marketInfo.quoteAsset = quoteAsset
    marketInfo.alias = `${baseSymbol}-${quoteSymbol}`

    await this.redis.HSET(
      redisKeyMarketInfo,
      marketInfo.alias,
      JSON.stringify(marketInfo)
    )

    // return if alias
    if (market.length < 19) return marketInfo

    // update marketArweaveId in SQL
    try {
      await this.db.query(
        'INSERT INTO marketids (marketid, chainid, marketalias) VALUES($1, $2, $3) ON CONFLICT (marketalias) DO UPDATE SET marketid = EXCLUDED.marketid',
        [market, chainId, marketInfo.alias] // market is the id in this case, as market > 19
      )
    } catch (err) {
      console.error(`Failed to update SQL for ${marketInfo.alias} SET id = ${market}`)
    }
    return marketInfo
  }

  updateOrderFillStatus = async (
    chainId: number,
    orderid: number,
    newstatus: string,
    txhash: string
  ) => {
    chainId = Number(chainId)
    orderid = Number(orderid)

    if (chainId === 1001) throw new Error('Not for Starknet orders')

    let update
    let fillId
    let market
    let userId
    let fillPrice
    let side
    let makerUserId
    try {
      const valuesOffers = [newstatus, txhash, chainId, orderid]
      update = await this.db.query(
        "UPDATE offers SET order_status=$1, txhash=$2, update_timestamp=NOW() WHERE chainid=$3 AND id=$4 AND order_status IN ('b', 'm') RETURNING side, market, userid",
        valuesOffers
      )
      if (update.rows.length > 0) {
        side = update.rows[0].side
        market = update.rows[0].market
        userId = update.rows[0].userid
      }
    } catch (e) {
      console.error('Error while updateOrderFillStatus offers.')
      console.error(e)
      return false
    }

    let feeAmount
    let feeToken
    let timestamp
    try {
      const marketInfo = await this.getMarketInfo(market, chainId)
      if (marketInfo) {
        if (side === 's') {
          feeAmount = marketInfo.baseFee
          feeToken = marketInfo.baseAsset.symbol
        } else {
          feeAmount = marketInfo.quoteFee
          feeToken = marketInfo.quoteAsset.symbol
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
      const valuesFills = [newstatus, feeAmount, feeToken, orderid, chainId]
      const update2 = await this.db.query(
        "UPDATE fills SET fill_status=$1,feeamount=$2,feetoken=$3 WHERE taker_offer_id=$4 AND chainid=$5 AND fill_status IN ('b', 'm') RETURNING id, market, price, amount, maker_user_id, insert_timestamp",
        valuesFills
      )
      if (update2.rows.length > 0) {
        fillId = update2.rows[0].id
        fillPrice = update2.rows[0].price
        makerUserId = update2.rows[0].maker_user_id
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
      const redisKeyTodayPrice = `dailyprice:${chainId}:${market}:${today}`
      this.redis.HSET(`lastprices:${chainId}`, `${market}`, `${fillPrice}`)
      this.redis.SET(`${redisKeyTodayPrice}`, `${fillPrice}`, { EX: 604800 })
    }
    return {
      success,
      fillId,
      market,
      fillPrice,
      makerUserId,
      feeAmount,
      feeToken,
      timestamp,
      userId,
    }
  }

  updateMatchedOrder = async (
    chainId: number,
    orderid: number,
    newstatus: string,
    txhash: string
  ) => {
    chainId = Number(chainId)
    orderid = Number(orderid)
    let update
    let fillId
    let market
    const values = [newstatus, txhash, chainId, orderid]
    try {
      update = await this.db.query(
        "UPDATE offers SET order_status=$1, txhash=$2, update_timestamp=NOW() WHERE chainid=$3 AND id=$4 AND order_status='m' RETURNING userid",
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
    chainId: number,
    market: ZZMarket,
    zktx: ZkTx
  ) => {
    chainId = Number(chainId)

    const inputValidation = zksyncOrderSchema.validate(zktx)
    if (inputValidation.error) throw inputValidation.error
    if (chainId !== 1 && chainId !== 1000) throw new Error("Only for zkSync")
    if ((zktx.validUntil * 1000) < Date.now()) throw new Error("Wrong expiry, check PC clock")

    // TODO: Activate nonce check here
    // if(NONCES[zktx.accountId] && NONCES[zktx.accountId][chainId] && NONCES[zktx.accountId][chainId] > zktx.nonce) {
    //    throw new Error("badnonce");
    // }

    // Prevent DOS attacks. Rate limit one order every 3 seconds.
    const redisRateLimitKey = `ratelimit:zksync:${chainId}:${zktx.accountId}`
    const ratelimit = await this.redis.get(redisRateLimitKey)
    if (ratelimit) throw new Error('Only one order per 3 seconds allowed')
    else {
      await this.redis.SET(
        redisRateLimitKey,
        '1',
        { EX: 3 }
      )
    }

    const marketInfo = await this.getMarketInfo(market, chainId)
    let side
    let baseQuantity
    let quoteQuantity
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
      baseQuantity = zktx.amount / 10 ** marketInfo.baseAsset.decimals
      quoteQuantity = baseQuantity * price
    } else if (
      zktx.tokenSell === marketInfo.quoteAssetId &&
      zktx.tokenBuy === marketInfo.baseAssetId
    ) {
      side = 'b'
      price =
        zktx.ratio[0] /
        10 ** marketInfo.quoteAsset.decimals /
        (zktx.ratio[1] / 10 ** marketInfo.baseAsset.decimals)
      quoteQuantity = zktx.amount / 10 ** marketInfo.quoteAsset.decimals
      baseQuantity =
        ((quoteQuantity / price) as any).toFixed(
          marketInfo.baseAsset.decimals
        ) / 1
    } else {
      throw new Error('Buy/sell tokens do not match market')
    }

    if (side === 's' && baseQuantity < marketInfo.baseFee) {
      throw new Error('Order size inadequate to pay fee')
    }
    if (side === 'b' && quoteQuantity < marketInfo.quoteFee) {
      throw new Error('Order size inadequate to pay fee')
    }
    const orderType = 'limit'
    const expires = zktx.validUntil
    const userid = zktx.accountId
    const queryargs = [
      chainId,
      userid,
      zktx.nonce,
      market,
      side,
      price,
      baseQuantity,
      quoteQuantity,
      orderType,
      'o',
      expires,
      JSON.stringify(zktx),
      baseQuantity,
    ]
    // save order to DB
    const query =
      'INSERT INTO offers(chainid, userid, nonce, market, side, price, base_quantity, quote_quantity, order_type, order_status, expires, zktx, insert_timestamp, unfilled) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13) RETURNING id'
    const insert = await this.db.query(query, queryargs)
    const orderId = insert.rows[0].id
    const orderreceipt = [
      chainId,
      orderId,
      market,
      side,
      price,
      baseQuantity,
      quoteQuantity,
      expires,
      userid.toString(),
      'o',
      null,
      baseQuantity,
    ]

    // broadcast new order
    this.redisPublisher.PUBLISH(
      `broadcastmsg:all:${chainId}:${market}`,
      JSON.stringify({ op: 'orders', args: [[orderreceipt]] })
    )
    this.redisPublisher.PUBLISH(
      `broadcastmsg:user:${chainId}:${userid}`,
      JSON.stringify({ op: 'userorderack', args: orderreceipt })
    )

    return { op: 'userorderack', args: orderreceipt }
  }

  processorderstarknet = async (
    chainId: number,
    market: string,
    ZZMessageString: string
  ) => {
    const ZZMessage = JSON.parse(ZZMessageString)
    const inputValidation = ZZMessageSchema.validate(ZZMessage)
    if (inputValidation.error) throw inputValidation.error
    if (chainId !== 1001) throw new Error("Only for StarkNet")

    const marketInfo = await this.getMarketInfo(market, chainId)
    const { order } = ZZMessage

    order.base_quantity = Number(order.base_quantity)
    if (order.base_quantity <= 0) throw new Error('Quantity cannot be negative')

    order.price.numerator = Number(order.price.numerator)
    if (order.price.numerator <= 0) throw new Error('Price numerator cannot be negative')

    order.price.denominator = Number(order.price.denominator)
    if (order.price.denominator <= 0) throw new Error('Price denominator cannot be negative')

    const userAddress = ZZMessage.sender
    if (order.side !== '1' && order.side !== '0') throw new Error('Invalid side')
    const side = order.side === '0' ? 'b' : 's'
    const baseQuantity = order.base_quantity / 10 ** marketInfo.baseAsset.decimals
    const price = (order.price.numerator / order.price.denominator)

    const quoteQuantity = price * baseQuantity

    // starknet uses unix * 100, generate correct unix
    const expirationStarkNet = Number(order.expiration)
    if ((expirationStarkNet * 10) < Date.now()) throw new Error("Wrong expiry, check PC clock")
    const expiration = (expirationStarkNet / 100) | 0
    // const order_type = 'limit' - set in match_limit_order

    let remainingAmount = baseQuantity

    const query = 'SELECT * FROM match_limit_order($1, $2, $3, $4, $5, $6, $7, $8, $9)'
    const values = [
      chainId,
      userAddress,
      market,
      side,
      price,
      baseQuantity,
      quoteQuantity,
      expiration,
      ZZMessageString
    ]


    const matchquery = await this.db.query(query, values)
    const fillIds = matchquery.rows
      .slice(0, matchquery.rows.length - 1)
      .map((r) => r.id)
    const orderId = matchquery.rows[matchquery.rows.length - 1].id

    const fills = await this.db.query(
      'SELECT fills.*, maker_offer.unfilled AS maker_unfilled, maker_offer.zktx AS maker_zktx, maker_offer.side AS maker_side FROM fills JOIN offers AS maker_offer ON fills.maker_offer_id=maker_offer.id WHERE fills.id = ANY ($1)',
      [fillIds]
    )
    const offerquery = await this.db.query('SELECT * FROM offers WHERE id = $1', [
      orderId,
    ])
    const offer = offerquery.rows[0]

    const orderupdates: any[] = []
    const marketFills: any[] = []
    const liquidityUpdates: any = {}
    fills.rows.forEach(async (row) => {
      if (row.maker_unfilled > 0) {
        orderupdates.push([
          chainId,
          row.maker_offer_id,
          'pm',
          row.amount,
          row.maker_unfilled,
        ])
      } else {
        orderupdates.push([chainId, row.maker_offer_id, 'm'])
      }
      marketFills.push([
        chainId,
        row.id,
        market,
        side,
        row.price,
        row.amount,
        row.fill_status,
        row.txhash,
        row.taker_user_id,
        row.maker_user_id,
      ])

      let buyer: any
      let seller: any
      if (row.maker_side === 'b') {
        buyer = row.maker_zktx
        seller = offer.zktx
      } else if (row.maker_side === 's') {
        buyer = offer.zktx
        seller = row.maker_zktx
      } else {
        throw new Error('Invalid side')
      }
      this.relayStarknetMatch(
        chainId,
        market,
        JSON.parse(buyer),
        JSON.parse(seller),
        row.amount,
        row.price,
        row.id,
        row.maker_offer_id,
        offer.id
      )

      // addes the amount filled to liquidityUpdates to update later
      liquidityUpdates[row.maker_offer_id] = row.amount
      remainingAmount -= row.amount
    })
    const orderMsg = [
      chainId,
      offer.id,
      market,
      offer.side,
      offer.price,
      offer.base_quantity,
      offer.price * offer.base_quantity,
      offer.expires,
      offer.userid,
      offer.order_status,
      null,
      offer.unfilled,
    ]
    this.redisPublisher.PUBLISH(
      `broadcastmsg:all:${chainId}:${market}`,
      JSON.stringify({ op: 'orders', args: [[orderMsg]] })
    )
    if (orderupdates.length > 0) {
      this.redisPublisher.PUBLISH(
        `broadcastmsg:all:${chainId}:${market}`,
        JSON.stringify({ op: 'orderstatus', args: [orderupdates] })
      )
    }
    if (marketFills.length > 0) {
      this.redisPublisher.PUBLISH(
        `broadcastmsg:all:${chainId}:${market}`,
        JSON.stringify({ op: 'fills', args: [marketFills] })
      )
    }
    const liquidityKeys = Object.keys(liquidityUpdates)
    if (liquidityKeys.length > 0) {
      const redisKeyLiquidity = `liquidity:${chainId}:${market}`
      const liquidityList = await this.redis.ZRANGEBYSCORE(
        redisKeyLiquidity,
        '0',
        '1000000'
      )

      const lenght = Object.keys(liquidityList).length
      for (let i = 0; i < lenght; i++) {
        const liquidityString = liquidityList[i]
        const liquidity = JSON.parse(liquidityString)
        if (liquidityKeys.includes(liquidity[4].toString())) {
          // remove outdated liquidity
          this.redis.ZREM(redisKeyLiquidity, liquidityString)

          // substract filledliquidity for that orderID
          const newLiquidity = Number(liquidity[2]) - Number(liquidityUpdates[liquidity[4]])
          if (newLiquidity > Number(marketInfo.baseFee)) {
            // add new liquidity to HSET
            liquidity[2] = newLiquidity
            this.addLiquidity(chainId, market, liquidity)
          }
        }
      }
    }

    // 'remainingAmount > marketInfo.baseFee' => 'remainingAmount > 0'
    // only add to the orderbook if not filled instantly
    if (remainingAmount > marketInfo.baseFee) {
      this.addLiquidity(
        chainId,
        market,
        [side, price, remainingAmount, expiration, offer.id]
      )
    }

    const orderreceipt = [
      chainId,
      orderId,
      market,
      side,
      price,
      baseQuantity,
      quoteQuantity,
      offer.expires,
      offer.userid.toString(),
      'o',
      null,
      baseQuantity,
    ]

    return { op: 'userorderack', args: orderreceipt }
  }

  relayStarknetMatch = async (
    chainId: number,
    market: ZZMarket,
    buyer: any,
    seller: any,
    fillQuantity: number,
    fillPrice: number,
    fillId: number,
    makerOfferId: number,
    takerOfferId: number
  ) => {
    const marketInfo = await this.getMarketInfo(market, chainId)
    const network = await this.getNetwork(chainId)
    const baseAssetDecimals = marketInfo.baseAsset.decimals
    const getFraction = (decimals: number) => {
      let denominator = 1
      for (; (decimals * denominator) % 1 !== 0; denominator++);
      return { numerator: decimals * denominator, denominator }
    }
    const fillPriceRatioNumber = getFraction(fillPrice)
    const calldataFillPrice = [
      fillPriceRatioNumber.numerator.toFixed(0),
      fillPriceRatioNumber.denominator.toFixed(0)
    ]
    const calldataFillQuantity = (fillQuantity * 10 ** baseAssetDecimals).toFixed(0)

    const calldataBuyOrder = [
      stringToFelt(buyer.message_prefix),
      stringToFelt(buyer.domain_prefix.name),
      buyer.domain_prefix.version,
      stringToFelt(buyer.domain_prefix.chain_id),
      buyer.sender,
      buyer.order.base_asset,
      buyer.order.quote_asset,
      buyer.order.side,
      buyer.order.base_quantity,
      buyer.order.price.numerator,
      buyer.order.price.denominator,
      buyer.order.expiration,
      buyer.sig_r,
      buyer.sig_s
    ]

    const calldataSellOrder = [
      stringToFelt(seller.message_prefix),
      stringToFelt(seller.domain_prefix.name),
      seller.domain_prefix.version,
      stringToFelt(seller.domain_prefix.chain_id),
      seller.sender,
      seller.order.base_asset,
      seller.order.quote_asset,
      seller.order.side,
      seller.order.base_quantity,
      seller.order.price.numerator,
      seller.order.price.denominator,
      seller.order.expiration,
      seller.sig_r,
      seller.sig_s
    ]

    let relayResult: any
    try {
      relayResult = await this.STARKNET_EXCHANGE[network].invoke(
        'fill_order',
        [
          calldataBuyOrder,
          calldataSellOrder,
          calldataFillPrice,
          calldataFillQuantity
        ]
      )

      console.log('Starknet tx success')
      const fillupdateBroadcast = await this.db.query(
        "UPDATE fills SET fill_status='b', txhash=$1 WHERE id=$2 RETURNING id, fill_status, txhash",
        [relayResult.transaction_hash, fillId]
      )
      const orderUpdateBroadcast = await this.db.query(
        "UPDATE offers SET order_status='b', update_timestamp=NOW() WHERE id IN ($1, $2) AND unfilled = 0 RETURNING id, order_status, unfilled",
        [makerOfferId, takerOfferId]
      )
      const orderUpdatesBroadcast = orderUpdateBroadcast.rows.map((row) => [
        chainId,
        row.id,
        row.order_status,
        row.unfilled,
      ])
      const fillUpdatesBroadcast = fillupdateBroadcast.rows.map((row) => [
        chainId,
        row.id,
        row.fill_status,
        row.txhash,
        null, // remaing
        0, // fee amount
        0, // fee amount
        Date.now() // timestamp
      ])

      if (orderUpdatesBroadcast.length) {
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:${market}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdatesBroadcast] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${buyer.sender}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdatesBroadcast] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${seller.sender}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdatesBroadcast] })
        )
      }
      if (fillUpdatesBroadcast.length) {
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:${market}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdatesBroadcast] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${buyer.sender}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdatesBroadcast] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${seller.sender}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdatesBroadcast] })
        )
      }

      await starknet.defaultProvider.waitForTransaction(relayResult.transaction_hash)


      console.log(`New starknet tx: ${relayResult.transaction_hash}`)

      // TODO we want to add fees here

      console.log('Starknet tx success')
      const fillupdateFill = await this.db.query(
        "UPDATE fills SET fill_status='f', txhash=$1 WHERE id=$2 RETURNING id, fill_status, txhash",
        [relayResult.transaction_hash, fillId]
      )
      const orderupdateFill = await this.db.query(
        "UPDATE offers SET order_status=(CASE WHEN unfilled > 0 THEN 'pf' ELSE 'f' END), update_timestamp=NOW() WHERE id IN ($1, $2) RETURNING id, order_status, unfilled",
        [makerOfferId, takerOfferId]
      )
      const orderUpdateFills = orderupdateFill.rows.map((row) => [
        chainId,
        row.id,
        row.order_status,
        row.unfilled,
      ])
      const fillUpdateFills = fillupdateFill.rows.map((row) => [
        chainId,
        row.id,
        row.fill_status,
        row.txhash,
        null,
        0, // fee amount - TODO this should be marketInfo fees
        0, // fee token - TODO this should be marketInfo fees
        Date.now() // timestamp
      ])

      if (orderUpdateFills.length) {
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:${market}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdateFills] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${buyer.sender}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdateFills] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${seller.sender}`,
          JSON.stringify({ op: 'orderstatus', args: [orderUpdateFills] })
        )
      }
      if (fillUpdateFills.length) {
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:${market}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdateFills] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${buyer.sender}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdateFills] })
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:user:${chainId}:${seller.sender}`,
          JSON.stringify({ op: 'fillstatus', args: [fillUpdateFills] })
        )
      }
    } catch (e: any) {
      console.log(`Starknet tx failed: ${relayResult.transaction_hash}`)
      console.error(calldataBuyOrder)
      console.error(calldataSellOrder)
      console.error(calldataFillPrice)
      console.error(calldataFillQuantity)
      console.error(e)
      console.error('Starknet tx failed')
      const rejectedFillupdate = await this.db.query(
        "UPDATE fills SET fill_status='r', txhash=$1 WHERE id=$2 RETURNING id, fill_status, txhash",
        [relayResult.transaction_hash, fillId]
      )
      const rejectedOrderupdate = await this.db.query(
        "UPDATE offers SET order_status='r', update_timestamp=NOW() WHERE id IN ($1, $2) RETURNING id, order_status",
        [makerOfferId, takerOfferId]
      )
      const rejectedFillUpdates = rejectedFillupdate.rows.map((row) => [
        chainId,
        row.id,
        row.fill_status,
        row.txhash,
        0, // remaining
        0, // fee amount
        0, // fee amount
        Date.now() // timestamp
      ])
      const rejectedOrderUpdates = rejectedOrderupdate.rows.map((row) => [
        chainId,
        row.id,
        row.order_status,
        relayResult.transaction_hash,
        e.message
      ])
      this.redisPublisher.PUBLISH(
        `broadcastmsg:all:${chainId}:${market}`,
        JSON.stringify({ op: 'orderstatus', args: [rejectedOrderUpdates] })
      )
      this.redisPublisher.PUBLISH(
        `broadcastmsg:user:${chainId}:${buyer.sender}`,
        JSON.stringify({ op: 'orderstatus', args: [rejectedOrderUpdates] })
      )
      this.redisPublisher.PUBLISH(
        `broadcastmsg:user:${chainId}:${seller.sender}`,
        JSON.stringify({ op: 'orderstatus', args: [rejectedOrderUpdates] })
      )

      this.redisPublisher.PUBLISH(
        `broadcastmsg:all:${chainId}:${market}`,
        JSON.stringify({ op: 'fillstatus', args: [rejectedFillUpdates] })
      )
      this.redisPublisher.PUBLISH(
        `broadcastmsg:user:${chainId}:${buyer.sender}`,
        JSON.stringify({ op: 'fillstatus', args: [rejectedFillUpdates] })
      )
      this.redisPublisher.PUBLISH(
        `broadcastmsg:user:${chainId}:${seller.sender}`,
        JSON.stringify({ op: 'fillstatus', args: [rejectedFillUpdates] })
      )
    }
  }

  processOrderZigZag = async(
    chainId: number,
    market: ZZMarket,
    zktx: ZZOrder
  ) => {
    const validChainIds = Object.keys(chainData)
    if (validChainIds.includes(chainId.toString())) throw new Error('Only for 0x style orders')
    const marketInfo = await this.getMarketInfo(market, chainId)
    const {
      operatorAddress,
      feeAddress,
      makerFee,
      takerFee
    } = chainData[chainId as keyof typeof chainData]

    const assets = [
      marketInfo.baseAsset.address,
      marketInfo.quoteAsset.address    
    ]

    /* validate order */
    if(!ethers.utils.isAddress(zktx.makerAddress)) throw new Error('Bad makerAddress') 
    if (zktx.takerAddress !== '0' && !ethers.utils.isAddress(zktx.takerAddress)) throw new Error('Bad takerAddress')
    if (zktx.senderAddress !== '0' && zktx.senderAddress !== operatorAddress) throw new Error(`Bad senderAddress, use '${operatorAddress}' or '0'`)
    const orderSellAsset = await get0xTokenAddress(zktx.makerAssetData).catch(e => { throw new Error(`Bad makerAssetData, ${e}`) })
    if(!assets.includes(orderSellAsset)) throw new Error(`Bad makerAssetData, market ${assets} does not include ${orderSellAsset}`)
    const orderBuyAsset = await get0xTokenAddress(zktx.takerAssetAmount).catch(e => { throw new Error(`Bad takerAssetAmount, ${e}`) })
    if(!assets.includes(orderBuyAsset)) throw new Error(`Bad takerAssetAmount, market ${assets} does not include ${orderSellAsset}`)
    if (orderSellAsset === orderBuyAsset) throw new Error(`Can't buy and sell the same token`)
    const expiry = Number(zktx.expirationTimeSeconds) * 1000
    if (expiry < (Date.now() + 15000)) throw new Error("Expiery time too low. Use at least NOW + 15sec")
    const side = (marketInfo.baseAsset.address === orderBuyAsset) ? 's' : 'b'
    let baseAssetBN
    let quoteAssetBN
    if (side === 's') {
      baseAssetBN = ethers.BigNumber.from(zktx.makerAssetAmount)
      quoteAssetBN = ethers.BigNumber.from(zktx.takerAssetAmount)
    } else {
      baseAssetBN = ethers.BigNumber.from(zktx.takerAssetAmount)
      quoteAssetBN = ethers.BigNumber.from(zktx.makerAssetAmount)
    }

    // check fees
    if (zktx.feeRecipientAddress !== feeAddress) throw new Error(`Bad feeRecipientAddress, use '${feeAddress}'`)
    if (zktx.makerFeeAssetData !== zktx.makerAssetData) throw new Error(`Bad makerFeeAssetData, use the same as makerAssetData`)
    if (zktx.takerFeeAssetData !== zktx.makerAssetData)throw new Error(`Bad takerFeeAssetData, use the same as makerAssetData`)
    const orderMakerFeeAmountBN = ethers.BigNumber.from(zktx.makerFee)
    const orderTakerFeeAmountBN = ethers.BigNumber.from(zktx.takerFee)
    const makerFeeBN = baseAssetBN.div(1/makerFee)
    const takerFeeBN = baseAssetBN.div(1/takerFee) 
    if(orderMakerFeeAmountBN.lt(makerFeeBN)) throw new Error(`Bad makerFee, minimum is ${makerFee}`)
    if(orderTakerFeeAmountBN.lt(takerFeeBN)) throw new Error(`Bad takerFee, minimum is ${takerFee}`)

    /* validate order */
      
    const baseAmount = baseAssetBN.div(10**marketInfo.baseAsset.decimals).toNumber()
    const quoteAmount = quoteAssetBN.div(10**marketInfo.quoteAsset.decimals).toNumber()
    const price = quoteAmount / baseAmount



    /*
    TODO return
    const orderreceipt = [
      chainId,
      orderId,
      market,
      side,
      price,
      baseQuantity,
      quoteQuantity,
      offer.expires,
      offer.userid.toString(),
      'o',
      null,
      baseQuantity,
    ]


    return { op: 'userorderack', args: orderreceipt }
    */
  }

  cancelallorders = async (
    chainId: number,
    userid: string | number
  ) => {
    let orders: any
    if (chainId) {
      // cancel for chainId set
      const values = [userid, chainId]
      orders = await this.db.query(
        "UPDATE offers SET order_status='c',zktx=NULL, update_timestamp=NOW() WHERE userid=$1 AND chainid=$2 AND order_status='o' RETURNING chainid, market, id;",
        values
      )
    } else {
      // cancel for all chainIds - chainId not set
      const values = [userid]
      orders = await this.db.query(
        "UPDATE offers SET order_status='c',zktx=NULL, update_timestamp=NOW() WHERE userid=$1 AND order_status='o' RETURNING chainid, market, id;",
        values
      )
    }

    if (orders.rows.length === 0) throw new Error('No open Orders')

    this.VALID_CHAINS.forEach(async (broadcastChainId) => {
      const orderStatusUpdate = orders.rows
        .filter((o: any) => Number(o.chainid) === broadcastChainId)
        .map((o: any) => [
          o.chainid,
          o.id,
          o.market
        ])

      await this.redisPublisher.publish(
        `broadcastmsg:all:${broadcastChainId}:all`,
        JSON.stringify({ op: 'orderstatus', args: [orderStatusUpdate], })
      )
      await this.redisPublisher.publish(
        `broadcastmsg:user:${broadcastChainId}:${userid}`,
        JSON.stringify({ op: 'orderstatus', args: [orderStatusUpdate], })
      )
    })

    return true
  }

  cancelorder = async (
    chainId: number,
    orderId: string,
    ws?: WSocket
  ) => {
    const values = [orderId, chainId]
    const select = await this.db.query(
      'SELECT userid, order_status FROM offers WHERE id=$1 AND chainid=$2',
      values
    )

    if (select.rows.length === 0) {
      throw new Error('Order not found')
    }

    const userconnkey = `${chainId}:${select.rows[0].userid}`

    if (select.rows[0].order_status !== 'o') {
      throw new Error('Order is no longer open')
    }

    if (this.USER_CONNECTIONS[userconnkey] !== ws) {
      throw new Error('Unauthorized')
    }

    const updatevalues = [orderId]
    const update = await this.db.query(
      "UPDATE offers SET order_status='c', zktx=NULL, update_timestamp=NOW() WHERE id=$1 RETURNING market",
      updatevalues
    )

    if (update.rows.length > 0) {
      await this.redisPublisher.publish(
        `broadcastmsg:all:${chainId}:${update.rows[0].market}`,
        JSON.stringify({ op: 'orderstatus', args: [[[chainId, orderId, 'c']]], })
      )
    } else {
      throw new Error('Order not found')
    }

    return true
  }

  matchorder = async (
    chainId: number,
    orderId: string,
    fillOrder: ZZFillOrder,
    wsUUID: string
  ) => {
    const values = [orderId, chainId]
    const select = await this.db.query(
      "SELECT userid, price, base_quantity, quote_quantity, market, zktx, side FROM offers WHERE id=$1 AND chainid=$2 AND order_status='o'",
      values
    )
    if (select.rows.length === 0) {
      throw new Error(`Order ${orderId} is not open`)
    }

    const selectresult = select.rows[0]

    // Determine fill price
    const marketInfo = await this.getMarketInfo(selectresult.market, chainId)
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

    const fillPrice = formatPrice(quoteQuantity / baseQuantity)
    const redisMembers: any = {
      score: fillPrice,
      value: JSON.stringify({
        "zktx": JSON.parse(selectresult.zktx),
        "market": selectresult.market,
        "baseQuantity": selectresult.base_quantity,
        "quoteQuantity": selectresult.quote_quantity,
        "userId": selectresult.userid,
        "fillOrder": fillOrder,
        "wsUUID": wsUUID
      })
    }

    const redisKey = `matchingorders:${chainId}:${orderId}`
    const existingMembers = await this.redis.ZCOUNT(redisKey, 0, 99999999)
    this.redis.ZADD(redisKey, redisMembers)
    if (existingMembers === 0) {
      this.redis.EXPIRE(redisKey, 10)
      setTimeout(
        this.senduserordermatch,
        250,
        chainId,
        orderId,
        selectresult.side)
    }
  }

  senduserordermatch = async (
    chainId: number,
    orderId: string,
    side: string
  ) => {
    const redisKeyMatchingOrder = `matchingorders:${chainId}:${orderId}`
    const existingMembers = await this.redis.ZCOUNT(redisKeyMatchingOrder, -Infinity, Infinity)
    if (existingMembers === 0) {
      return
    }

    let redisMembers
    if (side === 'b') {
      redisMembers = await this.redis.ZPOPMIN(redisKeyMatchingOrder)
    } else {
      redisMembers = await this.redis.ZPOPMAX(redisKeyMatchingOrder)
    }
    if (!redisMembers) {
      return
    }

    const fillPrice = redisMembers.score
    const value = JSON.parse(redisMembers.value)
    const { fillOrder } = value
    const makerAccountId = fillOrder.accountId.toString()

    let fill
    const redisKeyBussy = `bussymarketmaker:${chainId}:${makerAccountId}`
    try {
      const redisBusyMM = (await this.redis.get(redisKeyBussy)) as string
      if (redisBusyMM) {
        const processingOrderId: number = (JSON.parse(redisBusyMM) as any).orderId
        const remainingTime = await this.redis.ttl(redisKeyBussy)
        this.redisPublisher.PUBLISH(
          `broadcastmsg:maker:${chainId}:${value.wsUUID}`,
          JSON.stringify({
            op: 'error',
            args: [
              'fillrequest',
              makerAccountId,
              `Your address did not respond to order (${processingOrderId}) yet. Remaining timeout: ${remainingTime}.`
            ]
          })
        )
        throw new Error('fillrequest - market maker is timed out.')
      }


      let priceWithoutFee: string
      try {
        const marketInfo = await this.getMarketInfo(value.market, chainId)
        if (side === 's') {
          const quoteQuantity = Number(fillOrder.amount) / 10 ** marketInfo.quoteAsset.decimals
          const baseQuantityWithoutFee = value.baseQuantity - marketInfo.baseFee
          priceWithoutFee = formatPrice(quoteQuantity / baseQuantityWithoutFee)
        } else {
          const baseQuantity = Number(fillOrder.amount) / 10 ** marketInfo.baseAsset.decimals
          const quoteQuantityWithoutFee = value.quoteQuantity - marketInfo.quoteFee
          priceWithoutFee = formatPrice(quoteQuantityWithoutFee / baseQuantity)
        }
      } catch (e: any) {
        console.log(e.message)
        priceWithoutFee = fillPrice.toString()
      }

      let values = [orderId, chainId]
      const update1 = await this.db.query(
        "UPDATE offers SET order_status='m' WHERE id=$1 AND chainid=$2 AND order_status='o' RETURNING id",
        values
      )
      if (update1.rows.length === 0)
        // this *should* not happen, so no need to send to ws
        throw new Error(`Order ${orderId} is not open`)

      values = [
        chainId,
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
      const fillId = update2.rows[0].id
      fill = [
        chainId,
        fillId,
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

      this.redisPublisher.PUBLISH(
        `broadcastmsg:maker:${chainId}:${value.wsUUID}`,
        JSON.stringify({
          op: 'userordermatch',
          args: [chainId, orderId, value.zktx, fillOrder],
        })
      )

      // update user
      this.redisPublisher.PUBLISH(
        `broadcastmsg:user:${chainId}:${value.userId}`,
        JSON.stringify({ op: 'orderstatus', args: [[[chainId, orderId, 'm']]], })
      )

      this.redis.SET(
        redisKeyBussy,
        JSON.stringify({ "orderId": orderId, "ws_uuid": value.wsUUID }),
        { EX: this.MARKET_MAKER_TIMEOUT }
      )
    } catch (err: any) {
      if (err.message.includes('is not open')) {
        console.log(`Failed to match order because ${err.message}. Abort`)
      } else {
        console.log(`Failed to match order because ${err.message}, sending next best`)
        // try next best one
        this.senduserordermatch(
          chainId,
          orderId,
          side
        )
      }
      return
    }

    try {
      // send result to other mm's, remove set
      const otherMakerList: any[] = await this.redis.ZRANGE(redisKeyMatchingOrder, 0, -1)
      otherMakerList.map(async (otherMaker: any) => {
        const otherValue = JSON.parse(otherMaker)
        const otherFillOrder = otherValue.fillOrder
        const otherMakerAccountId = otherFillOrder.accountId.toString()
        this.redisPublisher.PUBLISH(
          `broadcastmsg:maker:${chainId}:${otherValue.wsUUID}`,
          JSON.stringify({
            op: 'error',
            args: [
              'fillrequest',
              otherMakerAccountId,
              "The Order was filled by better offer"
            ],
          })
        )
      })
    } catch (err: any) {
      console.log(`senduserordermatch: Error while updating other mms: ${err.message}`)
    }

    this.redisPublisher.PUBLISH(
      `broadcastmsg:all:${chainId}:${value.market}`,
      JSON.stringify({ op: 'orderstatus', args: [[[chainId, orderId, 'm']]] })
    )
    this.redisPublisher.PUBLISH(
      `broadcastmsg:all:${chainId}:${value.market}`,
      JSON.stringify({ op: 'fills', args: [[fill]] })
    )
  }

  /**
   * Broadcast message to all subscibed connections
   * @param chainId
   * @param market market alias - all for all markets
   * @param msg JSON.stringify( WSMessage )
   */
  broadcastMessage = async (
    chainId: number,
    market: ZZMarket,
    msg: string
  ) => {
    ; (this.wss.clients as Set<WSocket>).forEach((ws: WSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (ws.chainid !== chainId) return
      if (market !== "all" && !ws.marketSubscriptions.includes(market)) return
      ws.send(msg)
    })
  }

  /**
   * Send msg to user
   * @param chainId 
   * @param userId user ws id like: `${chainId}:${userid}`
   * @param msg JSON.stringify( WSMessage )
   */
  sendMessageToUser = async (
    chainId: number,
    userId: string,
    msg: string
  ) => {
    const userConnKey = `${chainId}:${userId}`
    const userWs = this.USER_CONNECTIONS[userConnKey]
    if (userWs) {
      userWs.send(msg)
    }
  }

  /**
 * Send msg to marketmaker (zkSync V1.X)
 * @param chainId 
 * @param marketmakerId user ws id like: `${chainId}:${userid}`
 * @param msg JSON.stringify( WSMessage )
 */
  sendMessageToMM = async (
    chainId: number,
    marketmakerId: string,
    msg: string
  ) => {
    const makerConnKey = `${chainId}:${marketmakerId}`
    const makerWs = this.MAKER_CONNECTIONS[makerConnKey]
    if (makerWs) {
      makerWs.send(msg)
    }
  }

  /**
   * Returns the liquidity for a given market.
   * @param {number} chainId The reqested chain (1->zkSync, 1000->zkSync_rinkeby)
   * @param {ZZMarket} market The reqested market
   * @param {number} depth Depth of returned liquidity (depth/2 buckets per return)
   * @param {number} level Level of returned liquidity (1->best ask/bid, 2->0.05% steps, 3->all)
   * @return {number} The resulting liquidity -> {"timestamp": _, "bids": _, "asks": _}
   */
  getLiquidityPerSide = async (
    chainId: number,
    market: ZZMarket,
    depth = 0,
    level = 3
  ) => {
    const timestamp = Date.now()
    const liquidity = await this.getLiquidity(chainId, market)
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
      let marketInfo: any = {}
      try {
        marketInfo = await this.getMarketInfo(market, chainId)
      } catch (e: any) {
        console.log(e.message)
        return {
          timestamp,
          bids: [],
          asks: [],
        }
      }
      // get mid price
      const redisKeyPrices = `lastprices:${chainId}`
      const midPrice = Number(await this.redis.HGET(redisKeyPrices, market))
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

  addLiquidity = async (
    chainId: number,
    market: ZZMarket,
    liquidity: any[]
  ) => {
    const redisKeyLiquidity = `liquidity:${chainId}:${market}`
    const redisMember = {
      score: Number(liquidity[1]),
      value: JSON.stringify(liquidity),
    }
    this.redis.ZADD(
      redisKeyLiquidity,
      redisMember
    )
    this.redis.SADD(`activemarkets:${chainId}`, market)
  }

  getLiquidity = async (
    chainId: number,
    market: ZZMarket
  ) => {
    const redisKeyLiquidity = `liquidity:${chainId}:${market}`
    const liquidityList = await this.redis.ZRANGEBYSCORE(
      redisKeyLiquidity,
      '0',
      '1000000'
    )
    if (liquidityList.length === 0) return []

    const activeLiquidity: string[] = []
    const now = Date.now() / 1000 | 0
    for (let i = 0; i < liquidityList.length; i++) {
      const liquidityString = liquidityList[i]
      const liquidity = JSON.parse(liquidityString)
      const expiration = Number(liquidity[3])

      if (Number.isNaN(expiration) || expiration < now) {
        // liquidity is expired, remove
        this.redis.ZREM(redisKeyLiquidity, liquidityString)
      } else {
        // liquidity is good, add to activeLiquidit
        activeLiquidity.push(liquidity)
      }
    }
    return activeLiquidity
  }

  getopenorders = async (chainId: number, market: string) => {
    chainId = Number(chainId)
    const query = {
      text: "SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status,unfilled,txhash FROM offers WHERE market=$1 AND chainid=$2 AND order_status IN ('o', 'pm', 'pf')",
      values: [market, chainId],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  getorder = async (chainId: number, orderid: string) => {
    chainId = Number(chainId)
    const query = {
      text: 'SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status,unfilled,txhash FROM offers WHERE chainid=$1 AND id=$2',
      values: [chainId, orderid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    if (select.rows.length === 0) throw new Error('Order not found')
    const order = select.rows[0]
    return order
  }

  getuserfills = async (chainId: number, userid: string) => {
    chainId = Number(chainId)
    const query = {
      text: 'SELECT chainid,id,market,side,price,amount,fill_status,txhash,taker_user_id,maker_user_id,feeamount,feetoken,insert_timestamp FROM fills WHERE chainid=$1 AND (maker_user_id=$2 OR taker_user_id=$2) ORDER BY id DESC LIMIT 25',
      values: [chainId, userid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  getuserorders = async (chainId: number, userid: string) => {
    const query = {
      text: "SELECT chainid,id,market,side,price,base_quantity,quote_quantity,expires,userid,order_status FROM offers WHERE chainid=$1 AND userid=$2 AND order_status IN ('o','pm','pf') ORDER BY id DESC LIMIT 25",
      values: [chainId, userid],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    return select.rows
  }

  /**
   * Returns fills for a given market.
   * @param {number} chainId reqested chain (1->zkSync, 1000->zkSync_rinkeby)
   * @param {ZZMarket} market reqested market
   * @param {number} limit number of trades returnd (MAX 25)
   * @param {number} orderId orderId to start at
   * @param {number} type side of returned fills 's', 'b', 'buy' or 'sell'
   * @param {number} startTime time for first fill
   * @param {number} endTime time for last fill
   * @param {number} accountId accountId to search for (maker or taker)
   * @param {string} direction used to set ASC or DESC ('older' or 'newer')
   * @return {number} array of fills [[chainId,id,market,side,price,amount,fill_status,txhash,taker_user_id,maker_user_id,feeamount,feetoken,insert_timestamp],...]
   */
  getfills = async (
    chainId: number,
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

    if (market) {
      text += ` AND market = '${market}'`
    }

    let sqlDirection = "DESC"
    if (direction) {
      if (direction === "older") {
        sqlDirection = "DESC"
      } else if (direction === "newer") {
        sqlDirection = "ASC"
      } else {
        throw new Error("Only direction 'older' or 'newer' is allowed.")
      }
    }

    if (orderId) {
      if (sqlDirection === "DESC") {
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
        values: [chainId],
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
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString()
    const query = {
      text: "SELECT chainid, market, SUM(amount) AS base_volume FROM fills WHERE fill_status IN ('m', 'f', 'b') AND insert_timestamp > $1 AND chainid IS NOT NULL GROUP BY (chainid, market)",
      values: [oneDayAgo],
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
        const redisKeyBase = `volume:${row.chainid}:base`
        const redisKeyQuote = `volume:${row.chainid}:quote`
        this.redis.HSET(redisKeyBase, row.market, baseVolume)
        this.redis.HSET(redisKeyQuote, row.market, quoteVolume)
      } catch (err) {
        console.error(err)
        console.log('Could not update volumes')
      }
    })

    try {
      // remove zero volumes
      this.VALID_CHAINS.forEach(async (chainId) => {
        const nonZeroMarkets = select.rows.filter(row => row.chainid === chainId)
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
    // TODO back to one min, temp 300, starknet is too slow
    const oneMinAgo = new Date(Date.now() - 300 * 1000).toISOString()
    let orderUpdates: string[][] = []
    const query = {
      text: "UPDATE offers SET order_status='c', update_timestamp=NOW() WHERE (order_status IN ('m', 'b', 'pm') AND update_timestamp < $1) OR (order_status='o' AND unfilled = 0) RETURNING chainid, id, order_status;",
      values: [oneMinAgo],
    }
    const update = await this.db.query(query)
    if (update.rowCount > 0) {
      orderUpdates = orderUpdates.concat(update.rows.map((row) => [
        row.chainid,
        row.id,
        row.order_status,
      ]))
    }

    // Update fills
    const fillsQuery = {
      text: "UPDATE fills SET fill_status='e', feeamount=0 WHERE fill_status IN ('m', 'b', 'pm') AND insert_timestamp < $1",
      values: [oneMinAgo],
    }
    await this.db.query(fillsQuery)

    const expiredQuery = {
      text: "UPDATE offers SET order_status='e', zktx=NULL, update_timestamp=NOW() WHERE order_status = 'o' AND expires < EXTRACT(EPOCH FROM NOW()) RETURNING chainid, id, order_status",
      values: [],
    }
    const updateExpires = await this.db.query(expiredQuery)
    if (updateExpires.rowCount > 0) {
      orderUpdates = orderUpdates.concat(updateExpires.rows.map((row) => [
        row.chainid,
        row.id,
        row.order_status,
      ]))
    }

    if (orderUpdates.length > 0) {
      this.VALID_CHAINS.forEach((chainId: number) => {
        const updatesForThisChain = orderUpdates.filter(row => Number(row[0]) === chainId)
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:all`,
          JSON.stringify({ op: 'orderstatus', args: [updatesForThisChain] })
        )
      })
    }
    return true
  }

  getLastPrices = async (
    chainId: number,
    markets: ZZMarket[] = []
  ) => {
    const lastprices: any[] = []
    const redisKeyPrices = `lastprices:${chainId}`
    const redisKeyVolumesQuote = `volume:${chainId}:quote`
    const redisKeyVolumesBase = `volume:${chainId}:base`
    const redisPrices = await this.redis.HGETALL(redisKeyPrices)
    const redisPricesQuote = await this.redis.HGETALL(redisKeyVolumesQuote)
    const redisVolumesBase = await this.redis.HGETALL(redisKeyVolumesBase)
    if (markets.length === 0) {
      markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
    }

    const results: Promise<any>[] = markets.map(async (marketId) => {
      let marketInfo: any = null
      try {
        marketInfo = await this.getMarketInfo(marketId, chainId)
      } catch (e: any) {
        return
      }
      if (!marketInfo) {
        return
      }
      const yesterday = new Date(Date.now() - 86400 * 1000)
        .toISOString()
        .slice(0, 10)
      const yesterdayPrice = Number(
        await this.redis.get(`dailyprice:${chainId}:${marketId}:${yesterday}`)
      )
      const price = +redisPrices[marketId]
      const priceChange = Number(formatPrice(price - yesterdayPrice))
      const quoteVolume = redisPricesQuote[marketId] || 0
      const baseVolume = redisVolumesBase[marketId] || 0
      lastprices.push([marketId, price, priceChange, quoteVolume, baseVolume])
    })
    await Promise.all(results)
    return lastprices
  }

  getMarketSummarys = async (chainId: number, marketReq = '') => {
    const redisKeyMarketSummary = `marketsummary:${chainId}`
    let markets
    if (marketReq === '') {
      const cache = await this.redis.GET(redisKeyMarketSummary)
      if (cache) {
        return JSON.parse(cache)
      }
      markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
    } else {
      markets = [marketReq]
    }
    const marketSummarys: any = {}
    const redisKeyPrices = `lastprices:${chainId}`
    const redisPrices = await this.redis.HGETALL(redisKeyPrices)

    const redisKeyVolumesQuote = `volume:${chainId}:quote`
    const redisKeyVolumesBase = `volume:${chainId}:base`
    const redisVolumesQuote = await this.redis.HGETALL(redisKeyVolumesQuote)
    const redisVolumesBase = await this.redis.HGETALL(redisKeyVolumesBase)

    const redisKeyLow = `price:${chainId}:low`
    const redisKeyHigh = `price:${chainId}:high`
    const redisPricesLow = await this.redis.HGETALL(redisKeyLow)
    const redisPricesHigh = await this.redis.HGETALL(redisKeyHigh)

    const results: Promise<any>[] = markets.map(async (market: ZZMarket) => {
      let marketInfo: any = null
      try {
        marketInfo = await this.getMarketInfo(market, chainId)
      } catch (e: any) {
        return
      }
      if (!marketInfo) return
      const yesterday = new Date(Date.now() - 86400 * 1000).toISOString()
      const yesterdayPrice = Number(
        await this.redis.get(
          `dailyprice:${chainId}:${market}:${yesterday.slice(0, 10)}`
        )
      )
      const lastPrice = +redisPrices[market]
      const priceChange = Number(formatPrice(lastPrice - yesterdayPrice))
      // eslint-disable-next-line camelcase
      const priceChangePercent_24h = Number(formatPrice(priceChange / lastPrice))

      // get low/high price
      // eslint-disable-next-line camelcase
      const lowestPrice_24h = Number(redisPricesLow[market])
      // eslint-disable-next-line camelcase
      const highestPrice_24h = Number(redisPricesHigh[market])

      // get volume
      const quoteVolume = Number(redisVolumesQuote[market] || 0)
      const baseVolume = Number(redisVolumesBase[market] || 0)

      // get best ask/bid
      const liquidity = await this.getLiquidityPerSide(chainId, market, 0, 1)
      const lowestAsk = Number(formatPrice(liquidity.asks[0]?.[0]))
      const highestBid = Number(formatPrice(liquidity.bids[0]?.[0]))

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
        // eslint-disable-next-line camelcase
        priceChangePercent_24h,
        // eslint-disable-next-line camelcase
        highestPrice_24h,
        // eslint-disable-next-line camelcase
        lowestPrice_24h,
      }
      marketSummarys[market] = marketSummary
    })
    await Promise.all(results)
    if (marketReq === '') {
      this.redis.SET(
        redisKeyMarketSummary,
        JSON.stringify(marketSummarys),
        { EX: 10 }
      )
    }
    return marketSummarys
  }

  updatePriceHighLow = async () => {
    // only one dyno needs to update this
    const redisPriceHighLowKey = 'update:PriceHighLow'
    const lock = await this.redis.get(redisPriceHighLowKey)
    if (lock) {
      return
    }
    await this.redis.SET(redisPriceHighLowKey, '1', { EX: 300 })

    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString()
    const select = await this.db.query(
      "SELECT chainid, market, MIN(price) AS min_price, MAX(price) AS max_price FROM fills WHERE insert_timestamp > $1 AND fill_status='f' AND chainid IS NOT NULL GROUP BY (chainid, market)",
      [oneDayAgo]
    )
    select.rows.forEach(async (row) => {
      const redisKeyLow = `price:${row.chainid}:low`
      const redisKeyHigh = `price:${row.chainid}:high`
      this.redis.HSET(redisKeyLow, row.market, row.min_price)
      this.redis.HSET(redisKeyHigh, row.market, row.max_price)
    })

    // delete inactive markets
    this.VALID_CHAINS.forEach(async (chainId) => {
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
      const priceKeysLow = await this.redis.HKEYS(`price:${chainId}:low`)
      const delKeysLow = priceKeysLow.filter((k) => !markets.includes(k))
      delKeysLow.forEach(async (key) => {
        this.redis.HDEL(`price:${chainId}:low`, key)
      })
      const priceKeysHigh = await this.redis.HKEYS(`price:${chainId}:high`)
      const delKeysHigh = priceKeysHigh.filter((k) => !markets.includes(k))
      delKeysHigh.forEach(async (key) => {
        this.redis.HDEL(`price:${chainId}:high`, key)
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
    chainId: number,
    market: ZZMarket,
    side: ZZMarketSide,
    baseQuantity: number,
    quoteQuantity: number
  ) => {
    if (baseQuantity && quoteQuantity)
      throw new Error('Only one of baseQuantity or quoteQuantity should be set')
    if (![1, 1000].includes(chainId))
      throw new Error('Quotes not supported for this chain')
    if (!['b', 's'].includes(side)) throw new Error('Invalid side')

    if (baseQuantity) baseQuantity = Number(baseQuantity)
    if (quoteQuantity) quoteQuantity = Number(quoteQuantity)
    if (baseQuantity && baseQuantity <= 0)
      throw new Error('Quantity must be positive')
    if (quoteQuantity && quoteQuantity <= 0)
      throw new Error('Quantity must be positive')

    const marketInfo = await this.getMarketInfo(market, chainId)
    const liquidity = await this.getLiquidity(chainId, market)
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
        hardPrice = formatPrice(hardQuoteQuantity / hardBaseQuantity)
        softPrice = formatPrice(hardPrice * 1.001)
      } else {
        hardQuoteQuantity = (
          (baseQuantity - marketInfo.baseFee) *
          ladderPrice
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = formatPrice(hardQuoteQuantity / hardBaseQuantity)
        softPrice = formatPrice(hardPrice * 0.999)
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
        hardPrice = formatPrice(hardQuoteQuantity / hardBaseQuantity)
        softPrice = formatPrice(hardPrice * 1.0005)
      } else {
        const bids = liquidity
          .filter((l: any) => l[0] === 'b')
          .map((l: any) => [l[1], Number(l[1]) * Number(l[2])])
        ladderPrice = API.getQuoteFromLadder(bids, quoteQuantity)

        hardBaseQuantity = (
          quoteQuantity / ladderPrice +
          marketInfo.baseFee
        ).toFixed(marketInfo.baseAsset.decimals)
        hardPrice = formatPrice(hardQuoteQuantity / Number(hardBaseQuantity))
        softPrice = formatPrice(hardPrice * 0.9995)
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
    ; (this.wss.clients as Set<WSocket>).forEach((ws) => {
      if (!ws.isAlive) {
        const userconnkey = `${ws.chainid}:${ws.userid}`
        delete this.USER_CONNECTIONS[userconnkey]
        delete this.MAKER_CONNECTIONS[userconnkey]
        ws.terminate()
      } else {
        ws.isAlive = false
        ws.ping()
      }
    })

    console.log(`${this.wss.clients.size} dead connections cleared.`)
  }

  broadcastLiquidity = async () => {
    const result = this.VALID_CHAINS.map(async (chainId) => {
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
      if (!markets || markets.length === 0) return
      const results: Promise<any>[] = markets.map(async (marketId) => {
        const liquidity = await this.getLiquidity(chainId, marketId)
        if (liquidity.length === 0) {
          await this.redis.SREM(`activemarkets:${chainId}`, marketId)
          return
        }
        this.broadcastMessage(
          chainId,
          marketId,
          JSON.stringify({ op: 'liquidity2', args: [chainId, marketId, liquidity] })
        )

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
        this.redis.HSET(
          `lastprices:${chainId}`,
          marketId,
          formatPrice(mid)
        )
      })
      // Broadcast last prices
      const lastprices = (await this.getLastPrices(chainId)).map((l) =>
        l.splice(0, 3)
      )
      this.broadcastMessage(
        chainId,
        'all',
        JSON.stringify({ op: 'lastprice', args: [lastprices] })
      )

      // eslint-disable-next-line consistent-return
      return Promise.all(results)
    })

    return Promise.all(result)
  }

  updateLiquidity = async (
    chainId: number,
    market: ZZMarket,
    liquidity: any[],
    clientId: string
  ) => {
    const FIFTEEN_SECONDS = ((Date.now() / 1000) | 0) + 15
    const marketInfo = await this.getMarketInfo(market, chainId)

    const redisKeyPassive = `passivews:${chainId}:${clientId}`
    const msg = await this.redis.get(redisKeyPassive)
    if (msg) {
      const remainingTime = await this.redis.ttl(redisKeyPassive)
      throw new Error(`Your address did not respond to order ${msg
        } yet. Remaining timeout: ${remainingTime}.`
      )
    }

    const [baseToken, quoteToken] = market.split('-')
    const basePrice = await this.getUsdPrice(chainId, baseToken)
    const quotePrice = await this.getUsdPrice(chainId, quoteToken)
    const midPrice = (basePrice && quotePrice)
      ? basePrice / quotePrice
      : 0
    const minSize = (basePrice) ? (10 / basePrice) : marketInfo.baseFee

    const redisKeyLiquidity = `liquidity:${chainId}:${market}`

    // Delete old liquidity by same client
    if (clientId) {
      const oldLiquidity = await this.redis.ZRANGEBYSCORE(
        redisKeyLiquidity,
        '0',
        '1000000'
      )
      const lenght = Object.keys(oldLiquidity).length
      for (let i = 0; i < lenght; i++) {
        const liquidityString = oldLiquidity[i]
        const liquidityPosition = JSON.parse(liquidityString)
        if (clientId === liquidityPosition[4]?.toString()) {
          this.redis.ZREM(
            redisKeyLiquidity,
            liquidityString
          )
        }
      }
    }

    const errorMsg: string[] = []
    const redisMembers: any[] = []
    for (let i = 0; i < liquidity.length; i++) {
      const l: any[] = liquidity[i]
      const price = Number(l[1])
      const amount = Number(l[2])

      // validation
      if (!['b', 's'].includes(l[0])) {
        errorMsg.push('Bad side')
      } else if (Number.isNaN(price)) {
        errorMsg.push('Price is not a number')
      } else if (price < 0) {
        errorMsg.push('Price cant be negative')
      } else if (Number.isNaN(amount)) {
        errorMsg.push('Amount is not a number')
      } else if (amount < minSize) {
        errorMsg.push('Amount too small')
      } else if (
        midPrice &&
        (price < midPrice * 0.25 || price > midPrice * 1.75)
      ) {
        errorMsg.push('Your price is too far from the mid Price')
      } else {
        // Add expirations to liquidity if needed
        if (!l[3] || Number(l[3]) > FIFTEEN_SECONDS) {
          l[3] = FIFTEEN_SECONDS
        }
        if (clientId) l[4] = clientId

        // Set new liquidity
        redisMembers.push({
          score: l[1],
          value: JSON.stringify(l),
        })
      }
    }

    if (errorMsg.length > 0) {
      const errorString = `Send one or more invalid liquidity positions: ${errorMsg.join('. ')}.`
      this.redisPublisher.PUBLISH(
        `broadcastmsg:maker:${chainId}:${clientId}`,
        JSON.stringify({ op: 'error', args: ['indicateliq2', errorString] })
      )
    }

    if (redisMembers.length > 0) {
      try {
        await this.redis.ZADD(redisKeyLiquidity, redisMembers)
      } catch (e) {
        console.log('updateLiquidity')
        console.error(e)
        console.log(liquidity)
        console.log(redisKeyLiquidity)
        console.log(redisMembers)
      }
    } else {
      throw new Error('No valid liquidity send')
    }
    await this.redis.SADD(`activemarkets:${chainId}`, market)
  }

  updatePassiveMM = async () => {
    const orders = this.VALID_CHAINS.map(async (chainId: number) => {
      const redisPattern = `bussymarketmaker:${chainId}:*`
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
            const redisKey = `passivews:${chainId}:${marketmaker.ws_uuid}`
            const passivews = await this.redis.get(redisKey)
            if (!passivews) {
              this.redis.SET(
                redisKey,
                JSON.stringify(marketmaker.orderId),
                { EX: remainingTime }
              )
            }
          }
        }
      })

      return Promise.all(results)
    })

    return Promise.all(orders)
  }

  populateV1TokenIds = async () => {
    for (let i = 0; ;) {
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

  getV1Markets = async (chainId: number) => {
    const v1Prices = await this.getLastPrices(chainId)
    const v1markets = v1Prices.map((l) => l[0])
    return v1markets
  }

  dailyVolumes = async (chainId: number) => {
    const redisKey = `volume:history:${chainId}`
    const cache = await this.redis.get(redisKey)
    if (cache) return JSON.parse(cache)
    const query = {
      text: "SELECT chainid, market, DATE(insert_timestamp) AS trade_date, SUM(base_quantity) AS base_volume, SUM(quote_quantity) AS quote_volume FROM offers WHERE order_status IN ('m', 'f', 'b') AND chainid = $1 GROUP BY (chainid, market, trade_date)",
      values: [chainId],
      rowMode: 'array',
    }
    const select = await this.db.query(query)
    const volumes = select.rows
    await this.redis.SET(redisKey, JSON.stringify(volumes))
    await this.redis.expire(redisKey, 1200)
    return volumes
  }

  getTokenInfo = async (
    chainId: number,
    tokenSymbol: string
  ): Promise<any> => {
    const cache = await this.redis.HGET(`tokeninfo:${chainId}`, tokenSymbol)
    if (cache) {
      const tokenInfo = JSON.parse(cache)
      return tokenInfo
    }
    return null
  }

  getUsdPrice = async (
    chainId: number,
    tokenSymbol: string
  ): Promise<number> => {
    const cache = await this.redis.HGET(`tokeninfo:${chainId}`, tokenSymbol)
    if (cache) {
      const tokenInfo = JSON.parse(cache)
      return Number(tokenInfo.usdPrice)
    }
    return 0
  }

  updateUsdPrice = async () => {
    // only one dyno needs to update this
    const redisUSDPriceKey = 'update:usdprice'
    const lock = await this.redis.get(redisUSDPriceKey)
    if (lock) {
      return
    }
    await this.redis.SET(redisUSDPriceKey, '1', { EX: 9 })

    console.time("Updating usd price.")
    // use mainnet as price source TODO we should rework the price source to work with multible networks
    const network = await this.getNetwork(1)
    const results0: Promise<any>[] = this.VALID_CHAINS.map(async (chainId) => {
      const updatedTokenPrice: any = {}
      // fetch redis 
      const markets = await this.redis.SMEMBERS(`activemarkets:${chainId}`)
      const tokenInfos = await this.redis.HGETALL(`tokeninfo:${chainId}`)
      // get active tokens once
      let tokenSymbols = markets.join('-').split('-')
      tokenSymbols = tokenSymbols.filter((x, i) => i === tokenSymbols.indexOf(x))
      const results1: Promise<any>[] = tokenSymbols.map(async (token: string) => {
        const tokenInfoString = tokenInfos[token]
        if (!tokenInfoString) return
        const tokenInfo = JSON.parse(tokenInfoString)

        try {
          const fetchResult = await fetch(`${this.ZKSYNC_BASE_URL[network]}tokens/${token}/priceIn/usd`)
            .then((r: any) => r.json()) as AnyObject
          const usdPrice = (fetchResult?.result?.price) ? formatPrice(fetchResult?.result?.price) : 0
          updatedTokenPrice[token] = usdPrice
          tokenInfo.usdPrice = usdPrice
        } catch (err: any) {
          console.log(`Could not update price for ${token}, Error: ${err.message}`)
        }
        this.redis.HSET(
          `tokeninfo:${chainId}`,
          token,
          JSON.stringify(tokenInfo)
        )
      })
      await Promise.all(results1)

      const marketInfos = await this.redis.HGETALL(`marketinfo:${chainId}`)
      const results2: Promise<any>[] = markets.map(async (market: ZZMarket) => {
        if (!marketInfos[market]) return
        const marketInfo = JSON.parse(marketInfos[market])
        marketInfo.baseAsset.usdPrice = Number(
          formatPrice(updatedTokenPrice[marketInfo.baseAsset.symbol])
        )
        marketInfo.quoteAsset.usdPrice = Number(
          formatPrice(updatedTokenPrice[marketInfo.quoteAsset.symbol])
        )
        this.redis.HSET(
          `marketinfo:${chainId}`,
          market,
          JSON.stringify(marketInfo)
        )
        this.redisPublisher.PUBLISH(
          `broadcastmsg:all:${chainId}:${market}`,
          JSON.stringify({ op: 'marketinfo', args: [marketInfo] })
        )
      })
      await Promise.all(results2)
    })
    await Promise.all(results0)
    console.timeEnd("Updating usd price.")
  }

  getNetwork = async (
    chainId: number
  ): Promise<string> => {
    if (!this.VALID_CHAINS.includes(chainId)) throw new Error('No valid chainId')
    if ([1].includes(chainId)) {
      return "mainnet"
    }
    if ([1000].includes(chainId)) {
      return "rinkeby"
    }
    if ([1001].includes(chainId)) {
      return "goerli"
    }
    return ""
  }
}
