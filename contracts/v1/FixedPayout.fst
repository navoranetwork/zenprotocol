// FixedPayout, ZP contracts V1: Up / Down markets on an oracle price, settled at one close. Based on the V0 FixedPayout
// (src/ContractExamples/FixedPayout.fst, the developers' original): the same idea, message field names, oracle proof
// and attestation token, with three changes decided on 2026-10-16 (docs/BETS.md):
//   1. One close. A market is { OraclePubKey, OracleContractId, Ticker, Price, Start, Expiry, Collateral } with
//      Start = Expiry = the close (ms). V0 let any attested round in [Start, Expiry] settle it, so both sides could win
//      with different rounds and be paid from the collateral that backs every other market.
//   2. Settle once. "Settle" proves the close round and records the winner in the contract (a marker token it keeps);
//      "Redeem" then pays the winning side 1 collateral unit per token, with no proof. A market is settled once.
//   3. Void. If no Settle within 24 hours after the close, "Void" (anyone) marks the market void and every token,
//      Bull or Bear, redeems for half a unit (rounded down). A pair (Bull + Bear) always gives back what it locked.
//
// Commands (bodies are dictionaries; the market's seven fields are in every one):
//   Issue  : spend N of the Collateral -> N Bull + N Bear tokens to the sender (a public key or a contract).
//   Settle : + Position ("Bull" | "Bear", the winner), Root, Timestamp (= the close), Value (price x 1000), Index,
//            AuditPath (up to 30 hashes; GET /oracle/auditpath). Needs the round's attestation token in this contract's
//            wallet (the Oracle's Attest to this contract) and no earlier Settle or Void. Bull wins if Price <= Value.
//            Within 24 hours after the close (block timestamp).
//   Void   : more than 24 hours after the close, no Settle and no Void yet.
//   Redeem : + Position; spend N tokens of it -> N units (winner) or N / 2 units (void) to the sender.
//   Cancel : spend N Bull + N Bear -> N units, at any time.
// Tokens: this contract's assets with subtype SHA3(OraclePubKey (compressed), OracleContractId, Ticker padded to 4,
// Price U64, close U64, Collateral, tag): tag "Bull" / "Bear" for the positions; "BuWn", "BeWn", "Void" for the
// settlement markers it keeps (one unit each).
//
// Written per the code, not built: it needs zp-contracts-v1 dab00f8 or later (Zen.MerkleTree, Zen.Integers). Its
// helpers follow MerkleProbe.fst, which passed the V1 session's run on dab00f8. Every command pays the cost of the
// costliest one (Settle), padded by autoInc: cf below.

open Zen.Base
open Zen.Prelude
open Zen.Cost
open Zen.Types
open Zen.Data

module C = Zen.Cost
module CR = Zen.ContractResult
module Dict = Zen.Dictionary
module RT = Zen.ResultT
module Sha3 = Zen.Sha3
module TX = Zen.TxSkeleton
module OptT = Zen.OptionT
module Str = FStar.String
module U64 = FStar.UInt64
module W = Zen.Wallet

type ticker = s:string { Str.length s <= 4 }
type auditPath = p:list hash { length p <= 30 }
type tag = s:string { Str.length s = 4 }

type position =
    | Bull
    | Bear

type market = {
    oraclePubKey     : publicKey;
    oracleContractId : contractId;
    ticker           : ticker;
    price            : U64.t;
    close            : U64.t;
    collateral       : asset;
}

// 24 hours, in ms: how long after the close a Settle is accepted, and after which Void is
let grace : U64.t = 86400000UL

let field (body: option data) (k: string) =
    body >!= tryDict >?= Dict.tryFind k


// ---- parsing ---------------------------------------------------------------------------------------------------

let parseOracleId (o: option string) =
    match o with
    | Some s ->
        if Str.length s = 72 then
            (let (s: string { Str.length s = 72 }) = s in
             Zen.ContractId.parse s)
        else C.ret None |> autoInc
    | None -> C.ret None |> autoInc

let parseCollateral (o: option string) =
    match o with
    | Some s -> Zen.Asset.parse s
    | None -> C.ret None |> autoInc

// the market: Start and Expiry must be the same moment (the close)
let parseMarket (body: option data) =
    let! pk = field body "OraclePubKey" >?= tryPublicKey in
    let! oid = field body "OracleContractId" >?= tryString in
    let! t = field body "Ticker" >?= tryString in
    let! price = field body "Price" >?= tryU64 in
    let! start = field body "Start" >?= tryU64 in
    let! expiry = field body "Expiry" >?= tryU64 in
    let! coll = field body "Collateral" >?= tryString in
    let! cid = parseOracleId oid in
    let! asset = parseCollateral coll in
    match pk, cid, t, price, start, expiry, asset with
    | Some pk, Some cid, Some t, Some price, Some start, Some expiry, Some asset ->
        if Str.length t <= 4 && U64.eq start expiry then
            (let (t: ticker) = t in
             C.ret (Some ({ oraclePubKey = pk; oracleContractId = cid; ticker = t; price = price; close = start;
                            collateral = asset })))
        else C.ret None |> autoInc
    | _ -> C.ret None |> autoInc

let parsePosition (body: option data) =
    let! s = field body "Position" >?= tryString in
    C.ret (match s with
           | Some "Bull" -> Some Bull
           | Some "Bear" -> Some Bear
           | _ -> None)

// the path: at most 30 hashes (a 31st item refuses it), read at the cost of 30
let pathOf (ls: list data) =
    let! extra = Zen.List.tryNth ls 30 in
    match extra with
    | None ->
        (let (ls: list data { length ls <= 30 }) = ls in
         OptT.tryMapT tryHash ls
         |> (fun x -> x <: option auditPath `cost` (30 * 22 + 20)))
    | Some _ -> C.ret None |> autoInc

// the oracle's proof of the close: Root, Timestamp, Value, Index, AuditPath
let parseProof (body: option data) =
    let! root = field body "Root" >?= tryHash in
    let! ts = field body "Timestamp" >?= tryU64 in
    let! value = field body "Value" >?= tryU64 in
    let! idx = field body "Index" >?= tryU64 in
    let! ls = field body "AuditPath" >?= tryList in
    match root, ts, value, idx, ls with
    | Some root, Some ts, Some value, Some idx, Some ls ->
        (let! path = pathOf ls in
         match path with
         | Some path -> C.ret (Some (root, ts, value, idx, path))
         | None -> C.ret None |> autoInc)
    | _ -> C.ret None |> autoInc


// ---- hashing: tokens, the oracle's leaf and attestation token ----------------------------------------------------

// as the V0 Oracle and FixedPayout: the compressed key
let updatePublicKey (pk: publicKey) (s: Sha3.t) =
    let! cpk = Zen.PublicKey.compress pk in
    Sha3.updateCPK cpk s

// Sha3.updateString at a constant cost: padded to 4 characters
let updateTicker (t: ticker) (s: Sha3.t) =
    (ret s
    >>= Sha3.updateString t
    >>= incRet (6 * (4 - Str.length t)))
    |> (fun x -> x <: Sha3.t `cost` 24)

let marketHash (m: market) (tg: tag) =
    let! s1 = updatePublicKey m.oraclePubKey Sha3.empty in
    let! s2 = Sha3.updateContractId m.oracleContractId s1 in
    let! s3 = updateTicker m.ticker s2 in
    let! s4 = Sha3.updateU64 m.price s3 in
    let! s5 = Sha3.updateU64 m.close s4 in
    let! s6 = Sha3.updateAsset m.collateral s5 in
    let! s7 = (Sha3.updateString tg s6 <: Sha3.t `cost` 24) in
    Sha3.finalize s7

// one of this contract's tokens for the market: a position ("Bull", "Bear") or a marker ("BuWn", "BeWn", "Void")
let token (cid: contractId) (m: market) (tg: tag) =
    let (v, h) = cid in
    let! sub = marketHash m tg in
    C.ret ((v, h, sub) <: asset)

let positionTag (p: position) : tag =
    match p with
    | Bull -> "Bull"
    | Bear -> "Bear"

let wonTag (p: position) : tag =
    match p with
    | Bull -> "BuWn"
    | Bear -> "BeWn"

// the oracle's leaf: Sha3 of the ticker's bytes, then the value as a U64 (FixedPayout's hashLeaf, the oracle service)
let leafOf (key: ticker) (value: U64.t) =
    (ret Sha3.empty
    >>= Sha3.updateString key
    >>= Sha3.updateU64 value
    >>= Sha3.finalize)
    |> inc (24 - 6 * Str.length key)
    |> (fun x -> x <: hash `cost` 92)

// Zen.MerkleTree.verify at the cost of a path of 30 (a shorter path uses less)
let verifyPadded (r: hash) (p: auditPath) (i: nat) (l: hash) =
    Zen.MerkleTree.verify r p i l
    |> (fun x -> x <: bool `cost` (30 * 420 + 4))

// the Oracle contract's attestation token for a round (as the V0 Oracle and FixedPayout derive it)
let attestToken (oracle: contractId) (root: hash) (ts: U64.t) (pk: publicKey) =
    let (v, h) = oracle in
    let! s1 = Sha3.updateHash root Sha3.empty in
    let! s2 = Sha3.updateU64 ts s1 in
    let! commit = Sha3.finalize s2 in
    let! s3 = Sha3.updateHash commit Sha3.empty in
    let! s4 = updatePublicKey pk s3 in
    let! commitment = Sha3.finalize s4 in
    let! s5 = Sha3.updateHash commitment Sha3.empty in
    let! a = Sha3.finalize s5 in
    C.ret ((v, h, a) <: asset)


// ---- the contract's wallet ----------------------------------------------------------------------------------------

// one unit of an asset the contract holds, taken and given back to it: Some = the contract holds it
let keepOne (a: asset) (cid: contractId) (w: wallet) (tx: txSkeleton) =
    let! r = TX.fromWallet a 1UL cid w tx in
    match r with
    | Some t1 ->
        (let! t2 = TX.lockToContract a 1UL cid t1 in
         C.ret (Some t2))
    | None -> C.ret None |> autoInc

let absent (a: asset) (cid: contractId) (w: wallet) (tx: txSkeleton) =
    let! r = TX.fromWallet a 1UL cid w tx in
    C.ret (match r with
           | None -> true
           | Some _ -> false)

// no Settle and no Void yet for this market
let markersFree (cid: contractId) (m: market) (w: wallet) (tx: txSkeleton) =
    let! wb = token cid m "BuWn" in
    let! wr = token cid m "BeWn" in
    let! vd = token cid m "Void" in
    let! a1 = absent wb cid w tx in
    let! a2 = absent wr cid w tx in
    let! a3 = absent vd cid w tx in
    C.ret (a1 && a2 && a3)

let lockToSender (a: asset) (amount: U64.t) (sender: sender) (tx: txSkeleton) =
    match sender with
    | PK pk ->
        (let! t = TX.lockToPublicKey a amount pk tx in
         C.ret (Some t))
    | Contract c ->
        (let! t = TX.lockToContract a amount c tx in
         C.ret (Some t)) |> autoInc
    | Anonymous -> C.ret None |> autoInc

// destroys n of a token sent in, and pays `amount` of the collateral from the contract to the sender
let payOut (tx: txSkeleton) (m: market) (tok: asset) (n: U64.t) (amount: U64.t) (cid: contractId) (sender: sender)
           (w: wallet) =
    let! t1 = TX.destroy n tok tx in
    let! t2 = TX.fromWallet m.collateral amount cid w t1 in
    match t2 with
    | Some t2 ->
        (let! t3 = lockToSender m.collateral amount sender t2 in
         match t3 with
         | Some t3 -> CR.ofTxSkel t3
         | None -> RT.autoFailw "Sender can't be anonymous")
    | None -> RT.autoFailw "Insufficient funds"


// ---- commands ---------------------------------------------------------------------------------------------------

let proofHolds (m: market) (p: position) (root: hash) (ts: U64.t) (value: U64.t) (idx: U64.t) (path: auditPath) =
    let! l = leafOf m.ticker value in
    let! verified = verifyPadded root path (Zen.Integers.u64ToNat idx) l in
    let priceOk = (match p with
                   | Bull -> U64.lte m.price value
                   | Bear -> U64.lt value m.price) in
    C.ret (verified && priceOk && U64.eq ts m.close)

let settle (tx: txSkeleton) (ctx: context) (cid: contractId) (body: option data) (w: wallet) =
    let! mk = parseMarket body in
    let! pos = parsePosition body in
    let! pr = parseProof body in
    match mk, pos, pr with
    | Some m, Some p, Some (root, ts, value, idx, path) ->
        (let! proofOk = proofHolds m p root ts value idx path in
         let! free = markersFree cid m w tx in
         let! won = token cid m (wonTag p) in
         let! att = attestToken m.oracleContractId root ts m.oraclePubKey in
         let! held = keepOne att cid w tx in
         let inTime = U64.lte ctx.timestamp (U64.add_mod m.close grace) in
         match held with
         | Some t1 ->
             if proofOk && free && inTime then
                 (let! t2 = TX.mint 1UL won t1 in
                  let! t3 = TX.lockToContract won 1UL cid t2 in
                  CR.ofTxSkel t3)
             else RT.autoFailw "Settle refused: not the close round, a wrong proof or side, already settled or void, or more than 24 hours after the close"
         | None -> RT.autoFailw "No attestation of this round in the contract: run the Oracle's Attest to this contract first")
    | _ -> RT.autoFailw "Settle needs the market (Start = Expiry), Position, Root, Timestamp, Value, Index and AuditPath (up to 30)"

let voidMarket (tx: txSkeleton) (ctx: context) (cid: contractId) (body: option data) (w: wallet) =
    let! mk = parseMarket body in
    match mk with
    | Some m ->
        (let! free = markersFree cid m w tx in
         let! vd = token cid m "Void" in
         let late = U64.gt ctx.timestamp (U64.add_mod m.close grace) in
         if free && late then
             (let! t1 = TX.mint 1UL vd tx in
              let! t2 = TX.lockToContract vd 1UL cid t1 in
              CR.ofTxSkel t2)
         else RT.autoFailw "Void refused: the market is settled or void, or 24 hours have not passed since the close")
    | None -> RT.autoFailw "Could not parse the market (Start must equal Expiry)"

let redeem (tx: txSkeleton) (cid: contractId) (sender: sender) (body: option data) (w: wallet) =
    let! mk = parseMarket body in
    let! pos = parsePosition body in
    match mk, pos with
    | Some m, Some p ->
        (let! tok = token cid m (positionTag p) in
         let! won = token cid m (wonTag p) in
         let! vd = token cid m "Void" in
         let! n = TX.getAvailableTokens tok tx in
         let half = U64.div n 2UL in
         let! hasWon = keepOne won cid w tx in
         let! hasVoid = keepOne vd cid w tx in
         if U64.gt n 0UL then
             (match hasWon, hasVoid with
              | Some t1, _ -> payOut t1 m tok n n cid sender w
              | None, Some t1 -> payOut t1 m tok n half cid sender w
              | None, None -> RT.autoFailw "Not paid: this side did not win, or the market is not settled or void yet")
         else RT.autoFailw "No tokens of this position were sent")
    | _ -> RT.autoFailw "Redeem needs the market (Start = Expiry) and Position"

let cancel (tx: txSkeleton) (cid: contractId) (sender: sender) (body: option data) (w: wallet) =
    let! mk = parseMarket body in
    match mk with
    | Some m ->
        (let! bull = token cid m "Bull" in
         let! bear = token cid m "Bear" in
         let! nBull = TX.getAvailableTokens bull tx in
         let! nBear = TX.getAvailableTokens bear tx in
         let! t1 = TX.destroy nBear bear tx in
         if U64.eq nBull nBear && U64.gt nBull 0UL then payOut t1 m bull nBull nBull cid sender w
         else RT.autoFailw "There must be an equal amount of both bull and bear tokens in the transaction")
    | None -> RT.autoFailw "Could not parse the market (Start must equal Expiry)"

let issue (tx: txSkeleton) (cid: contractId) (sender: sender) (body: option data) =
    let! mk = parseMarket body in
    match mk with
    | Some m ->
        (let! bull = token cid m "Bull" in
         let! bear = token cid m "Bear" in
         let! n = TX.getAvailableTokens m.collateral tx in
         let! t1 = TX.mint n bull tx in
         let! t2 = TX.mint n bear t1 in
         let! t3 = lockToSender bull n sender t2 in
         let! t4 = (match t3 with
                    | Some t3 -> lockToSender bear n sender t3
                    | None -> C.ret None |> autoInc) in
         match t4 with
         | Some t4 ->
             if U64.gt n 0UL then
                 (let! t5 = TX.lockToContract m.collateral n cid t4 in
                  CR.ofTxSkel t5)
             else RT.autoFailw "No collateral provided"
         | None -> RT.autoFailw "Sender can't be anonymous")
    | None -> RT.autoFailw "Could not parse the market (OraclePubKey, OracleContractId, Ticker up to 4 characters, Price, Start = Expiry, Collateral)"

// the costliest command first; the others are padded to it
let main txSkel context contractId command sender messageBody wallet state =
    match command with
    | "Settle" -> settle txSkel context contractId messageBody wallet
    | "Redeem" -> redeem txSkel contractId sender messageBody wallet |> autoInc
    | "Void" -> voidMarket txSkel context contractId messageBody wallet |> autoInc
    | "Cancel" -> cancel txSkel contractId sender messageBody wallet |> autoInc
    | "Issue" -> issue txSkel contractId sender messageBody |> autoInc
    | _ -> RT.autoFailw "Unsupported command"

// above Settle's cost: the proof (a path of 30: 12,604; reading it: 680), five token and attestation hashes (about
// 1,400 each), the body reads, and four reads of the contract's wallet (128 per coin each)
let cf _ _ _ _ _ w _ =
    (30000 + W.size w * 512)
    |> cast nat
    |> C.ret
