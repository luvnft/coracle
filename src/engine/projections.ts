import {always, mergeRight, prop, sortBy, uniq, whereEq, without} from "ramda"
import {switcherFn} from "hurdak"
import {nth, inc} from "@welshman/lib"
import type {TrustedEvent} from "@welshman/util"
import {
  Tags,
  isShareableRelayUrl,
  getIdFilters,
  MUTES,
  APP_DATA,
  SEEN_CONVERSATION,
  SEEN_GENERAL,
  SEEN_CONTEXT,
  FOLLOWS,
  RELAYS,
  COMMUNITIES,
  WRAP,
} from "@welshman/util"
import {getPubkey} from "@welshman/signer"
import {parseJson} from "src/util/misc"
import {normalizeRelayUrl} from "src/domain"
import {GroupAccess} from "src/engine/model"
import {repository} from "src/engine/repository"
import {
  topics,
  relays,
  deriveAdminKeyForGroup,
  getGroupStatus,
  getSession,
  groupAdminKeys,
  groupAlerts,
  groupRequests,
  groupSharedKeys,
  groups,
  load,
  projections,
  hints,
  ensurePlaintext,
} from "src/engine/state"
import {
  modifyGroupStatus,
  setGroupStatus,
  updateSession,
  updateZapper,
  updateHandle,
} from "src/engine/commands"

// Synchronize repository with projections. All events should be published to the
// repository, and when accepted, be propagated to projections. This avoids processing
// the same event multiple times, since repository deduplicates

repository.on("update", ({added}: {added: TrustedEvent[]}) => {
  for (const event of added) {
    projections.push(event)
  }
})

// Key sharing

projections.addHandler(24, (e: TrustedEvent) => {
  const tags = Tags.fromEvent(e)
  const privkey = tags.get("privkey")?.value()
  const address = tags.get("a")?.value()
  const recipient = Tags.fromEvent(e.wrap).get("p")?.value()
  const relays = tags.values("relay").valueOf()

  if (!address) {
    return
  }

  const status = getGroupStatus(getSession(recipient), address)

  if (privkey) {
    const pubkey = getPubkey(privkey)
    const role = tags.get("role")?.value()
    const keys = role === "admin" ? groupAdminKeys : groupSharedKeys

    keys.key(pubkey).update($key => ({
      pubkey,
      privkey,
      group: address,
      created_at: e.created_at,
      hints: relays,
      ...$key,
    }))

    // Notify the user if this isn't just a key rotation
    if (status?.access !== GroupAccess.Granted) {
      groupAlerts.key(e.id).set({...e, group: address, type: "invite"})
    }

    // Load the group's metadata and posts
    load({
      skipCache: true,
      relays: hints.fromRelays(relays).getUrls(),
      filters: [
        ...getIdFilters([address]),
        {kinds: [WRAP], "#p": [pubkey]},
        {kinds: [WRAP], authors: [pubkey]},
      ],
    })
  } else if ([GroupAccess.Granted, GroupAccess.Requested].includes(status?.access)) {
    groupAlerts.key(e.id).set({...e, group: address, type: "exit"})
  }

  setGroupStatus(recipient, address, e.created_at, {
    access: privkey ? GroupAccess.Granted : GroupAccess.Revoked,
  })
})

projections.addHandler(27, (e: TrustedEvent) => {
  const address = Tags.fromEvent(e).groups().values().first()

  if (!address) {
    return
  }

  let {members = [], recent_member_updates = []} = groups.key(address).get() || {}

  // Only replay updates if we have something new
  if (!recent_member_updates.find(whereEq({id: e.id}))) {
    recent_member_updates = sortBy(prop("created_at"), recent_member_updates.concat(e)).slice(-100)

    for (const event of recent_member_updates) {
      const tags = Tags.fromEvent(event)
      const op = tags.get("op")?.value()
      const pubkeys = tags.values("p").valueOf()

      members = switcherFn(op, {
        add: () => uniq(pubkeys.concat(members)),
        remove: () => without(pubkeys, members),
        set: () => pubkeys,
        default: () => members,
      })
    }

    groups.key(address).merge({members, recent_member_updates})
  }
})

// Membership

projections.addHandler(COMMUNITIES, (e: TrustedEvent) => {
  let session = getSession(e.pubkey)

  if (!session) {
    return
  }

  const addresses = Tags.fromEvent(e).communities().values().valueOf()

  for (const address of uniq(Object.keys(session.groups || {}).concat(addresses))) {
    session = modifyGroupStatus(session, address, e.created_at, {
      joined: addresses.includes(address),
    })
  }

  updateSession(e.pubkey, always(session))
})

const handleGroupRequest = access => (e: TrustedEvent) => {
  const address = Tags.fromEvent(e).get("a")?.value()
  const adminKey = deriveAdminKeyForGroup(address)

  // Don't bother the admin with old requests
  if (adminKey.get() && e.created_at) {
    groupRequests.key(e.id).update(
      mergeRight({
        ...e,
        group: address,
        resolved: false,
      }),
    )
  }

  if (getSession(e.pubkey)) {
    setGroupStatus(e.pubkey, address, e.created_at, {access})
  }
}

projections.addHandler(25, handleGroupRequest(GroupAccess.Requested))

projections.addHandler(26, handleGroupRequest(GroupAccess.None))

projections.addHandler(0, e => {
  const content = parseJson(e.content)

  updateHandle(e, content)
  updateZapper(e, content)
})

// Relays

projections.addHandler(RELAYS, (e: TrustedEvent) => {
  for (const [key, value] of e.tags) {
    if (["r", "relay"].includes(key) && isShareableRelayUrl(value)) {
      relays.key(normalizeRelayUrl(value)).update($relay => ({
        url: value,
        last_checked: 0,
        count: inc($relay?.count || 0),
        first_seen: $relay?.first_seen || e.created_at,
      }))
    }
  }
})

// Topics

const addTopic = (e, name) => {
  if (name) {
    const topic = topics.key(name.toLowerCase())

    topic.merge({
      count: inc(topic.get()?.count || 0),
      last_seen: e.created_at,
    })
  }
}

projections.addHandler(1, (e: TrustedEvent) => {
  const tagTopics = Tags.fromEvent(e).topics().valueOf()
  const contentTopics = Array.from(e.content.toLowerCase().matchAll(/#(\w{2,100})/g)).map(nth(1))

  for (const name of tagTopics.concat(contentTopics)) {
    addTopic(e, name)
  }
})

projections.addHandler(1985, (e: TrustedEvent) => {
  for (const name of Tags.fromEvent(e)
    .whereKey("l")
    .filter(t => t.last() === "#t")
    .values()
    .valueOf()) {
    addTopic(e, name)
  }
})

// Decrypt encrypted events eagerly

projections.addHandler(SEEN_GENERAL, ensurePlaintext)
projections.addHandler(SEEN_CONTEXT, ensurePlaintext)
projections.addHandler(SEEN_CONVERSATION, ensurePlaintext)
projections.addHandler(APP_DATA, ensurePlaintext)
projections.addHandler(FOLLOWS, ensurePlaintext)
projections.addHandler(MUTES, ensurePlaintext)
