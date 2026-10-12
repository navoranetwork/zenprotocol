/// V1 contracts in the node: activation as HighV (1, source) after the fork height, building with
/// the V1 toolchain, and calls through ZenAbi validated exactly like V0 calls.
/// Needs the V1 toolchain (navoranetwork/zp-contracts-v1 with Zulib verified): ZP_V1_TOOLCHAIN, and
/// FSTAR_HOME unless the toolchain has fstar/. Skipped when ZP_V1_TOOLCHAIN is not set.
module Consensus.Tests.ContractV1Tests

open System
open System.Text
open Consensus
open Consensus.Types
open Consensus.ValidationError
open TxSkeleton
open NUnit.Framework
open TestsInfrastructure.Nunit
open Helper
open SampleContract

let contractPath =
    IO.Path.Combine [| IO.Path.GetTempPath(); IO.Path.GetRandomFileName() |]

let getUTXO _ = UtxoSet.NoOutput
let getContractState _ = None
let context = { blockNumber = 100u; timestamp = 1_000_000UL }

let requireToolchain () =
    if String.IsNullOrEmpty (Environment.GetEnvironmentVariable "ZP_V1_TOOLCHAIN") then
        Assert.Ignore "ZP_V1_TOOLCHAIN not set: V1 toolchain tests skipped"

let unwrap = function Ok v -> v | Error e -> failwithf "%A" e

/// the Mint test contract (cost 214), unchanged, as V1 source
let v1Code = sampleContractCode
let v1Id = Contract.makeContractId Version1 v1Code

/// the same contract declaring 100 instead of 214: only a lax build accepts it, and gas stops it
let liarCode = sampleContractCode.Replace("64 + (64 + 64 + 0) + 22", "100")
let liarId = Contract.makeContractId Version1 liarCode

let activationTxOf (bytes: byte[]) (sacrifice: uint64) =
    let rootAccount = createTestAccount() |> fst
    let outpoint, output = TestWallet.getUnspentOutputs rootAccount |> fst |> Map.toSeq |> Seq.head
    {
        version = Version0
        contract = Some (HighV (Version1, bytes))
        inputs = [ Outpoint outpoint ]
        outputs =
            [ { lock = ActivationSacrifice; spend = { amount = sacrifice; asset = Asset.Zen } }
              { output with spend = { output.spend with amount = output.spend.amount - sacrifice } } ]
        witnesses = []
    }
    |> Transaction.sign [ rootKeyPair ] TxHash
    |> Transaction.toExtended

let activationTx (code: string) blocks =
    activationTxOf (Encoding.UTF8.GetBytes code) (uint64 (String.length code) * blocks)

let rootUtxos = UtxoSet.asDatabase |> UtxoSet.handleTransaction getUTXO rootTxHash rootTx

let activate chainParams blockNumber code =
    TransactionValidation.validateInContext chainParams getUTXO contractPath blockNumber 1_000_000UL
        ActiveContractSet.empty ContractCache.empty rootUtxos getContractState ContractStates.asDatabase (activationTx code 10UL)

let activated = lazy (activate Chain.localParameters 1ul v1Code |> unwrap)

/// The transaction the Mint contract builds from sampleInputTx: mint 1000 of its token, lock them to it.
let expectedOutputTx contractId =
    let spend = { asset = Asset.defaultOf contractId; amount = 1000UL }
    { sampleInputTx with
        pInputs = sampleInputTx.pInputs @ [ Mint spend ]
        outputs = sampleInputTx.outputs @ [ { lock = Contract contractId; spend = spend } ] }

/// Run the contract as a wallet would, build the transaction with its witness, then validate
/// it in context like a node does (ContractV0.validate, shared by V1).
let callAndValidate (contract: Contract.T) declaredCost =
    let finalTx =
        match Contract.run contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None with
        | Ok (tx, _, _) -> tx
        | Error _ -> expectedOutputTx contract.contractId   // a failing contract: try the honest result
    let cw = TxSkeleton.getContractWitness contract.contractId "" None NotCommitted sampleInputTx finalTx declaredCost
    let acs = ActiveContractSet.add contract.contractId contract ActiveContractSet.empty
    Transaction.fromTxSkeleton finalTx
    |> Transaction.pushWitnesses [ ContractWitness cw ]
    |> Transaction.sign [ sampleKeyPair ] TxHash
    |> Transaction.toExtended
    |> TransactionValidation.validateInContext Chain.localParameters getUTXO contractPath 1ul 1_000_000UL
        acs Map.empty (getSampleUtxoset UtxoSet.asDatabase) getContractState ContractStates.asDatabase

[<Test>]
let ``V1 activation before the fork height is refused``() =
    let chainParams = { Chain.localParameters with v1ContractsHeight = 1000ul }
    match activate chainParams 999ul v1Code with
    | Error (General "High version contracts not supported") -> ()
    | other -> failwithf "expected refusal, got %A" other

[<Test>]
let ``V1 activation with invalid UTF-8 is refused``() =
    let tx = activationTxOf [| 0xffuy; 0xfeuy |] 1000UL
    match TransactionValidation.validateInContext Chain.localParameters getUTXO contractPath 1ul 1_000_000UL
            ActiveContractSet.empty ContractCache.empty rootUtxos getContractState ContractStates.asDatabase tx with
    | Error (General e) when e.Contains "UTF-8" -> ()
    | other -> failwithf "expected UTF-8 refusal, got %A" other

[<Test>]
let ``V1 contract activates, builds and is active``() =
    requireToolchain ()
    let _, acs, cache, _ = activated.Force()
    let contract = ActiveContractSet.tryFind v1Id acs |> Option.get
    Assert.AreEqual(Version1, contract.version)
    Assert.AreEqual(1ul + 10ul - 1ul, contract.expiry)
    Assert.IsTrue(ContractCache.tryFind v1Id cache |> Option.isSome)

[<Test>]
let ``V1 contract declares its cost and builds the expected transaction``() =
    requireToolchain ()
    let _, acs, _, _ = activated.Force()
    let contract = ActiveContractSet.tryFind v1Id acs |> Option.get
    (Contract.getCost contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None, (Ok 214L : Result<int64, string>))
    |> shouldEqual
    match Contract.run contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None with
    | Ok (tx, None, Zen.Types.Main.NoChange) -> (tx, expectedOutputTx v1Id) |> shouldEqual
    | other -> failwithf "unexpected result %A" other

[<Test>]
let ``V1 contract call validates in context``() =
    requireToolchain ()
    let _, acs, _, _ = activated.Force()
    let contract = ActiveContractSet.tryFind v1Id acs |> Option.get
    match callAndValidate contract 214L with
    | Ok _ -> ()
    | Error e -> failwithf "valid V1 call refused: %A" e

[<Test>]
let ``V1 call with a wrong cost commitment is refused``() =
    requireToolchain ()
    let _, acs, _, _ = activated.Force()
    let contract = ActiveContractSet.tryFind v1Id acs |> Option.get
    match callAndValidate contract 213L with
    | Error (General "execution cost commitment mismatch") -> ()
    | other -> failwithf "expected cost mismatch, got %A" other

[<Test>]
let ``V1 contract that under-declares its cost is stopped by gas``() =
    requireToolchain ()
    let _, acs, _, _ = activate Chain.localParameters 1ul liarCode |> unwrap
    let contract = ActiveContractSet.tryFind liarId acs |> Option.get
    (Contract.getCost contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None, (Ok 100L : Result<int64, string>))
    |> shouldEqual
    match callAndValidate contract 100L with
    | Error (General e) when e.Contains "out of gas" -> ()
    | other -> failwithf "expected out of gas, got %A" other

[<Test>]
let ``V1 contract reloads from the contracts folder``() =
    requireToolchain ()
    activated.Force() |> ignore
    let contract = Contract.load contractPath 50ul v1Code v1Id |> unwrap
    (Contract.getCost contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None, (Ok 214L : Result<int64, string>))
    |> shouldEqual

[<Test>]
let ``V1 activation has a weight that grows with the source``() =
    let w (code: string) = Weight.activationWeight (HighV (Version1, Encoding.UTF8.GetBytes code))
    Assert.IsTrue(w v1Code > 0I)
    Assert.IsTrue(w (v1Code + v1Code) > w v1Code)

/// Contracts are built against ZenAbi 1.0.0.0; the node's copy must carry that version (a real node
/// resolves it by version; the test runner's resolve handler hid a 0.0.0.0 build once).
[<Test>]
let ``the node's ZenAbi has the version contracts reference``() =
    Assert.AreEqual(Version(1, 0, 0, 0), typeof<ZenAbi.IContract>.Assembly.GetName().Version)

/// The build puts the contract's FSharp.Core next to it (its load context takes it from there);
/// without it the contract is refused at load, not when it is first called.
[<Test>]
let ``V1 contract is built with its runtime, and refused without it``() =
    requireToolchain ()
    activated.Force() |> ignore
    let dir = IO.Path.Combine(contractPath, "v1")
    Assert.IsTrue(IO.File.Exists (IO.Path.Combine(dir, "FSharp.Core.dll")), "FSharp.Core.dll next to the contract")
    let bare = IO.Path.Combine [| IO.Path.GetTempPath(); IO.Path.GetRandomFileName() |]
    let bareV1 = IO.Path.Combine(bare, "v1")
    IO.Directory.CreateDirectory bareV1 |> ignore
    for f in IO.Directory.GetFiles(dir, "Z*.dll") do IO.File.Copy(f, IO.Path.Combine(bareV1, IO.Path.GetFileName f))
    match ContractV1.load bare v1Id with
    | Error e -> Assert.AreEqual("V1 contract runtime (FSharp.Core.dll) not found", e)
    | Ok _ -> Assert.Fail "loaded without its FSharp.Core"

/// A node gives a relative contracts path (./data/...); loading and running must not depend on it.
[<Test>]
let ``V1 contract loads and runs from a relative contracts path``() =
    requireToolchain ()
    activated.Force() |> ignore
    let relative = IO.Path.GetRelativePath(Environment.CurrentDirectory, contractPath)
    Assert.IsFalse(IO.Path.IsPathRooted relative)
    let contract = Contract.load relative 50ul v1Code v1Id |> unwrap
    match Contract.run contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None with
    | Ok (tx, _, _) -> Assert.AreEqual(expectedOutputTx v1Id, tx)
    | Error e -> Assert.Fail (sprintf "%A" e)

/// A collectible load context that nothing references unloads itself when collected; the
/// contract must keep it alive, or its first lazy assembly load fails after a GC.
[<Test>]
let ``V1 contract still runs after garbage collections``() =
    requireToolchain ()
    activated.Force() |> ignore
    let contract = Contract.load contractPath 50ul v1Code v1Id |> unwrap
    for _ in 1..3 do
        GC.Collect(); GC.WaitForPendingFinalizers()
    match Contract.run contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None with
    | Ok (tx, _, _) -> Assert.AreEqual(expectedOutputTx v1Id, tx)
    | Error e -> Assert.Fail (sprintf "%A" e)

/// V1 calls weigh 400 per gas (V0: 100): the same call witness, with the contract's version
/// changed, weighs 300 per gas more as V1.
[<Test>]
let ``V1 call weighs 400 per gas, V0 100``() =
    let cost = 214UL
    let witnessFor version =
        ContractWitness { contractId = ContractId (version, Hash.zero); command = ""; messageBody = None
                          stateCommitment = NotCommitted; beginInputs = 0u; beginOutputs = 0u
                          inputsLength = 0u; outputsLength = 0u; signature = None; cost = cost }
    let weightOf version =
        let tx = { version = Version0; contract = None; inputs = []; outputs = []; witnesses = [ witnessFor version ] }
        Weight.transactionWeight tx TxSkeleton.empty |> unwrap
    Assert.AreEqual(300I * bigint cost, weightOf Version1 - weightOf Version0)

/// At most two V1 activations per block (each makes every node build a contract).
[<Test>]
let ``a block may hold two V1 activations, not three``() =
    let a = activationTx v1Code 10UL
    let b = activationTx liarCode 10UL
    let c = activationTx (v1Code + " ") 10UL
    let two : Result<unit, string> = BlockConnection.V1Activations.checkTransactions [ a; b ]
    let three : Result<unit, string> = BlockConnection.V1Activations.checkTransactions [ a; b; c ]
    Assert.AreEqual((Ok () : Result<unit, string>), two)
    Assert.AreEqual((Error "block has 3 V1 contract activations, above 2" : Result<unit, string>), three)

/// A V1 contract that accepts a call only if a fixed signature (made with libsecp256k1) verifies.
let sigCode = """open Zen.Types
open Zen.Base
open Zen.Cost

module RT = Zen.ResultT
module C = Zen.Cost
module Cr = Zen.Crypto

let main tx _ _ _ _ _ _ _ =
  let! pko = Cr.parsePublicKey "026f4b37dd5a125b678c67b8c89e519037a3be63214ccb34764ce03f03a8ac6793" in
  let! s1 = Cr.parseHash "61e06f0c6e4e1d0905685de8aed469d8253548fc1e4d997db6cdf96ebaf31cc7" in
  let! s2 = Cr.parseHash "4617004ab656b67b7dc860d4c7a3246d44c226e25a89dbd89adbe7fea9426826" in
  let! m = Cr.parseHash "2a6d67ea9cb92d4f175163b4a056d7188807af7d818e14838a847f4141c81315" in
  match pko, s1, s2, m with
  | Some pk, Some a, Some b, Some msg ->
    let! ab = (Zen.List.append a b <: (list FStar.UInt8.t) `cost` 66) in
    let sg : signature = ab in
    let! ok = Cr.verify pk sg msg in
    if ok then RT.ok @ { tx = tx; message = None; state = NoChange } else RT.autoFailw "bad signature"
  | _ -> RT.autoFailw "bad input"

let cf _ _ _ _ _ _ _ = 2000 |> cast nat |> C.ret
"""

/// V1 signature checks use the libsecp256k1 the node ships for V0 (next to the node), not
/// whatever the platform would find first.
[<Test>]
let ``V1 signature checks use the node's own libsecp256k1``() =
    requireToolchain ()
    let id = Contract.makeContractId Version1 sigCode
    Contract.compileV1 contractPath sigCode |> unwrap
    let contract = Contract.load contractPath 50ul sigCode id |> unwrap
    match Contract.run contract sampleInputTx context "" Zen.Types.Main.Anonymous None [] None with
    | Ok _ -> ()
    | Error e -> Assert.Fail (sprintf "the valid signature was refused: %A" e)
    let pinned = ContractV1.secp256k1Path ()
    Assert.AreEqual(pinned, ZenAbi.ContractLoadContext.Secp256k1Path)
    if OperatingSystem.IsLinux() then
        let maps = IO.File.ReadAllText "/proc/self/maps"
        Assert.IsTrue(maps.Contains pinned, sprintf "%s is not loaded" pinned)

let mempoolActivate (code: string) =
    TransactionValidation.validateInContextMempool Chain.localParameters getUTXO contractPath 1ul 1_000_000UL
        ActiveContractSet.empty ContractCache.empty rootUtxos getContractState ContractStates.asDatabase (activationTx code 10UL)

/// The mempool checks a V1 activation but does not build its contract (nobody has paid yet):
/// it is accepted at once, the contract is not active, and nothing is built.
[<Test>]
let ``the mempool accepts a V1 activation without building it``() =
    let code = v1Code + "\n// mempool"
    let id = Contract.makeContractId Version1 code
    let sw = Diagnostics.Stopwatch.StartNew()
    let (_, acs, cache, _) = mempoolActivate code |> unwrap
    Assert.Less(sw.ElapsedMilliseconds, 3000L, "no build in the mempool")
    Assert.IsTrue(Option.isNone (ActiveContractSet.tryFind id acs))
    Assert.IsTrue(Option.isNone (ContractCache.tryFind id cache))
    let (ContractId (_, h)) = id
    let dll = IO.Path.Combine(contractPath, "v1", "Z" + (Hash.bytes h |> Convert.ToHexString).ToLowerInvariant() + ".dll")
    Assert.IsFalse(IO.File.Exists dll)

/// V1 source is at most 64 KiB, refused before anything else (mempool and blocks).
[<Test>]
let ``V1 source above 64 KiB is refused``() =
    let big = v1Code + "\n//" + String('x', 65536)
    match mempoolActivate big with
    | Error (General e) -> StringAssert.Contains("above 65536 bytes", e)
    | other -> Assert.Fail (sprintf "%A" other)
    match activate Chain.localParameters 1ul big with
    | Error (General e) -> StringAssert.Contains("above 65536 bytes", e)
    | other -> Assert.Fail (sprintf "%A" other)

/// A source whose build fails is built once per node run: the second refusal is immediate.
[<Test>]
let ``a refused V1 build is not repeated``() =
    requireToolchain ()
    let bad = "this is not F*"
    let id = Contract.makeContractId Version1 bad
    Assert.IsTrue(match Contract.compileV1 contractPath bad with Error _ -> true | Ok _ -> false)
    Assert.IsTrue(ContractV1.wasRefused id)
    let sw = Diagnostics.Stopwatch.StartNew()
    Assert.IsTrue(match Contract.compileV1 contractPath bad with Error _ -> true | Ok _ -> false)
    Assert.Less(sw.ElapsedMilliseconds, 100L)
