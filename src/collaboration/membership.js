'use strict'

const EventEmitter = require('events')
const multihashing = require('multihashing')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const bs58 = require('bs58')
const AWORSet = require('delta-crdts')('aworset')
const Ring = require('../common/ring')
const DiasSet = require('../common/dias-peer-set')
const ConnectionManager = require('./connection-manager')
const MembershipGossipFrequencyHeuristic = require('./membership-gossip-frequency-henristic')
const encode = require('../common/encode')
const eqSet = require('../common/eq-set')
const setDiff = require('../common/set-diff')

module.exports = class Membership extends EventEmitter {
  constructor (ipfs, globalConnectionManager, app, collaboration, store, options) {
    super()

    this._ipfs = ipfs
    this._app = app
    this._collaboration = collaboration
    this._options = options

    this._members = new Set()
    this._membershipGossipFrequencyHeuristic = new MembershipGossipFrequencyHeuristic(app, this, options)
    this._someoneHasMembershipWrong = true

    this._ring = Ring(this._options.preambleByteCount)
    this._connectionManager = new ConnectionManager(
      ipfs,
      globalConnectionManager,
      this._ring,
      this._collaboration,
      store,
      this._options)

    this._gossipNow = this._gossipNow.bind(this)
    this._ring.on('removed', (peerInfo) => {
      this._members.delete(peerInfo.id.toB58String())
    })
  }

  async start () {
    this._membershipGossipFrequencyHeuristic.on('gossip now', this._gossipNow)
    this._membershipGossipFrequencyHeuristic.start()
    await this._startPeerInfo()
  }

  async _startPeerInfo () {
    if (this._ipfs._peerInfo) {
      const peerId = this._ipfs._peerInfo.id.toB58String()
      this._memberCRDT = AWORSet(peerId)
      this._memberCRDT.add(peerId)
      this._members.add(peerId)
      this._diasSet = DiasSet(
        this._options.peerIdByteCount, this._ipfs._peerInfo, this._options.preambleByteCount)
      return this._connectionManager.start(this._diasSet)
    } else {
      return new Promise((resolve, reject) => {
        this._ipfs.once('ready', () => {
          this._startPeerInfo().then(resolve).catch(reject)
        })
      })
    }
  }

  stop () {
    this._membershipGossipFrequencyHeuristic.stop()
    this._membershipGossipFrequencyHeuristic.removeListener('gossip now', this._gossipNow)
    this._connectionManager.stop()
  }

  peerCount () {
    return this._members.size
  }

  peers () {
    return new Set(this._members)
  }

  outboundConnectionCount () {
    return this._connectionManager.outboundConnectionCount()
  }

  outboundConnectedPeers () {
    return this._connectionManager.outboundConnectedPeers()
  }

  inboundConnectionCount () {
    return this._connectionManager.inboundConnectionCount()
  }

  inboundConnectedPeers () {
    return this._connectionManager.inboundConnectedPeers()
  }

  vectorClock (peerId) {
    return this._connectionManager.vectorClock(peerId)
  }

  needsUrgentBroadcast () {
    // needs to broadcast if self id is not included in the member set yet
    if (this._someoneHasMembershipWrong) {
      return true
    }
    return this._ipfs.id()
      .then((peer) => peer.id)
      .then((id) => {
        const isUrgent = !this._members.has(id)
        return isUrgent
      })
  }

  async deliverRemoteMembership (membership) {
    if ((typeof membership) === 'string') {
      const expectedMembershipHash = this._createMembershipSummaryHash()
      this._someoneHasMembershipWrong = (membership !== expectedMembershipHash)
    } else {
      await this._joinMembership(membership)
    }
  }

  _gossipNow () {
    return this._ipfs.id()
      .then((peer) => peer.id)
      .then(async (id) => {
        let message
        if (await this.needsUrgentBroadcast()) {
          message = this._createMembershipMessage(id)
        } else {
          message = this._createMembershipSummaryMessage(id)
        }
        this._someoneHasMembershipWrong = false
        this._app.gossip(message)
      })
  }

  _createMembershipSummaryMessage (selfId) {
    const message = [
      this._membershipTopic(),
      this._createMembershipSummaryHash()]
    return encode(message)
  }

  _createMembershipSummaryHash () {
    const membership = Buffer.from(JSON.stringify(Array.from(this._members).sort()))
    return multihashing.digest(
      membership,
      'sha1').toString('base64')
  }

  _createMembershipMessage (selfId) {
    // TODO: membership should be a AW-OR-Set CRDT instead of a G-Set
    const message = [this._membershipTopic(), this._memberCRDT.state()]
    // TODO: sign and encrypt membership message
    return encode(message)
  }

  _joinMembership (remoteMembership) {
    return this._ipfs.id()
      .then((peer) => peer.id)
      .then((id) => {
        if (this._memberCRDT) {
          this._memberCRDT.apply(remoteMembership)
          const members = this._memberCRDT.value()

          if (!eqSet(members, this._members)) {
            const diff = setDiff(this._members, members)

            for (let addedPeer of diff.added) {
              if (addedPeer !== id) {
                this._members.add(addedPeer)
                this._ring.add(new PeerInfo(new PeerId(bs58.decode(addedPeer))))
                this.emit('peer joined', addedPeer)
              }
            }

            for (let removedPeer of diff.removed) {
              if (removedPeer !== id) {
                this._members.delete(removedPeer)
                this._ring.remove(new PeerInfo(new PeerId(bs58.decode(removedPeer))))
                this.emit('peer left', removedPeer)
              }
            }

            this.emit('changed')
          }
        }
      })
  }

  _membershipTopic () {
    return this._collaboration.name
  }
}
