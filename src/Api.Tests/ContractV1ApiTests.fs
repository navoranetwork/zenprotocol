/// V1 contracts through the wallet and the API: POST /wallet/contract/activate with "version": 1
/// creates a HighV (1, source) activation with its sacrifice and fee, the node builds the contract
/// when it validates it, and the contract can then be called through the API like a V0 contract.
/// The end-to-end test needs the V1 toolchain (ZP_V1_TOOLCHAIN, FSTAR_HOME); skipped without it.
module Api.Tests.ContractV1ApiTests

open System
open NUnit.Framework
open FsUnit
open FSharp.Data
open Consensus
open Consensus.Types
open Wallet
open Infrastructure
open Consensus.Tests.Helper
open Consensus.Tests.SampleContract
open Api.Types
open Api.Parsing
open Utils
open Json
open FsBech32
open Serialization
open Constants

type private Parsed = Result<string * uint32 * uint32 option * string * uint32, string>
let private parse (s: string) : Parsed = parseContractActivateJson s

let private body (fields: string) =
    sprintf """{"code": "c", "numberOfBlocks": 10, "password": "p"%s}""" fields

[<Test>]
let ``activation request without a version is a V0 activation``() =
    parse (body "") |> should equal (Ok ("c", 10u, None, "p", 0u) : Parsed)
    parse (body ", \"rlimit\": 5") |> should equal (Ok ("c", 10u, Some 5u, "p", 0u) : Parsed)

[<Test>]
let ``activation request with version 1 is a V1 activation``() =
    parse (body ", \"version\": 1") |> should equal (Ok ("c", 10u, None, "p", 1u) : Parsed)

[<Test>]
let ``V1 activation request with an rlimit is refused``() =
    parse (body ", \"version\": 1, \"rlimit\": 5")
    |> should equal (Error "rlimit applies to version 0 contracts only" : Parsed)

[<Test>]
let ``activation request with an unknown version is refused``() =
    parse (body ", \"version\": 2")
    |> should equal (Error "Unsupported contract version 2" : Parsed)

[<SetUp>]
[<TearDown>]
let clean() =
    Platform.cleanDirectory dataPath

[<Test>]
let ``V1 contract activates from the wallet and executes through the API``() =
    if String.IsNullOrEmpty (Environment.GetEnvironmentVariable "ZP_V1_TOOLCHAIN") then
        Assert.Ignore "ZP_V1_TOOLCHAIN not set: V1 toolchain tests skipped"

    use actors = getActors()
    Block.createGenesis chainParams [rootTxExtended] (0UL,0UL)
    |> publishBlockJson
    |> post "blockchain/publishblock" |> ignore

    importSeedJson password (split rootMnemonicPhrase [|' '|])
    |> post "wallet/import" |> ignore

    "wallet/resync" |> get |> ignore

    let code = sampleContractCode
    let expectedId = Contract.makeContractId Version1 code

    let response =
        contractActivateV1RequestJson code 10 password
        |> post "wallet/contract/activate"
        |> ContractActivateOrExtendResponseJson.Parse

    response.ContractId |> should equal (ContractId.toString expectedId)
    response.Address |> should equal (Address.encode chain (Address.Contract expectedId))

    // the activation the wallet built and published
    let activation =
        sprintf "blockchain/transaction?hash=%s&hex=true" response.TxHash
        |> get
        |> JsonValue.Parse
        |> fun j -> j.["tx"].AsString()
        |> Base16.decode |> Option.get
        |> Transaction.deserialize TransactionSerializationMode.Full |> Option.get

    activation.contract |> should equal (Some (HighV (Version1, Text.Encoding.UTF8.GetBytes code)))
    let sacrifice = activation.outputs |> List.filter (fun o -> o.lock = ActivationSacrifice)
    sacrifice |> List.sumBy (fun o -> o.spend.amount)
    |> should equal (chainParams.sacrificePerByteBlock * uint64 (String.length code) * 10UL)
    activation.outputs |> List.filter (fun o -> o.lock = Fee) |> List.sumBy (fun o -> o.spend.amount)
    |> should equal (Weight.activationWeight (HighV (Version1, Text.Encoding.UTF8.GetBytes code)) |> uint64)

    // the node built it: the contract runs, mints 1000 of its token and locks them to itself
    let tx =
        TxSkeleton.empty
        |> TxSkeleton.serialize
        |> Base16.encode
        |> contractExecuteFromTransactionJson response.Address "" "" ""
        |> post "blockchain/contract/execute"
        |> Base16.decode |> Option.get
        |> Transaction.deserialize TransactionSerializationMode.Full |> Option.get

    let token = { asset = Asset.defaultOf expectedId; amount = 1000UL }
    tx.outputs |> should contain { lock = Contract expectedId; spend = token }
    tx.witnesses
    |> List.exists (function ContractWitness cw -> cw.contractId = expectedId | _ -> false)
    |> should equal true
