import crypto from "crypto"
import {get} from "svelte/store"
import {cached, equals, splitAt, first, last, append, nthEq, groupBy, now} from "@welshman/lib"
import type {TrustedEvent} from "@welshman/util"
import {
  getAddress,
  Tags,
  createEvent,
  getLnUrl,
  Address,
  isSignedEvent,
  normalizeRelayUrl,
  GROUP,
  COMMUNITY,
  FEEDS,
  FOLLOWS,
  RELAYS,
  PROFILE,
  MUTES,
  INBOX_RELAYS,
  DIRECT_MESSAGE,
  SEEN_CONVERSATION,
} from "@welshman/util"
import type {Nip46Handler} from "@welshman/signer"
import {Nip59, Nip01Signer, getPubkey, makeSecret, Nip46Broker} from "@welshman/signer"
import {Fetch, randomId, seconds, sleep, tryFunc} from "hurdak"
import {assoc, flatten, identity, omit, partition, prop, reject, uniq, without} from "ramda"
import {stripExifData, blobToFile} from "src/util/html"
import {joinPath, parseJson} from "src/util/misc"
import {appDataKeys} from "src/util/nostr"
import {makeRelayPolicy, isPublishedProfile, createProfile, editProfile} from "src/domain"
import type {RelayPolicy, Profile} from "src/domain"
import type {Session} from "src/engine/model"
import {GroupAccess} from "src/engine/model"
import {repository} from "src/engine/repository"
import {
  channels,
  getChannelSeenKey,
  createAndPublish,
  ensurePlaintext,
  deriveAdminKeyForGroup,
  userIsGroupMember,
  deriveSharedKeyForGroup,
  displayProfileByPubkey,
  env,
  addClientTags,
  getClientTags,
  groupAdminKeys,
  groupSharedKeys,
  groups,
  hints,
  mention,
  pubkey,
  publish,
  session,
  sessions,
  sign,
  signer,
  hasNip44,
  withIndexers,
  setFreshness,
  getFreshness,
  handles,
  zappers,
  anonymous,
  mentionGroup,
  userRelayPolicies,
  userSeenStatusEvents,
  getChannelIdFromEvent,
  getSession,
  nip46Perms,
  uniqTags,
} from "src/engine/state"
import {loadHandle, loadZapper} from "src/engine/requests"

// Helpers

export const updateRecord = (record, timestamp, updates) => {
  for (const [field, value] of Object.entries(updates)) {
    const tsField = `${field}_updated_at`
    const lastUpdated = record?.[tsField] || -1

    if (timestamp > lastUpdated) {
      record = {
        ...record,
        [field]: value,
        [tsField]: timestamp,
        updated_at: Math.max(timestamp, record?.updated_at || 0),
      }
    }
  }

  return record
}

export const updateStore = (store, timestamp, updates) =>
  store.set(updateRecord(store.get(), timestamp, updates))

// Files

export const nip98Fetch = async (url, method, body = null) => {
  const tags = [
    ["u", url],
    ["method", method],
  ]

  if (body) {
    tags.push(["payload", crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")])
  }

  const $signer = signer.get() || Nip01Signer.ephemeral()
  const event = await $signer.sign(createEvent(27235, {tags}))
  const auth = btoa(JSON.stringify(event))
  const headers = {Authorization: `Nostr ${auth}`}

  return Fetch.fetchJson(url, {body, method, headers})
}

export const getMediaProviderURL = cached({
  maxSize: 10,
  getKey: ([url]) => url,
  getValue: ([url]) => fetchMediaProviderURL(url),
})

const fetchMediaProviderURL = async host =>
  prop("api_url", await Fetch.fetchJson(joinPath(host, ".well-known/nostr/nip96.json")))

const fileToFormData = file => {
  const formData = new FormData()

  formData.append("file[]", file)

  return formData
}

export const uploadFileToHost = async (url, file) => {
  const startTime = now()
  const apiUrl = await getMediaProviderURL(url)
  const response = await nip98Fetch(apiUrl, "POST", fileToFormData(file))

  // If the media provider uses delayed processing, we need to wait for the processing to be done
  while (response.processing_url) {
    const {status, nip94_event} = await nip98Fetch(response.processing_url, "GET")

    if (status === "success") {
      return nip94_event
    }

    if (now() - startTime > 60) {
      break
    }

    await sleep(3000)
  }

  return response.nip94_event
}

export const uploadFilesToHost = (url, files) =>
  Promise.all(files.map(file => tryFunc(async () => await uploadFileToHost(url, file))))

export const uploadFileToHosts = (urls, file) =>
  Promise.all(urls.map(url => tryFunc(async () => await uploadFileToHost(url, file))))

export const uploadFilesToHosts = async (urls, files) =>
  flatten(await Promise.all(urls.map(url => uploadFilesToHost(url, files)))).filter(identity)

export const compressFiles = (files, opts) =>
  Promise.all(
    files.map(async f => {
      if (f.type.match("image/(webp|gif)")) {
        return f
      }

      return blobToFile(await stripExifData(f, opts))
    }),
  )

export const eventsToMeta = (events: TrustedEvent[]) => {
  const tagsByHash = groupBy((tags: Tags) => tags.get("ox").value(), events.map(Tags.fromEvent))

  // Merge all nip94 tags together so we can supply as much imeta as possible
  return Array.from(tagsByHash.values()).map(groupedTags => {
    return Tags.wrap(groupedTags.flatMap(tags => tags.unwrap())).uniq()
  })
}

export const uploadFiles = async (urls, files, compressorOpts = {}) => {
  const compressedFiles = await compressFiles(files, compressorOpts)
  const nip94Events = await uploadFilesToHosts(urls, compressedFiles)

  return eventsToMeta(nip94Events)
}

// Handles/Zappers

export const updateHandle = async ({pubkey, created_at}, {nip05}) => {
  if (!nip05 || getFreshness("handle", pubkey) >= created_at) {
    return
  }

  setFreshness("handle", pubkey, created_at)

  const handle = await loadHandle(nip05)

  if (handle?.pubkey === pubkey) {
    handles.update(assoc(pubkey, {...handle, nip05}))
  }
}

export const updateZapper = async ({pubkey, created_at}, {lud16, lud06}) => {
  const address = (lud16 || lud06 || "").toLowerCase()

  if (!address) {
    return
  }

  const lnurl = getLnUrl(address)

  if (!lnurl || getFreshness("zapper", pubkey) >= created_at) {
    return
  }

  setFreshness("zapper", pubkey, created_at)

  const zapper = await loadZapper(lnurl)

  if (zapper?.allowsNostr && zapper?.nostrPubkey) {
    zappers.update(assoc(pubkey, {...zapper, pubkey, lnurl}))
  }
}

// Groups

// Key state management

export const initSharedKey = (address: string, relays: string[]) => {
  const privkey = makeSecret()
  const pubkey = getPubkey(privkey)
  const key = {
    group: address,
    pubkey: pubkey,
    privkey: privkey,
    created_at: now(),
    hints: relays,
  }

  groupSharedKeys.key(pubkey).set(key)

  return key
}

export const initGroup = (kind, relays) => {
  const identifier = randomId()
  const privkey = makeSecret()
  const pubkey = getPubkey(privkey)
  const address = `${kind}:${pubkey}:${identifier}`
  const sharedKey = kind === 35834 ? initSharedKey(address, relays) : null
  const adminKey = {
    group: address,
    pubkey: pubkey,
    privkey: privkey,
    created_at: now(),
    hints: relays,
  }

  groupAdminKeys.key(pubkey).set(adminKey)

  groups.key(address).set({id: identifier, pubkey, address})

  return {identifier, address, adminKey, sharedKey}
}

const addGroupATags = (template, addresses) => ({
  ...template,
  tags: [...template.tags, ...addresses.map(mentionGroup)],
})

// Utils for publishing group-related messages
// Relay selections for groups should ignore platform relays, since groups provide their own
// relays, and can straddle public/private contexts.

export const publishToGroupAdmin = async (address, template) => {
  const relays = hints.WithinContext(address).getUrls()
  const pubkeys = [Address.from(address).pubkey, session.get().pubkey]
  const expireTag = [["expiration", String(now() + seconds(30, "day"))]]
  const helper = Nip59.fromSigner(signer.get())

  for (const pubkey of pubkeys) {
    const rumor = await helper.wrap(pubkey, template, expireTag)

    await publish({event: rumor.wrap, relays, forcePlatform: false})
  }
}

export const publishAsGroupAdminPublicly = async (address, template, relays = []) => {
  const _relays = hints.merge([hints.fromRelays(relays), hints.WithinContext(address)]).getUrls()
  const adminKey = deriveAdminKeyForGroup(address).get()
  const event = await sign(template, {sk: adminKey.privkey})

  return publish({event, relays: _relays, forcePlatform: false})
}

export const publishAsGroupAdminPrivately = async (address, template, relays = []) => {
  const _relays = hints.merge([hints.fromRelays(relays), hints.WithinContext(address)]).getUrls()
  const adminKey = deriveAdminKeyForGroup(address).get()
  const sharedKey = deriveSharedKeyForGroup(address).get()
  const adminSigner = new Nip01Signer(adminKey.privkey)
  const sharedSigner = new Nip01Signer(sharedKey.privkey)
  const helper = Nip59.fromSigner(adminSigner).withWrapper(sharedSigner)
  const rumor = await helper.wrap(sharedKey.pubkey, template)

  return publish({event: rumor.wrap, relays: _relays, forcePlatform: false})
}

export const publishToGroupsPublicly = async (addresses, template, {anonymous = false} = {}) => {
  for (const address of addresses) {
    if (!address.startsWith("34550:")) {
      throw new Error("Attempted to publish publicly to an invalid address", address)
    }
  }

  const event = await sign(addGroupATags(template, addresses), {anonymous})
  const relays = hints.PublishEvent(event).getUrls()

  return publish({event, relays, forcePlatform: false})
}

export const publishToGroupsPrivately = async (addresses, template, {anonymous = false} = {}) => {
  const $userIsGroupMember = userIsGroupMember.get()

  const events = []
  const pubs = []
  for (const address of addresses) {
    const relays = hints.WithinContext(address).getUrls()
    const thisTemplate = addGroupATags(template, [address])
    const sharedKey = deriveSharedKeyForGroup(address).get()

    if (!address.startsWith("35834:")) {
      throw new Error("Attempted to publish privately to an invalid address", address)
    }

    if (!$userIsGroupMember(address)) {
      throw new Error("Attempted to publish privately to a group the user is not a member of")
    }

    const userSigner = anonymous ? signer.get() : Nip01Signer.ephemeral()
    const wrapSigner = new Nip01Signer(sharedKey.privkey)
    const helper = Nip59.fromSigner(userSigner).withWrapper(wrapSigner)
    const rumor = await helper.wrap(sharedKey.pubkey, thisTemplate)

    events.push(rumor)
    pubs.push(await publish({event: rumor.wrap, relays, forcePlatform: false}))
  }

  return {events, pubs}
}

export const publishToZeroOrMoreGroups = async (addresses, template, {anonymous = false} = {}) => {
  const pubs = []
  const events = []

  if (addresses.length === 0) {
    const event = await sign(template, {anonymous})
    const relays = hints.PublishEvent(event).getUrls()

    events.push(event)
    pubs.push(await publish({event, relays}))
  } else {
    const [wrap, nowrap] = partition((address: string) => address.startsWith("35834:"), addresses)

    if (wrap.length > 0) {
      const result = await publishToGroupsPrivately(wrap, template, {anonymous})

      for (const event of result.events) {
        events.push(event)
      }

      for (const pub of result.pubs) {
        pubs.push(pub)
      }
    }

    if (nowrap.length > 0) {
      const pub = await publishToGroupsPublicly(nowrap, template, {anonymous})

      events.push(pub.request.event)
      pubs.push(pub)
    }
  }

  return {events, pubs}
}

// Admin functions

export const publishKeyShares = async (address, pubkeys, template) => {
  const adminKey = deriveAdminKeyForGroup(address).get()

  const pubs = []

  for (const pubkey of pubkeys) {
    const relays = hints
      .merge([
        hints.ForPubkeys([pubkey]),
        hints.WithinContext(address),
        hints.fromRelays(env.get().PLATFORM_RELAYS),
      ])
      .policy(hints.addNoFallbacks)
      .getUrls()

    const adminSigner = new Nip01Signer(adminKey.privkey)
    const helper = Nip59.fromSigner(adminSigner)
    const rumor = await helper.wrap(pubkey, template)

    pubs.push(await publish({event: rumor.wrap, relays, forcePlatform: false}))
  }

  return pubs
}

export const publishAdminKeyShares = async (address, pubkeys) => {
  const relays = hints.WithinContext(address).getUrls()
  const {privkey} = deriveAdminKeyForGroup(address).get()
  const template = createEvent(24, {
    tags: [
      mentionGroup(address),
      ["role", "admin"],
      ["privkey", privkey],
      ...getClientTags(),
      ...relays.map(url => ["relay", url]),
    ],
  })

  return publishKeyShares(address, pubkeys, template)
}

export const publishGroupInvites = async (address, pubkeys, gracePeriod = 0) => {
  const relays = hints.WithinContext(address).getUrls()
  const adminKey = deriveAdminKeyForGroup(address).get()
  const {privkey} = deriveSharedKeyForGroup(address).get()
  const template = createEvent(24, {
    tags: [
      mentionGroup(address),
      ["role", "member"],
      ["privkey", privkey],
      ["grace_period", String(gracePeriod)],
      ...getClientTags(),
      ...relays.map(url => ["relay", url]),
    ],
  })

  return publishKeyShares(address, [...pubkeys, adminKey.pubkey], template)
}

export const publishGroupEvictions = async (address, pubkeys) =>
  publishKeyShares(
    address,
    pubkeys,
    createEvent(24, {
      tags: [mentionGroup(address), ...getClientTags()],
    }),
  )

export const publishGroupMembers = async (address, op, pubkeys) => {
  const template = createEvent(27, {
    tags: [["op", op], mentionGroup(address), ...getClientTags(), ...pubkeys.map(mention)],
  })

  return publishAsGroupAdminPrivately(address, template)
}

export const publishCommunityMeta = (address, identifier, meta) => {
  const template = createEvent(COMMUNITY, {
    tags: [
      ["d", identifier],
      ["name", meta.name],
      ["about", meta.about],
      ["description", meta.about],
      ["banner", meta.banner],
      ["picture", meta.image],
      ["image", meta.image],
      ...meta.feeds,
      ...meta.relays,
      ...meta.moderators,
      ...getClientTags(),
    ],
  })

  return publishAsGroupAdminPublicly(address, template, meta.relays)
}

export const publishGroupMeta = (address, identifier, meta, listPublicly) => {
  const template = createEvent(GROUP, {
    tags: [
      ["d", identifier],
      ["name", meta.name],
      ["about", meta.about],
      ["description", meta.about],
      ["banner", meta.banner],
      ["picture", meta.image],
      ["image", meta.image],
      ...meta.feeds,
      ...meta.relays,
      ...meta.moderators,
      ...getClientTags(),
    ],
  })

  return listPublicly
    ? publishAsGroupAdminPublicly(address, template, meta.relays)
    : publishAsGroupAdminPrivately(address, template, meta.relays)
}

export const deleteGroupMeta = address =>
  publishAsGroupAdminPublicly(address, createEvent(5, {tags: [mentionGroup(address)]}))

// Member functions

export const modifyGroupStatus = (session, address, timestamp, updates) => {
  if (!session.groups) {
    session.groups = {}
  }

  const newGroupStatus = updateRecord(session.groups[address], timestamp, updates)

  if (!equals(session.groups[address], newGroupStatus)) {
    session.groups[address] = newGroupStatus
  }

  return session
}

export const setGroupStatus = (pubkey, address, timestamp, updates) =>
  updateSession(pubkey, s => modifyGroupStatus(s, address, timestamp, updates))

export const resetGroupAccess = address =>
  setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.None})

export const publishGroupEntryRequest = (address, claim = null) => {
  if (deriveAdminKeyForGroup(address).get()) {
    publishGroupInvites(address, [session.get().pubkey])
  } else {
    setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.Requested})

    const tags = [...getClientTags(), mentionGroup(address)]

    if (claim) {
      tags.push(["claim", claim])
    }

    publishToGroupAdmin(
      address,
      createEvent(25, {
        content: `${displayProfileByPubkey(pubkey.get())} would like to join the group`,
        tags,
      }),
    )
  }
}

export const publishGroupExitRequest = address => {
  setGroupStatus(pubkey.get(), address, now(), {access: GroupAccess.None})

  if (!deriveAdminKeyForGroup(address).get()) {
    publishToGroupAdmin(
      address,
      createEvent(26, {
        content: `${displayProfileByPubkey(pubkey.get())} is leaving the group`,
        tags: [...getClientTags(), mentionGroup(address)],
      }),
    )
  }
}

export const publishCommunitiesList = addresses =>
  createAndPublish({
    kind: 10004,
    tags: [...addresses.map(mentionGroup), ...getClientTags()],
    relays: hints.WriteRelays().getUrls(),
  })

// Deletes

export const publishDeletion = ({kind, address = null, id = null}) => {
  const tags = [["k", String(kind)]]

  if (address) {
    tags.push(["a", address])
  }

  if (id) {
    tags.push(["e", id])
  }

  return createAndPublish({
    tags,
    kind: 5,
    relays: hints.WriteRelays().getUrls(),
    forcePlatform: false,
  })
}

export const deleteEvent = (event: TrustedEvent) =>
  publishDeletion({id: event.id, address: getAddress(event), kind: event.kind})

export const deleteEventByAddress = (address: string) =>
  publishDeletion({address, kind: Address.from(address).kind})

// Profile

export const publishProfile = (profile: Profile, {forcePlatform = false} = {}) => {
  const relays = withIndexers(hints.WriteRelays().getUrls())
  const template = isPublishedProfile(profile) ? editProfile(profile) : createProfile(profile)

  return createAndPublish({...addClientTags(template), relays, forcePlatform})
}

// Singletons

export type ModifyTags = (tags: string[][]) => string[][]

export const updateSingleton = async (kind: number, modifyTags: ModifyTags) => {
  const [prev] = repository.query([{kinds: [kind], authors: [pubkey.get()]}])
  const relays = withIndexers(hints.WriteRelays().getUrls())

  // Preserve content if we have it
  const content = prev?.content || ""
  const tags = modifyTags(uniqTags(prev?.tags || []))

  await createAndPublish({kind, content, tags, relays})
}

// Follows/mutes

export const unfollowPerson = (pubkey: string) => {
  if (signer.get()) {
    updateSingleton(FOLLOWS, reject(nthEq(1, pubkey)))
  } else {
    anonymous.update($a => ({...$a, follows: reject(nthEq(1, pubkey), $a.follows)}))
  }
}

export const followPerson = (pubkey: string) => {
  if (signer.get()) {
    updateSingleton(FOLLOWS, tags => append(mention(pubkey), tags))
  } else {
    anonymous.update($a => ({...$a, follows: append(mention(pubkey), $a.follows)}))
  }
}

export const unmutePerson = (pubkey: string) =>
  updateSingleton(MUTES, tags => reject(nthEq(1, pubkey), tags))

export const mutePerson = (pubkey: string) =>
  updateSingleton(MUTES, tags => append(mention(pubkey), tags))

export const unmuteNote = (id: string) => updateSingleton(MUTES, tags => reject(nthEq(1, id), tags))

export const muteNote = (id: string) => updateSingleton(MUTES, tags => append(["e", id], tags))

export const removeFeedFavorite = (address: string) =>
  updateSingleton(FEEDS, tags => reject(nthEq(1, address), tags))

export const addFeedFavorite = (address: string) =>
  updateSingleton(FEEDS, tags => append(["a", address], tags))

// Relays

export const requestRelayAccess = async (url: string, claim: string, sk?: string) =>
  createAndPublish({
    kind: 28934,
    forcePlatform: false,
    tags: [["claim", claim]],
    relays: [url],
    sk,
  })

export const setOutboxPolicies = async (modifyTags: ModifyTags) => {
  if (signer.get()) {
    updateSingleton(RELAYS, modifyTags)
  } else {
    anonymous.update($a => ({...$a, relays: modifyTags($a.relays)}))
  }
}

export const setInboxPolicies = async (modifyTags: ModifyTags) =>
  updateSingleton(INBOX_RELAYS, modifyTags)

export const setInboxPolicy = ({url, inbox}: RelayPolicy) => {
  // Only update inbox policies if they already exist or we're adding them
  if (inbox || get(userRelayPolicies).find(p => p.url === url && p.inbox)) {
    setInboxPolicies($tags => {
      $tags = $tags.filter(t => t[1] !== url)

      if (inbox) {
        $tags.push(["relay", url])
      }

      return $tags
    })
  }
}

export const setOutboxPolicy = ({url, read, write}: RelayPolicy) =>
  setOutboxPolicies($tags => {
    $tags = $tags.filter(t => t[1] !== url)

    if (read && write) {
      $tags.push(["r", url])
    } else if (read) {
      $tags.push(["r", url, "read"])
    } else if (write) {
      $tags.push(["r", url, "write"])
    }

    return $tags
  })

export const leaveRelay = async (url: string) => {
  await Promise.all([
    setInboxPolicy(makeRelayPolicy({url})),
    setOutboxPolicy(makeRelayPolicy({url})),
  ])

  // Make sure the new relay selections get to the old relay
  if (pubkey.get()) {
    broadcastUserData([url])
  }
}

export const joinRelay = async (url: string, claim?: string) => {
  url = normalizeRelayUrl(url)

  if (claim && signer.get()) {
    await requestRelayAccess(url, claim)
  }

  await setOutboxPolicy(makeRelayPolicy({url, read: true, write: true}))

  // Re-publish user meta to the new relay
  if (pubkey.get()) {
    broadcastUserData([url])
  }
}

// Read receipts

export const markAsSeen = async (kind: number, eventsByKey: Record<string, TrustedEvent[]>) => {
  if (!get(hasNip44) || Object.entries(eventsByKey).length === 0) {
    return
  }

  const prev = get(userSeenStatusEvents).find(e => e.kind === kind)
  const rawTags = parseJson(await ensurePlaintext(prev))
  const tags = Array.isArray(rawTags) ? rawTags.filter(t => !eventsByKey[t[1]]) : []

  for (const [key, events] of Object.entries(eventsByKey)) {
    if (events.length === 0) {
      continue
    }

    const [newer, older] = splitAt(10, events)
    const ts = first(older)?.created_at || last(newer).created_at - seconds(3, "hour")

    tags.push(["seen", key, ts, ...newer.map(e => e.id)])
  }

  const json = JSON.stringify(tags)
  const relays = hints.WriteRelays().getUrls()
  const content = await signer.get().nip44.encrypt(pubkey.get(), json)

  await createAndPublish({kind, content, relays})
}

// Messages

export const sendLegacyMessage = async (channelId: string, content: string) => {
  const $pubkey = pubkey.get()
  const recipients = without([$pubkey], channelId.split(","))

  if (recipients.length > 1) {
    throw new Error("Attempted to send legacy message to more than 1 recipient")
  }

  const recipient = recipients[0] || $pubkey

  return createAndPublish({
    kind: 4,
    tags: [mention(recipient), ...getClientTags()],
    content: await signer.get().nip04.encrypt(recipient, content),
    relays: hints.PublishMessage(recipient).getUrls(),
    forcePlatform: false,
  })
}

export const sendMessage = async (channelId: string, content: string) => {
  const recipients = channelId.split(",")
  const template = {
    content,
    kind: 14,
    created_at: now(),
    tags: [...recipients.map(mention), ...getClientTags()],
  }

  for (const recipient of uniq(recipients.concat(pubkey.get()))) {
    const helper = Nip59.fromSigner(signer.get())
    const rumor = await helper.wrap(recipient, template)

    await publish({
      event: rumor.wrap,
      relays: hints.PublishMessage(recipient).getUrls(),
      forcePlatform: false,
    })
  }
}

export const markChannelsRead = (ids: Set<string>) => {
  const $pubkey = pubkey.get()
  const eventsByKey = {}

  for (const {id, last_sent = 0, last_received = 0, last_checked = 0} of get(channels)) {
    if (!ids.has(id) || Math.max(last_sent, last_checked) > last_received) {
      continue
    }

    const members = id.split(",")
    const key = getChannelSeenKey(id)
    const since = Math.max(last_sent, last_checked)
    const events = repository
      .query([{kinds: [4, DIRECT_MESSAGE], authors: members, "#p": members, since}])
      .filter(e => getChannelIdFromEvent(e) === id && e.pubkey !== $pubkey)

    if (events.length > 0) {
      eventsByKey[key] = events
    }
  }

  markAsSeen(SEEN_CONVERSATION, eventsByKey)
}

export const markAllChannelsRead = () => markChannelsRead(new Set(get(channels).map(c => c.id)))

export const markChannelRead = (id: string) => markChannelsRead(new Set([id]))

// Session/login

const addSession = (s: Session) => {
  sessions.update(assoc(s.pubkey, s))
  pubkey.set(s.pubkey)
}

export const loginWithPrivateKey = (privkey, extra = {}) =>
  addSession({method: "privkey", pubkey: getPubkey(privkey), privkey, ...extra})

export const loginWithPublicKey = pubkey => addSession({method: "pubkey", pubkey})

export const loginWithExtension = pubkey => addSession({method: "extension", pubkey})

export const loginWithNsecBunker = async (pubkey, connectToken, connectRelay) => {
  const connectKey = makeSecret()
  const connectHandler = {relays: [connectRelay]}
  const broker = Nip46Broker.get(pubkey, connectKey, connectHandler)
  const result = await broker.connect(connectToken, nip46Perms)

  if (result) {
    addSession({
      method: "connect",
      pubkey,
      connectKey,
      connectToken,
      connectHandler,
    })
  }

  return result
}

export const loginWithNostrConnect = async (username, connectHandler: Nip46Handler) => {
  const connectKey = makeSecret()
  const {pubkey} = (await loadHandle(`${username}@${connectHandler.domain}`)) || {}

  let broker = Nip46Broker.get(pubkey, connectKey, connectHandler)

  if (!pubkey) {
    const pubkey = await broker.createAccount(username, nip46Perms)

    if (!pubkey) {
      return null
    }

    broker = Nip46Broker.get(pubkey, connectKey, connectHandler)
  }

  const result = await broker.connect("", nip46Perms)

  if (result) {
    addSession({
      method: "connect",
      pubkey: broker.pubkey,
      connectKey,
      connectHandler,
    })
  }

  return result
}

export const logoutPubkey = pubkey => {
  if (session.get().pubkey === pubkey) {
    throw new Error("Can't destroy the current session, use logout instead")
  }

  sessions.update(omit([pubkey]))
}

export const logout = () => {
  pubkey.set(null)
  sessions.set({})
}

export const setAppData = async (d: string, data: any) => {
  if (signer.get()) {
    const {pubkey} = session.get()

    return createAndPublish({
      kind: 30078,
      tags: [["d", d]],
      content: await signer.get().nip04.encrypt(pubkey, JSON.stringify(data)),
      relays: hints.WriteRelays().getUrls(),
      forcePlatform: false,
    })
  }
}

export const publishSettings = ($settings: Record<string, any>) =>
  setAppData(appDataKeys.USER_SETTINGS, $settings)

export const setSession = (pubkey, data) => {
  if (!equals(getSession(pubkey), data)) {
    sessions.update(assoc(pubkey, data))
  }
}

export const updateSession = (pubkey, f) => {
  const session = getSession(pubkey)

  if (session) {
    setSession(pubkey, f(session))
  }
}

export const setCurrentSession = data => setSession(pubkey.get(), data)

export const updateCurrentSession = f => updateSession(pubkey.get(), f)

export const broadcastUserData = async (relays: string[]) => {
  const authors = [pubkey.get()]
  const kinds = [RELAYS, FOLLOWS, PROFILE]
  const events = repository.query([{kinds, authors}])

  for (const event of events) {
    if (isSignedEvent(event)) {
      await publish({event, relays, forcePlatform: false})
    }
  }
}
