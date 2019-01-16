/* eslint no-console: "off" */
'use strict'

const assert = require('assert')
const debug = require('debug')('peer-base:collaboration:shared')
const EventEmitter = require('events')
const b58Decode = require('bs58').decode
const vectorclock = require('../common/vectorclock')
const Store = require('./store')
const peerToClockId = require('./peer-to-clock-id')

module.exports = (name, id, crdtType, ipfs, collaboration, clocks, options) => {
  const shared = new EventEmitter()
  const changeEmitter = new ChangeEmitter(shared)
  const voidChangeEmitter = new VoidChangeEmitter()

  const store = new Store(ipfs, collaboration, options)

  let deltas = []
  let state = crdtType.initial()
  const memo = {}
  let valueCache

  const pushDelta = (delta) => {
    deltas.push(delta)
    if (deltas.length > options.maxDeltaRetention) {
      deltas.splice(0, deltas.length - options.maxDeltaRetention)
    }
  }

  const clockId = peerToClockId(id)

  const applyAndPushDelta = (delta) => {
    if (collaboration.isRoot()) {
      const previousClock = clocks.getFor(id)
      apply(delta, true)
      const newClock = vectorclock.increment(previousClock, clockId)
      const authorClock = vectorclock.increment({}, clockId)
      const deltaRecord = [previousClock, authorClock, [name, crdtType.typeName, delta]]
      pushDelta(deltaRecord)
      onClockChanged(newClock)
    } else {
      collaboration.parent.shared.pushDeltaForSub(name, crdtType.typeName, delta)
      apply(delta, true)
    }
  }

  const crdtId = (() => {
    const crdtIdBuffer = b58Decode(id)
    return crdtIdBuffer.slice(crdtIdBuffer.length - 4)
  })()

  // shared mutators
  Object.keys(crdtType.mutators).forEach((mutatorName) => {
    const mutator = crdtType.mutators[mutatorName]
    shared[mutatorName] = async (...args) => {
      const delta = mutator(crdtId, state, ...args)
      return applyAndPushDelta(delta)
    }
  })

  shared.start = async () => {
    await store.start()
    const [loadedState, loadedDeltas, clock] = await store.load()
    if (loadedState) {
      if (crdtType.incrementalValue && !options.replicateOnly) {
        assert(!valueCache)
        valueCache = crdtType.incrementalValue(state, loadedState, loadedState)
      }
      state = loadedState
    } else if (crdtType.incrementalValue && !options.replicateOnly) {
      assert(!valueCache)
      valueCache = crdtType.incrementalValue(state, state, state)
    }
    if (loadedDeltas) {
      deltas = loadedDeltas
    }
    if (clock) {
      clocks.mergeFor(id, clock)
    }
  }

  shared.stop = () => {
    return store.stop()
  }

  shared.name = name

  shared.state = () => state

  shared.stateAsDelta = () => {
    return [{}, clocks.getFor(id), [name, crdtType.typeName, state]]
  }

  // shared value
  shared.value = () => {
    if (valueCache !== undefined) {
      let retValue = valueCache.value
      if (retValue.toJS) {
        retValue = retValue.toJS()
      }
      return retValue
    }
    if ((!memo.state) || (memo.state !== state)) {
      memo.state = state
      memo.value = crdtType.value(state)
    }
    return memo.value
  }

  shared.pushDeltaForSub = (name, type, delta) => {
    const previousClock = clocks.getFor(id)
    const newClock = vectorclock.increment(previousClock, clockId)
    const authorClock = vectorclock.increment({}, clockId)
    const deltaRecord = [previousClock, authorClock, [name, type, delta]]
    pushDelta(deltaRecord)
    onClockChanged(newClock)
  }

  shared.apply = (deltaRecord, isPartial, force) => {
    const clock = clocks.getFor(id)
    const [previousClock, authorClock, [forName, typeName, delta]] = deltaRecord
    const deltaClock = vectorclock.sumAll(previousClock, authorClock)
    const newClock = options.replicateOnly ? deltaClock : vectorclock.merge(clock, deltaClock)
    if (forName === name) {
      let isInteresting = vectorclock.isDeltaInteresting(deltaRecord, clock)
      if (!isInteresting && force) {
        isInteresting = vectorclock.isIdentical(clock, newClock)
      }
      if (!isInteresting) {
        return false
      }

      if (options.replicateOnly && Object.keys(previousClock).length) {
        // if this is a pinner, do not accept partial deltas, only full states
        return false
      }
    }
    if (collaboration.isRoot()) {
      pushDelta(deltaRecord)
    }
    if (forName === name) {
      apply(delta)
      onClockChanged(newClock)
      return newClock
    } else if (typeName) {
      return collaboration.sub(forName, typeName)
        .then((subCollaboration) => {
          return subCollaboration.shared.apply(deltaRecord, isPartial, force)
        })
    }
  }

  shared.initial = () => Promise.resolve(new Map())

  shared.clock = () => clocks.getFor(id)

  shared.contains = (otherClock) => {
    const clock = clocks.getFor(id)
    return (vectorclock.compare(otherClock, clock) < 0) || vectorclock.isIdentical(otherClock, clock)
  }

  shared.deltas = (since = {}) => {
    const interestingDeltas = deltas.filter((deltaRecord) => {
      if (vectorclock.isDeltaInteresting(deltaRecord, since)) {
        const [previousClock, authorClock] = deltaRecord
        since = vectorclock.merge(since, vectorclock.sumAll(previousClock, authorClock))
        return true
      }
      return false
    })

    return interestingDeltas
  }

  shared.deltaBatches = (_since = {}, targetPeerId) => {
    const targetClockId = peerToClockId(targetPeerId)
    let since = _since
    const deltas = shared.deltas(since)

    let batch = [since, {}, [name, crdtType.typeName, crdtType.initial()]]
    const batches = []
    deltas
      .forEach((deltaRecord) => {
        if (!vectorclock.isDeltaInteresting(deltaRecord, since, targetClockId)) {
          return
        }
        const [oldPreviousClock, oldAuthorClock, [oldName, oldType, oldDelta]] = batch
        const oldClock = vectorclock.sumAll(oldPreviousClock, oldAuthorClock)
        const [deltaPreviousClock, deltaAuthorClock, [deltaName, deltaType, delta]] = deltaRecord
        const deltaClock = vectorclock.sumAll(deltaPreviousClock, deltaAuthorClock)
        const newClock = vectorclock.merge(oldClock, deltaClock)
        const newPreviousClock = vectorclock.minimum(oldPreviousClock, deltaPreviousClock)
        const newAuthorClock = vectorclock.subtract(newPreviousClock, newClock)
        let newDelta
        try {
          if (deltaName !== oldName) throw new Error('Mismatched name')
          if (deltaType !== oldType) throw new Error('Mismatched type')
          newDelta = crdtType.join.call(voidChangeEmitter, oldDelta, delta)
        } catch (err) {
          // could not perform join. will resort to creating a new batch for this delta.
          batch = [deltaPreviousClock, deltaAuthorClock, [deltaName, deltaType, delta]]
          batches.push(batch)
          since = vectorclock.merge(since, deltaClock)
          return
        }
        since = vectorclock.merge(since, newClock)

        batch[0] = newPreviousClock
        batch[1] = newAuthorClock
        batch[2][2] = newDelta
        if (!batches.length) {
          batches.push(batch)
        }
      })

    return batches
  }

  shared.save = () => {
    const clock = clocks.getFor(id)
    return store.save(state, deltas, clock).then((result) => {
      shared.emit('saved')
      return result
    })
  }

  return shared

  function apply (s, fromSelf) {
    debug('%s: apply ', id, s)
    if (options.replicateOnly) {
      state = s
    } else {
      const newState = crdtType.join.call(changeEmitter, state, s)
      if (crdtType.incrementalValue) {
        assert(valueCache)
        valueCache = crdtType.incrementalValue(state, newState, s, valueCache)
      }
      state = newState
      shared.emit('delta', s, fromSelf)

      debug('%s: new state after join is', id, state)
      try {
        changeEmitter.emitAll()
      } catch (err) {
        console.error('Error caught while emitting changes:', err)
      }
    }

    shared.emit('state changed', fromSelf)
    return state
  }

  function onClockChanged (newClock) {
    clocks.mergeFor(id, newClock)
    shared.emit('clock changed', newClock)
  }
}

class ChangeEmitter {
  constructor (client) {
    this._client = client
    this._events = []
  }

  changed (event) {
    this._events.push(event)
  }

  emitAll () {
    const events = this._events
    this._events = []
    events.forEach((event) => {
      this._client.emit('change', event)
    })
  }
}

class VoidChangeEmitter {
  changed (event) {
    // DO NOTHING
  }

  emitAll () {
    // DO NOTHING
  }
}
