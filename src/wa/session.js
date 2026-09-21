// Session state helpers — tracks WA connection lifecycle
const { getSocket, getStatus } = require('./baileys')

function isConnected() {
  return getStatus().connected
}

function getSocketInstance() {
  return getSocket()
}

module.exports = {
  isConnected,
  getSocketInstance,
}