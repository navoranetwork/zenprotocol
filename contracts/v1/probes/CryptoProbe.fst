// CryptoProbe, ZP contracts V1: checks through a real node that a V1 contract's Zen.Crypto works (libsecp256k1, as the
// node loads it for V1 contracts). Test only: it holds nothing and changes nothing.
//
//   any command, body { key: String (a compressed key, 66 hex), pk: PublicKey (the same key), sig: Signature,
//                       msg: Hash, other: Hash }
//   succeeds only if: parsePublicKey key gives pk (the node's own reading of the same key), sig verifies on msg,
//   sig does not verify on other, and parsePublicKey refuses "02zz". Otherwise "crypto check failed".
// scripts/v1/crypto-probe.mjs activates it for a few blocks and calls it with vectors from zp-contracts-v1
// contracts/crypto-test (made with libsecp256k1), once right and once with msg and other swapped.

open Zen.Base
open Zen.Cost
open Zen.Types
open Zen.Data

module D = Zen.Dictionary
module RT = Zen.ResultT
module C = Zen.Cost

let field (body: option data) (k: string) =
  body >!= tryDict >?= D.tryFind k

let crypto (k: string) (pk0: publicKey) (sg: signature) (m: hash) (o: hash) =
  let! parsed = Zen.Crypto.parsePublicKey k in
  let! bad = Zen.Crypto.parsePublicKey "02zz" in
  match parsed with
  | Some pk ->
    (let! good = Zen.Crypto.verify pk sg m in
     let! wrong = Zen.Crypto.verify pk sg o in
     let badRefused = (match bad with | None -> true | Some _ -> false) in
     C.ret ((pk = pk0 <: bool) && good && not wrong && badRefused))
  | None -> C.ret false |> autoInc

let main txSkeleton context contractId command sender messageBody wallet state =
  let! k = field messageBody "key" >?= tryString in
  let! pk0 = field messageBody "pk" >?= tryPublicKey in
  let! sg = field messageBody "sig" >?= trySignature in
  let! m = field messageBody "msg" >?= tryHash in
  let! o = field messageBody "other" >?= tryHash in
  match k, pk0, sg, m, o with
  | Some k, Some pk0, Some sg, Some m, Some o ->
    (let! passed = crypto k pk0 sg m o in
     if passed then RT.ok @ { tx = txSkeleton; message = None; state = NoChange }
     else RT.autoFailw "crypto check failed")
  | _ -> RT.autoFailw "body must have key, pk, sig, msg and other"

// above what main costs (about 2,300: two key parses at 120, two verifications at 800, five body reads)
let cf _ _ _ _ _ _ _ =
    5000
    |> cast nat
    |> C.ret
