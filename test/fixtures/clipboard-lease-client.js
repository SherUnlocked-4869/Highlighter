// Synthetic metadata only. This process never reads or writes the clipboard.
const net = require('node:net')
let socket
process.on('message', (message) => {
  if (message.type === 'begin') {
    const endpoint = message.endpoint
    socket = net.createConnection(endpoint.pipeName)
    let active = false
    socket.on('error', () => {})
    socket.once('close', () => { if (!active) process.send?.({ type: 'rejected' }) })
    socket.once('connect', () => {
      const packet = Buffer.alloc(128)
      packet.write('HLC1', 0)
      packet.writeUInt32LE(1, 4)
      packet.writeBigUInt64LE(1n, 8)
      Buffer.from(endpoint.nonce, 'hex').copy(packet, 16)
      Buffer.from(endpoint.hostEpoch, 'hex').copy(packet, 48)
      socket.write(packet)
    })
    let received = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length === 32 && received.readUInt32LE(4) === 0) { active = true; process.send?.({ type: 'active' }) }
      else if (received.length >= 32) process.send?.({ type: 'failed' })
    })
  } else if (message.type === 'disconnect') {
    socket?.destroy()
    process.send?.({ type: 'disconnected' })
  }
})
process.send?.({ type: 'ready' })
