import type { ZZServiceHandler } from 'src/types'

export const login: ZZServiceHandler = async (api, ws, [chainId, userid]) => {
  if (!api.VALID_CHAINS.includes(chainId)) {
    const errorMsg = {
      op: 'error',
      args: [
        'login',
        `${chainId} is not a valid chain id. Use ${api.VALID_CHAINS}`,
      ],
    }
    ws.send(JSON.stringify(errorMsg))
    console.log(`Error, ${chainId} is not a valid chain id.`)
    return
  }

  ws.chainid = chainId
  ws.userid = userid
  const userconnkey = `${chainId}:${userid}`
  api.USER_CONNECTIONS[userconnkey] = ws
  const userorders = await api.getuserorders(chainId, userid)
  const userfills = await api.getuserfills(chainId, userid)
  ws.send(JSON.stringify({ op: 'orders', args: [userorders] }))
  ws.send(JSON.stringify({ op: 'fills', args: [userfills] }))
}
