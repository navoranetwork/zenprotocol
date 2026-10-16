// MerkleProbe, ZP contracts V1: checks, before FixedPayout is ported, that a V1 contract can prove an oracle price
// the way FixedPayout does: rebuild the leaf (Sha3 of the ticker, then the U64 value x 1000, as FixedPayout's
// hashLeaf and the oracle service build it), verify it against the round's Merkle root with Zen.MerkleTree.verify,
// and read the oracle's contract id with Zen.ContractId.parse. Test only: it holds nothing and changes nothing.
//
//   any command, body { root: Hash, path: List of Hash, index: U64, oracle: String (a contract id, 72 hex), and
//                       either ticker: String + value: U64 (value x 1000: an oracle round)
//                       or leaf: Hash (a test vector, zp-contracts-v1 tests/merkle/vectors.txt) }
//   succeeds only if: the leaf verifies, a different leaf does not (the leaf of value + 1, or the Sha3 of the given
//   leaf), and the oracle id parses. Otherwise "merkle check failed".
// Needs Zen.MerkleTree realized in Zulib V1 (interface-only in 87b24e2: rule 4.9 refuses this source until then).
// scripts/v1/merkle-probe.mjs fills the body from a real round of the oracle service (GET /auditpath).

open Zen.Base
open Zen.Cost
open Zen.Types
open Zen.Data

module D = Zen.Dictionary
module RT = Zen.ResultT
module C = Zen.Cost
module S = FStar.String
module U64 = FStar.UInt64
module Sha3 = Zen.Sha3
module OptT = Zen.OptionT

let field (body: option data) (k: string) =
  body >!= tryDict >?= D.tryFind k

// values bounded by their types, as FixedPayout V0 does, so every function's cost is a constant: a cost that
// depended on a value bound inside a match (a ticker's length, a path's length) could not leave that match
type ticker = s:string { S.length s <= 4 }
type auditPath = p:list hash { length p <= 30 }

// FixedPayout's hashLeaf, the same shape: Sha3 of the ticker's bytes, then the value as a U64, padded to 4 characters
let leafOf (key : ticker) (value : U64.t) =
    ret Sha3.empty
    >>= Sha3.updateString key
    >>= Sha3.updateU64 value
    >>= Sha3.finalize
    |> inc (24 - 6 * S.length key)
    |> (fun x -> x <: hash `cost` 92)

// Zen.MerkleTree.verify padded to a path of 30 (FixedPayout's verifyAuditPath')
let verifyPadded (r: hash) (p: auditPath) (i: nat) (l: hash) =
    Zen.MerkleTree.verify r p i l
    |> inc (30 * 420 - length p * 420)
    |> (fun x -> x <: bool `cost` (30 * 420 + 4))

// the body's path: at most 30 hashes, read padded to 30 (FixedPayout's extractAuditPath)
let pathOf (ls: list data) =
    if length ls <= 30 then
        (let (ls: list data { length ls <= 30 }) = ls in
         OptT.tryMapT tryHash ls
         |> inc ((30 - length ls) * 22)
         |> (fun x -> x <: option auditPath `cost` (30 * 22 + 20)))
    else C.ret None |> autoInc

let idParses (o: string) =
    if S.length o = 72 then
        (let (s: string { S.length s = 72 }) = o in
         let! parsed = Zen.ContractId.parse s in
         C.ret (match parsed with | Some _ -> true | None -> false))
    else C.ret false |> autoInc

let proves (r: hash) (p: auditPath) (i: nat) (l1: hash) (l2: hash) (o: string) =
    let! good = verifyPadded r p i l1 in
    let! wrong = verifyPadded r p i l2 in
    let! idOk = idParses o in
    C.ret (good && not wrong && idOk)

// the two leaves to check: from an oracle round (ticker, value) or a test vector (leaf)
let leaves (body: option data) =
    let! t = field body "ticker" >?= tryString in
    let! v = field body "value" >?= tryU64 in
    let! lf = field body "leaf" >?= tryHash in
    match t, v, lf with
    | Some t, Some v, _ ->
        if S.length t <= 4 then
            (let (t: ticker) = t in
             let! l1 = leafOf t v in
             let! l2 = leafOf t (U64.add_mod v 1UL) in
             C.ret (Some (l1, l2)))
        else C.ret None |> autoInc
    | _, _, Some l ->
        (let! s1 = Sha3.updateHash l Sha3.empty in
         let! l2 = Sha3.finalize s1 in
         C.ret (Some (l, l2))) |> autoInc
    | _ -> C.ret None |> autoInc

let main txSkeleton context contractId command sender messageBody wallet state =
    let! r = field messageBody "root" >?= tryHash in
    let! p = field messageBody "path" >?= tryList in
    let! i = field messageBody "index" >?= tryU64 in
    let! o = field messageBody "oracle" >?= tryString in
    let! ls = leaves messageBody in
    match r, p, i, o, ls with
    | Some r, Some p, Some i, Some o, Some (l1, l2) ->
        (let! hs = pathOf p in
         match hs with
         | Some hs ->
             (let! passed = proves r hs (U64.v i) l1 l2 o in
              if passed then RT.ok @ { tx = txSkeleton; message = None; state = NoChange }
              else RT.autoFailw "merkle check failed")
         | None -> RT.autoFailw "path must be a list of up to 30 hashes")
    | _ -> RT.autoFailw "body must have root, path, index, oracle, and ticker (up to 4 characters) + value or leaf"

// above what main costs for a path of up to 30 hashes (two verifications at 30 x 420 + 4, two leaves, the path read,
// the id parse and six body reads)
let cf _ _ _ _ _ _ _ =
    30000
    |> cast nat
    |> C.ret
