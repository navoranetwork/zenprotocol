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

// FixedPayout's hashLeaf: Sha3 of the ticker's bytes, then the value as a U64
let leafOf (t: string) (v: U64.t) =
  let! s1 = Sha3.updateString t Sha3.empty in
  let! s2 = Sha3.updateU64 v s1 in
  Sha3.finalize s2

let proves (r: hash) (p: list hash) (i: nat) (l1: hash) (l2: hash) (o: string) =
  let! good = Zen.MerkleTree.verify r p i l1 in
  let! wrong = Zen.MerkleTree.verify r p i l2 in
  if S.length o = 72 then
    (let! parsed = Zen.ContractId.parse o in
     C.ret (good && not wrong && Some? parsed))
  else C.ret false |> autoInc

// the two leaves to check: from an oracle round (ticker, value) or a test vector (leaf)
let leaves (body: option data) =
  let! t = field body "ticker" >?= tryString in
  let! v = field body "value" >?= tryU64 in
  let! lf = field body "leaf" >?= tryHash in
  match t, v, lf with
  | Some t, Some v, _ ->
    (let! l1 = leafOf t v in
     let! l2 = leafOf t (U64.add_mod v 1UL) in
     C.ret (Some (l1, l2)))
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
    (let! hs = OptT.tryMapT tryHash p in
     match hs with
     | Some hs ->
       (let! passed = proves r hs (U64.v i) l1 l2 o in
        if passed then RT.ok @ { tx = txSkeleton; message = None; state = NoChange }
        else RT.autoFailw "merkle check failed")
     | None -> RT.autoFailw "path must be a list of hashes")
  | _ -> RT.autoFailw "body must have root, path, index, oracle, and ticker + value or leaf"

// above what main costs for a path of up to 30 hashes (two verifications at 30 x 420 + 4, two leaves, the path read,
// the id parse and six body reads)
let cf _ _ _ _ _ _ _ =
    30000
    |> cast nat
    |> C.ret
