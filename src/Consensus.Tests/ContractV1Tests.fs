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
