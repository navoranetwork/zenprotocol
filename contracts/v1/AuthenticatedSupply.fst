// AuthenticatedSupply, ZP contracts V1: the port of the V0 contract (src/ContractExamples/AuthenticatedSupply.fst,
// the developers' original), the zUSDC token of the USDC bridge (docs/BRIDGE.md). Same commands, message bodies,
// error messages and costs as V0, so the bridge service (site/bridge/bridge.mjs) works unchanged.
//
//   Issue    signed by authenticatedPubKey; body { Amount: U64 (not 0), returnAddress: Lock }
//            mints Amount of this contract's default token and locks it to returnAddress
//   Destroy  signed by authenticatedPubKey; body { Amount: U64 (not 0) }
//            destroys Amount of the token; the caller sends that much in (the node refuses a transaction that
//            destroys more than its inputs hold)
//
// authenticatedPubKey (a compressed public key, 66 hex) is written into the source before activation
// (scripts/v1/testnet-v1-zusdc.mjs: the node wallet's key at m/44'/258'/0'/3/0, as the V0 install did), so the
// contract id depends on it. Cost: Issue 529, Destroy 381, other commands 7; nothing depends on the wallet.
// Differences from V0: no `module` line. Every expression keeps V0's shape: the `val`s declare V0's exact costs.

open Zen.Cost
open Zen.Data
open Zen.Types

module CR = Zen.ContractResult
module Dict = Zen.Dictionary
module RT = Zen.ResultT
module TX = Zen.TxSkeleton
module U64 = FStar.UInt64

// the public key that messages must be signed with
let authenticatedPubKey = ""

val getReturnAddress: option (Dict.t data) -> result lock `cost` 77
let getReturnAddress dict = // 11
    let! returnAddress = dict >!= Dict.tryFind "returnAddress" // 64
                              >?= tryLock in // 2
    match returnAddress with
    | Some returnAddress ->
        RT.ok returnAddress
    | None ->
        RT.failw "Message Body must include valid returnAddress"

val getAmount: option (Dict.t data) -> result U64.t `cost` 82
let getAmount dict = // 16
    let! orderTotal = dict >!= Dict.tryFind "Amount" // 64
                           >?= tryU64 in // 2
    match orderTotal with
    | Some orderTotal ->
        if orderTotal <> 0UL
        then RT.ok orderTotal
        else RT.failw "Amount cannot be 0"
    | None ->
        RT.failw "Message Body must include valid Amount"

// checks that the sender matches the authenticatedPubKey
val authenticate: sender -> result bool `cost` 135
let authenticate sender = // 15
    let! authenticatedPubKey = Zen.Crypto.parsePublicKey authenticatedPubKey in // 120
    match authenticatedPubKey, sender with
    | Some authenticatedPubKey, PK senderPubKey ->
        RT.ok (authenticatedPubKey = senderPubKey)
    | None, _ ->
        RT.failw "Could not parse authenticatedPubKey. Please re-deploy this contract with a valid authenticatedPubKey."
    | _ ->
        RT.failw "Sender must sign with Public Key"

val issueTX: txSkeleton -> contractId -> U64.t -> lock -> bool -> CR.t `cost` 211
let issueTX tx contractID amount returnAddress authenticated = // 16
    if authenticated then begin
        let! asset = Zen.Asset.getDefault contractID in // 64
        // mint the required amount of the asset
        TX.mint amount asset tx // 64
        // lock to the return address
        >>= TX.lockToAddress asset amount returnAddress // 64
        >>= CR.ofTxSkel end // 3
    else
        RT.autoFailw "Authentication failed"

val issue: txSkeleton -> contractId -> sender -> option data -> CR.t `cost` 522
let issue tx contractID sender messageBody = // 13
    let! dict = messageBody >!= tryDict in // 4
    let amount = getAmount dict in // 82
    let returnAddress = getReturnAddress dict in // 77
    let authenticated = authenticate sender in // 135
    RT.bind3 amount returnAddress authenticated (issueTX tx contractID) // 211

val destroyTX: txSkeleton -> contractId -> U64.t -> bool -> CR.t `cost` 142
let destroyTX tx contractID amount authenticated = // 11
    if authenticated then begin
        let! asset = Zen.Asset.getDefault contractID in // 64
        // destroy the required amount of the asset
        TX.destroy amount asset tx // 64
        >>= CR.ofTxSkel end // 3
    else
        RT.autoFailw "Authentication failed"

val destroy: txSkeleton -> contractId -> sender -> option data -> CR.t `cost` 374
let destroy tx contractID sender messageBody = // 11
    let! dict = messageBody >!= tryDict in // 4
    let amount = getAmount dict in // 82
    let authenticated = authenticate sender in // 135
    RT.bind2 amount authenticated (destroyTX tx contractID) // 142

val main:
    txSkeleton
    -> context
    -> contractId
    -> command: string
    -> sender
    -> option data
    -> wallet
    -> option data
    -> CR.t `cost` begin match command with
                   | "Issue" -> 529
                   | "Destroy" -> 381
                   | _ -> 7 end
let main tx _ contractID command sender messageBody _ _ = // 7
    match command with
    | "Issue" -> issue tx contractID sender messageBody // 522
                 <: CR.t `cost` begin match command with
                                | "Issue" -> 522
                                | "Destroy" -> 374
                                | _ -> 0 end
    | "Destroy" -> destroy tx contractID sender messageBody // 374
    | _ -> RT.failw "Invalid Command"

val cf:
    txSkeleton
    -> context
    -> string
    -> sender
    -> option data
    -> wallet
    -> option data
    -> nat `cost` 4
let cf _ _ command _ _ _ _ = // 4
    ret begin match command with
        | "Issue" -> 529
        | "Destroy" -> 381
        | _ -> 7 end
