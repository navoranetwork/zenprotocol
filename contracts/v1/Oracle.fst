// Oracle, ZP contracts V1: the port of the V0 Oracle (src/ContractExamples/Oracle.fst, the developers' original).
// Same commands, message bodies, error messages and token derivations as V0, so the oracle service
// (src/Oracle), FixedPayout and the auditpath API work unchanged; only the contract id (version 1) changes.
//
//   Commit  signed by the oracle's key (a PK sender)
//           body { Commit: Hash, FeeAsset?: String, FeeAmount?: U64 }
//           mints one commitment token, subtype SHA3(Commit || cpk(oracle) [|| FeeAsset || FeeAmount]), and keeps it
//           in this contract's wallet: the chain now proves the commitment existed at that block.
//   Attest  body { Commit: Hash, OraclePubKey: PublicKey, Recipient?: Lock, ReturnAddress?: Lock,
//                  FeeAsset?: String, FeeAmount?: U64 }
//           the commitment token must be in this contract's wallet (it is spent and locked back here);
//           mints one attestation token, subtype SHA3(SHA3(Commit || cpk(OraclePubKey))), to Recipient
//           (default: the sender's lock). With FeeAmount, that much of FeeAsset (default ZP) goes to the oracle's
//           key and the change to ReturnAddress (default: the sender).
//           FeeAsset: only "00" (ZP) in V1 (Zen.Asset.parse is not realized in Zulib V1); V0 also took token ids.
//
// Differences from V0 (none observable): Zen.PublicKey.compress replaces the local copy (V0's read the key with
// Zen.Array.item, which V1 does not allow in code that runs; same bytes, same cost 305); no `module` line; tuple
// type with `&`; `|>` after `>>=` chains in parentheses (V1-SPEC 4.3); `dataAttest'` renamed `dataAttestInner`.
// Keep every expression's shape as in V0: the `val`s declare V0's exact costs, and a different shape (even a field
// access instead of a record pattern) changes the elaborated cost and fails the type check.
//
// Cost (cf): Commit 2650, Attest 5081 + 128 per coin in the contract's wallet (Tx.fromWallet walks it), any other
// command 8; as V0. Each Commit adds one coin, so Attest grows by 128 gas per round committed: about 7,700 rounds
// fit under the 1,000,000 gas per call (about 320 days at one round an hour). Commit does not grow.

open Zen.Base
open Zen.Cost
open Zen.Types
open Zen.Data

module CR = Zen.ContractResult
module Dict = Zen.Dictionary
module OT = Zen.OptionT
module RT = Zen.ResultT
module Sha3 = Zen.Hash.Sha3
module TX = Zen.TxSkeleton
module W = Zen.Wallet
module U64 = FStar.UInt64
module Asset = Zen.Asset
module PubKey = Zen.PublicKey



type commitData =
    { commit       : hash
    ; oraclePubKey : publicKey
    ; feeAsset     : asset
    ; feeAmount    : option U64.t
    }

type attestData =
    { commitData    : commitData
    ; recipient     : lock
    ; returnAddress : option lock
    }

type assets =
    { commitment  : asset
    ; attestation : asset
    }



(*
-------------------------------------------------------------------------------
========== COMPRESSED PUBLIC KEY ==============================================
-------------------------------------------------------------------------------
*)

val updateCPK : PubKey.cpk -> Sha3.t -> Sha3.t `cost` 205
let updateCPK (parity , h) s = // 7
    ret s
    >>= Sha3.updateByte parity
    >>= Sha3.updateHash h

val hashCPK : PubKey.cpk -> hash `cost` 231
let hashCPK cpk = // 6
    ret Sha3.empty
    >>= updateCPK cpk // 205
    >>= Sha3.finalize // 20



(*
-------------------------------------------------------------------------------
========== DATA PARSING =======================================================
-------------------------------------------------------------------------------
*)

val senderToLock : sender -> lock `OT.t` 551
let senderToLock sender = // 15
    begin match sender with
    | PK pk ->
        let! pkHash =
            ret pk
            >>= PubKey.compress // 305
            >>= hashCPK  // 231
        in ret (Some (PKLock pkHash))
    | Contract cid ->
        Some (ContractLock cid)
        |> incRet 536
    | Anonymous ->
        None
        |> incRet 536
    end

val parseDict: option data -> Dict.t data `RT.t` 12
let parseDict data = // 8
    match data with
    | Some data ->
        data
        |> tryDict // 4
        |> RT.ofOptionT "Data parsing failed - the message body isn't a dictionary"
    | None ->
        RT.incFailw 4 "Data parsing failed - the message body is empty"

val parseCommit : Dict.t data -> hash `RT.t` 78
let parseCommit dict = // 12
    let open RT in
    ret dict
    >>= (Dict.tryFind "Commit" >> ofOptionT "Couldn't find Commit in message body") // 64
    >>= (tryHash               >> ofOptionT "Commit must be an hash") // 2

val parseOraclePubKey : Dict.t data -> publicKey `RT.t` 78
let parseOraclePubKey dict = // 12
    let open RT in
    ret dict
    >>= (Dict.tryFind "OraclePubKey" >> ofOptionT "Couldn't find OraclePubKey in message body") // 64
    >>= (tryPublicKey                >> ofOptionT "OraclePubKey must be a public key") // 2

val parseRecipient : sender -> Dict.t data -> lock `RT.t` 632
let parseRecipient sender dict = // 17
    let open RT in
    let! recipient = Dict.tryFind "Recipient" dict in // 64
    begin match recipient with
    | Some (Lock recip) ->
        incRet 551 recip
    | Some _ ->
        incFailw 551 "Recipient (if specified) must be a lock"
    | None ->
        let! senderLock = senderToLock sender in // 551
        match senderLock with
        | Some recip ->
            ret recip
        | None ->
            failw "When the recipient is unspecified the sender can't be anonymous"
    end

val parseReturnAddress : Dict.t data -> option lock `RT.t` 76
let parseReturnAddress dict = // 12
    let open RT in
    let! returnAddress = Dict.tryFind "ReturnAddress" dict in // 64
    match returnAddress with
    | None ->
        ret None
    | Some (Lock address) ->
        ret (Some address)
    | Some _ ->
        failw "ReturnAddress (if specified) must be a lock"

// V1 has no realization of Zen.Asset.parse (an `assume val` in Zulib V1): only "00" (ZP) is accepted as FeeAsset,
// any other asset string is "Invalid FeeAsset". Same cost as Zen.Asset.parse (64), so the rest keeps V0's costs.
val parseAsset : string -> option asset `cost` 64
let parseAsset s =
    incRet 60 (if s = "00" then Some Asset.zenAsset else None)

val parseFeeAsset : Dict.t data -> asset `RT.t` 142
let parseFeeAsset dict  = // 14
    let open RT in
    let! feeAsset = Dict.tryFind "FeeAsset" dict in // 64
    match feeAsset with
    | None ->
        incRet 64 Asset.zenAsset
    | Some (String asset) ->
        parseAsset asset // 64
        |> ofOptionT "Invalid FeeAsset - failed to parse asset string"
    | Some _ ->
        incFailw 64 "FeeAsset must be a string"

val parseFeeAmount : Dict.t data -> option U64.t `RT.t` 81
let parseFeeAmount dict = // 17
    let open RT in
    let! feeAmount = Dict.tryFind "FeeAmount" dict in // 64
    match feeAmount with
    | None ->
        ret None
    | Some (U64 amount) ->
        if amount `U64.gt` 0UL then ret (Some amount) else ret None
    | Some _ ->
        failw "FeeAmount (if specified) must be a UInt64"

val parseCommitData : publicKey -> option data -> commitData `RT.t` 331
let parseCommitData pk msgBody = // 18
    let open RT in
    parseDict msgBody >>= (fun dict   -> // 12
    parseCommit    dict >>= (fun commit    -> // 78
    parseFeeAsset  dict >>= (fun feeAsset  -> // 142
    parseFeeAmount dict >>= (fun feeAmount -> // 81
        { commit       = commit
        ; oraclePubKey = pk
        ; feeAsset     = feeAsset
        ; feeAmount    = feeAmount
        } |> ret
    ))))

val parseAttestData : sender -> option data -> attestData `RT.t` 1130
let parseAttestData sender msgBody = // 31
    let open RT in
    parseDict msgBody >>= (fun dict   -> // 12
    parseCommit           dict >>= (fun commit        -> // 78
    parseOraclePubKey     dict >>= (fun oraclePubKey  -> // 78
    parseRecipient sender dict >>= (fun recipient     -> // 632
    parseReturnAddress    dict >>= (fun returnAddress -> // 76
    parseFeeAsset         dict >>= (fun feeAsset      -> // 142
    parseFeeAmount        dict >>= (fun feeAmount     -> // 81
        { commitData =
            { commit       = commit
            ; oraclePubKey = oraclePubKey
            ; feeAsset     = feeAsset
            ; feeAmount    = feeAmount
            }
        ; recipient     = recipient
        ; returnAddress = returnAddress
        } |> ret
    )))))))



(*
-------------------------------------------------------------------------------
========== TOKENIZATION =======================================================
-------------------------------------------------------------------------------
*)

val hashCommitData : commitData -> hash `cost` 1179
let hashCommitData data = // 25
    let! cpk = PubKey.compress data.oraclePubKey in // 305
    match data.feeAmount with
    | None ->
        (ret Sha3.empty
        >>= Sha3.updateHash data.commit // 192
        >>= updateCPK cpk               // 205
        >>= Sha3.finalize)              // 20
        |> inc 432
    | Some amount ->
        ret Sha3.empty
        >>= Sha3.updateHash data.commit    // 192
        >>= updateCPK cpk                  // 205
        >>= Sha3.updateAsset data.feeAsset // 384
        >>= Sha3.updateU64 amount          // 48
        >>= Sha3.finalize                  // 20

val hashAttestData : commitData -> hash `cost` 736
let hashAttestData data = // 14
    let! cpk = PubKey.compress data.oraclePubKey in // 305
    ret Sha3.empty
    >>= Sha3.updateHash data.commit // 192
    >>= updateCPK cpk               // 205
    >>= Sha3.finalize               // 20

val mkAssets : contractId -> commitData -> assets `cost` 2150
let mkAssets (v, h) data = // 23
    let! commitHash =
        hashCommitData data in // 1179
    let! attestHash1 =
        hashAttestData data in // 736
    let! attestHash2 =
        ret Sha3.empty
        >>= Sha3.updateHash attestHash1 // 192
        >>= Sha3.finalize in            // 20
    ret ({ commitment=v,h,commitHash; attestation=v,h,attestHash2 })



(*
-------------------------------------------------------------------------------
========== COMMAND: Commit ====================================================
-------------------------------------------------------------------------------
*)

val dataCommit :
    txSkeleton
    -> contractId
    -> commitData
    -> txSkeleton `cost` 2292
let dataCommit txSkel cid args = // 14
    let! ({commitment = commitment}) = mkAssets cid args in // 2150
    ret txSkel
    >>= TX.mint 1UL commitment               // 64
    >>= TX.lockToContract commitment 1UL cid // 64

val commit :
  contractId
  -> sender
  -> option data
  -> txSkeleton
  -> CR.t `cost` 2642
let commit cid sender msgBody txSkel = // 16
    let open RT in
    let! tx =
        begin match sender with
        | PK pk ->
            ret msgBody
            >>= parseCommitData pk                  // 331
            >>= (liftCost << dataCommit txSkel cid) // 2292
        | _ ->
            "Sender must be a public key"
            |> RT.incFailw 2623
        end
    in CR.ofResultTxSkel tx // 3



(*
-------------------------------------------------------------------------------
========== COMMAND: Attest ====================================================
-------------------------------------------------------------------------------
*)

val returnChange : attestData -> sender -> U64.t -> U64.t -> txSkeleton -> txSkeleton `RT.t` 637
let returnChange data sender available fee txSkel = // 27
    let open RT in
    if available `U64.gt` fee then
        let change = available `U64.sub` fee in
        match data.returnAddress with
        | Some address ->
            TX.lockToAddress data.commitData.feeAsset change address txSkel // 64
            |> liftCost |> inc 546
        | None ->
            match sender with
            | PK pk ->
                TX.lockToPublicKey data.commitData.feeAsset change pk txSkel // 610
                |> liftCost
            | Contract cid ->
                TX.lockToContract data.commitData.feeAsset change cid txSkel // 64
                |> liftCost |> inc 546
            | Anonymous ->
                "When the sender is anonymous you must provide a returnAddress"
                |> incFailw 610
    else if available `U64.eq` fee then
        txSkel
        |> incRet 610
    else
        "Insufficient oracle fee"
        |> incFailw 610

val addFee : sender -> attestData -> txSkeleton -> txSkeleton `RT.t` 1338
let addFee sender data txSkel = // 27
    match data.commitData.feeAmount with
    | Some fee ->
        let! available = TX.getAvailableTokens data.commitData.feeAsset txSkel in // 64
        ret txSkel
        >>= TX.lockToPublicKey data.commitData.feeAsset fee data.commitData.oraclePubKey // 610
        >>= returnChange data sender available fee // 637
    | None ->
        txSkel
        |> RT.incRet 1311

val attestTx :
    assets
    -> sender
    -> contractId
    -> (w : wallet)
    -> attestData
    -> txSkeleton
    -> txSkeleton `RT.t` (0 + 64 + 64 + (W.size w * 128 + 192) + 64 + 1338 + 39)
let attestTx assets sender cid w data txSkel = // 39
    let open RT in
    ret txSkel
    >>= (liftCost << TX.mint 1UL assets.attestation) // 64
    >>= (liftCost << TX.lockToAddress assets.attestation 1UL data.recipient) // 64
    >>= (ofOptionT "Data wasn't committed" << TX.fromWallet assets.commitment 1UL cid w) // W.size w * 128 + 192
    >>= (liftCost << TX.lockToContract assets.commitment 1UL cid) // 64
    >>= addFee sender data // 1338

val dataAttestInner :
    sender
    -> contractId
    -> (w : wallet)
    -> txSkeleton
    -> attestData
    -> txSkeleton `RT.t` (2150 + (0 + 64 + 64 + (W.size w * 128 + 192) + 64 + 1338 + 39) + 11)
let dataAttestInner sender cid w txSkel data = // 16
    let! assets = mkAssets cid data.commitData in // 2150
    attestTx assets sender cid w data txSkel // ...

val dataAttest :
    sender
    -> contractId
    -> (w : wallet)
    -> txSkeleton
    -> attestData
    -> txSkeleton `RT.t` (W.size w * 128 + 3929)
let dataAttest sender cid w txSkel data = // 7
    dataAttestInner sender cid w txSkel data
    |> (fun x -> x <: txSkeleton `RT.t` (W.size w * 128 + 3922))

val attest :
    contractId ->
    (w : wallet) ->
    sender ->
    option data ->
    txSkeleton ->
    CR.t `cost` (W.size w * 128 + 5073)
let attest cid w sender msgBody txSkel = // 11
    let open RT in
    let! tx =
        parseAttestData sender msgBody // 1130
        >>= dataAttest sender cid w txSkel // W.size w * 128 + 3929
    in CR.ofResultTxSkel tx // 3



(*
-------------------------------------------------------------------------------
========== MAIN ===============================================================
-------------------------------------------------------------------------------
*)

val main :
       txSkel  : txSkeleton
    -> context : context
    -> cid     : contractId
    -> command : string
    -> sender  : sender
    -> msgBody : option data
    -> w       : wallet
    -> state   : option data
    -> CR.t `cost`
        begin match command with
        | "Commit" -> 2642 + 8
        | "Attest" -> W.size w * 128 + 5073 + 8
        | _        -> 8
        end
let main txSkel _ cid command sender msgBody w _ = // 8
    begin match command with
    | "Commit" ->
        commit cid sender msgBody txSkel // 2642
        <: CR.t `cost`
            begin match command with
            | "Commit" -> 2642
            | "Attest" -> W.size w * 128 + 5073
            | _        -> 0
            end
    | "Attest" ->
        attest cid w sender msgBody txSkel // W.size w * 128 + 5073
    | _ ->
        RT.failw "Command not recognized"
    end

val cf :
       txSkel     : txSkeleton
    -> context    : context
    -> command    : string
    -> sender     : sender
    -> messageBody: option data
    -> w          : wallet
    -> state      : option data
    -> nat `cost` 10
let cf _ _ command _ _ w _ = // 10
    begin match command with
    | "Commit" -> 2650
    | "Attest" -> W.size w * 128 + 5081
    | _        -> 8
    end
    |> ret
