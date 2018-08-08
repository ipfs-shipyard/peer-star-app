'use strict'

const EventEmitter = require('events')
const ConnectionManager = require('./connection-manager')
const Observer = require('./observer')

const defaultOptions = {
  updateFrequency: 5000,
  timeoutMS: 10000,
  timeoutScanIntervalMS: 2000
}

class CollaborationStats extends EventEmitter {
  constructor (ipfs, collaboration, collabConnectionManager, membership, globalConnectionManager, options) {
    super()
    this._ipfs = ipfs
    this._membership = membership
    this._options = Object.assign({}, defaultOptions, options)

    this._onMembershipChanged = this._onMembershipChanged.bind(this)
    this._onTimeoutsInterval = this._onTimeoutsInterval.bind(this)
    this._onStatsUpdated = this._onStatsUpdated.bind(this)

    this._connectionManager = new ConnectionManager(
      ipfs, collaboration, collabConnectionManager, globalConnectionManager, this)

    this._observer = new Observer(this._options)
    this._peerStats = new Map()
  }

  start () {
    this._membership.on('changed', this._onMembershipChanged)
    this._observer.on('stats updated', this._onStatsUpdated)
    this._timeoutsInterval = setInterval(this._onTimeoutsInterval, this._options.timeoutScanIntervalMS)
    this._connectionManager.start()
    this._observer.start()
  }

  stop () {
    this._observer.removeListener('stats updated', this._onStatsUpdated)
    this._observer.stop()
    this._membership.removeListener('changed', this._onMembershipChanged)
    if (this._timeoutsInterval) {
      clearInterval(this._timeoutsInterval)
      this._timeoutsInterval = null
    }
    this._connectionManager.stop()
  }

  forPeer (peerId) {
    return this._peerStats.get(peerId)
  }

  setFor (peerId, stats, fromPeerId) {
    const currentStats = this.forPeer(peerId)
    if (currentStats && (currentStats.t < stats.t)) {
      stats.localTime = Date.now()
      this._peerStats = stats
      this.emit('peer updated', peerId, stats, fromPeerId)
      this.emit(peerId, stats, fromPeerId)
    }
  }

  _onMembershipChanged () {
    const peers = this._membership.peers()
    for (let peerId of peers) {
      if (!this._peerStats.has(peerId)) {
        this._peerStats.set(peerId, { t: 0 })
        this.emit('need', peerId)
      }
    }

    for (let peerId of this._peerStats.keys()) {
      if (!peers.has(peerId)) {
        this._peerStats.delete(peerId)
      }
    }
  }

  _onTimeoutsInterval () {
    const now = Date.now()
    for (const [peerId, stats] of this._peerStats) {
      const shouldHaveArrived = (stats.localTime || 0) + this._options.timeoutMS
      if (shouldHaveArrived < now) {
        // peer timed out, we need recent stats on this one
        this.emit('need', peerId)
      }
    }
  }

  _onStatsUpdated (stats) {
    this.setFor(this._peerId(), stats, this._peerId())
  }

  _peerId () {
    if (!this._cachedPeerId) {
      this._cachedPeerId = this._ipfs._peerInfo.id.toB58String()
    }
    return this._cachedPeerId
  }
}

module.exports = CollaborationStats