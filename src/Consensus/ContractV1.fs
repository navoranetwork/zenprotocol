/// V1 contracts: contracts written in current F* (navoranetwork/zp-contracts-v1), activated as
/// HighV (1, source bytes). The node compiles a V1 contract with the V1 toolchain (no Z3: the
/// cost proof is the author's; the node enforces the declared cost with gas), loads the DLL in
/// its own load context (it has its own FSharp.Core) and talks to it only through ZenAbi.
/// Calls go through the same Contract.T functions as V0, so ContractV0's validation applies.
module Consensus.ContractV1

open System
open System.Diagnostics
open System.IO
open System.Text
open Consensus.Types
open Infrastructure

type data = Zen.Types.Data.data
type sender = Zen.Types.Main.sender
type stateUpdate = Zen.Types.Main.stateUpdate
type private ALock = ZenAbi.Lock
type private ALockKind = ZenAbi.LockKind
type private AData = ZenAbi.Data
type private ADataKind = ZenAbi.DataKind

/// V1 contract DLLs (and the FSharp.Core they use) live in this subfolder of the contracts folder.
let folder contractsPath = Path.Combine(contractsPath, "v1")

/// V1 source is UTF-8 text; the contract's code string must round-trip to the same bytes, as the
/// contract ID hashes these bytes.
let decodeSource (bytes: byte[]) : Result<string, string> =
    try
        let code = UTF8Encoding(false, true).GetString bytes
        if Encoding.UTF8.GetBytes code = bytes then Ok code else Error "V1 contract source is not canonical UTF-8"
    with _ -> Error "V1 contract source is not valid UTF-8"

// ---------------------------------------------------------------- node types <-> ZenAbi
// Zulib (V0) strings are byte arrays; V1 strings are .NET strings. Bytes map to the characters
// with the same code (Latin-1); a V1 string with a character above 255 cannot cross.
let private latin1 = Encoding.Latin1
let private strOut (s: string) : byte[] =
    if String.forall (fun c -> int c <= 255) s then latin1.GetBytes s
    else failwithf "string not representable for V0 data: %s" s

let private idTo (ContractId (v, h)) = ZenAbi.ContractId(v, Hash.bytes h)
let private idFrom (c: ZenAbi.ContractId) = ContractId (c.Version, Hash.Hash c.Hash)

let private lockTo (l: Lock) : ALock =
    match l with
    | PK h -> ALock.PK (Hash.bytes h)
    | Contract c -> ALock.ToContract (idTo c)
    | Coinbase (n, h) -> ALock(Kind = ALockKind.Coinbase, Number = n, Hash = Hash.bytes h)
    | Fee -> ALock.Of ALockKind.Fee
    | ActivationSacrifice -> ALock.Of ALockKind.ActivationSacrifice
    | ExtensionSacrifice c -> ALock(Kind = ALockKind.ExtensionSacrifice, Contract = idTo c)
    | Destroy -> ALock.Of ALockKind.Destroy
    | HighVLock (id, b) -> ALock(Kind = ALockKind.HighV, Number = id, Bytes = b)

let private lockFrom (l: ALock) : Lock =
    match l.Kind with
    | ALockKind.PK -> PK (Hash.Hash l.Hash)
    | ALockKind.Contract -> Contract (idFrom l.Contract)
    | ALockKind.Coinbase -> Coinbase (l.Number, Hash.Hash l.Hash)
    | ALockKind.Fee -> Fee
    | ALockKind.ActivationSacrifice -> ActivationSacrifice
    | ALockKind.ExtensionSacrifice -> ExtensionSacrifice (idFrom l.Contract)
    | ALockKind.Destroy -> Destroy
    | ALockKind.HighV -> HighVLock (l.Number, l.Bytes)
    | k -> failwithf "unknown lock kind %A" k

let private spendTo (s: Spend) =
    let (Asset (ContractId (v, h), sub)) = s.asset
    ZenAbi.Spend(ZenAbi.Asset(v, Hash.bytes h, Hash.bytes sub), s.amount)
let private spendFrom (s: ZenAbi.Spend) : Spend =
    { asset = Asset (ContractId (s.Asset.Version, Hash.Hash s.Asset.ContractHash), Hash.Hash s.Asset.SubType); amount = s.Amount }
let private outputTo (o: Output) = ZenAbi.Output(lockTo o.lock, spendTo o.spend)
let private outputFrom (o: ZenAbi.Output) : Output = { lock = lockFrom o.Lock; spend = spendFrom o.Spend }
let private outpointTo (o: Outpoint) = ZenAbi.Outpoint(Hash.bytes o.txHash, o.index)
let private outpointFrom (o: ZenAbi.Outpoint) : Outpoint = { txHash = Hash.Hash o.TxHash; index = o.Index }

let private inputTo (i: TxSkeleton.Input) =
    match i with
    | TxSkeleton.PointedOutput (p, o) -> ZenAbi.Input.Pointed(outpointTo p, outputTo o)
    | TxSkeleton.Mint s -> ZenAbi.Input.Minting(spendTo s)
let private inputFrom (i: ZenAbi.Input) =
    if i.IsMint then TxSkeleton.Mint (spendFrom i.Mint)
    else TxSkeleton.PointedOutput (outpointFrom i.Outpoint, outputFrom i.Output)

let private txTo (t: TxSkeleton.T) =
    ZenAbi.TxSkeleton(Inputs = (t.pInputs |> List.map inputTo |> Array.ofList),
                      Outputs = (t.outputs |> List.map outputTo |> Array.ofList))
let private txFrom (t: ZenAbi.TxSkeleton) : TxSkeleton.T =
    { pInputs = t.Inputs |> Array.map inputFrom |> List.ofArray
      outputs = t.Outputs |> Array.map outputFrom |> List.ofArray }

module ZData = Zen.Types.Data

let rec private dataTo (d: data) : AData =
    match d with
    | ZData.I64 x -> AData(Kind = ADataKind.I64, I64 = x)
    | ZData.Byte x -> AData(Kind = ADataKind.Byte, U64 = uint64 x)
    | ZData.ByteArray x -> AData(Kind = ADataKind.ByteArray, Bytes = x)
    | ZData.U32 x -> AData(Kind = ADataKind.U32, U64 = uint64 x)
    | ZData.U64 x -> AData(Kind = ADataKind.U64, U64 = x)
    | ZData.String s -> AData(Kind = ADataKind.String, Str = latin1.GetString(s: byte[]))
    | ZData.Hash x -> AData(Kind = ADataKind.Hash, Bytes = x)
    | ZData.Lock l -> AData(Kind = ADataKind.Lock, Lock = lockTo (ZFStar.fstToFsLock l))
    | ZData.Signature x -> AData(Kind = ADataKind.Signature, Bytes = x)
    | ZData.PublicKey x -> AData(Kind = ADataKind.PublicKey, Bytes = x)
    | ZData.Collection (ZData.Array xs) -> AData(Kind = ADataKind.Array, Items = Array.map dataTo xs)
    | ZData.Collection (ZData.List xs) -> AData(Kind = ADataKind.List, Items = (ZFStar.fstToFsList xs |> List.map dataTo |> Array.ofList))
    | ZData.Collection (ZData.Dict (m, _)) ->
        AData(Kind = ADataKind.Dict,
              Dict = (m |> Map.toArray |> Array.map (fun (k, v) -> Collections.Generic.KeyValuePair(latin1.GetString(k: byte[]), dataTo v))))

let rec private dataFrom (d: AData) : data =
    match d.Kind with
    | ADataKind.I64 -> ZData.I64 d.I64
    | ADataKind.Byte -> ZData.Byte (Checked.byte d.U64)
    | ADataKind.ByteArray -> ZData.ByteArray d.Bytes
    | ADataKind.U32 -> ZData.U32 (Checked.uint32 d.U64)
    | ADataKind.U64 -> ZData.U64 d.U64
    | ADataKind.String -> ZData.String (strOut d.Str)
    | ADataKind.Hash -> ZData.Hash d.Bytes
    | ADataKind.Lock -> ZData.Lock (ZFStar.fsToFstLock (lockFrom d.Lock))
    | ADataKind.Signature -> ZData.Signature d.Bytes
    | ADataKind.PublicKey -> ZData.PublicKey d.Bytes
    | ADataKind.Array -> ZData.Collection (ZData.Array (Array.map dataFrom d.Items))
    | ADataKind.List -> ZData.Collection (ZData.List (d.Items |> Array.map dataFrom |> List.ofArray |> ZFStar.fsToFstList))
    | ADataKind.Dict ->
        let m = d.Dict |> Array.map (fun kv -> strOut kv.Key, dataFrom kv.Value) |> Map.ofArray
        ZData.Collection (ZData.Dict (m, uint32 (Map.count m)))
    | k -> failwithf "unknown data kind %A" k

let private optTo (d: data option) = match d with Some d -> dataTo d | None -> null

let private senderTo (s: sender) =
    match s with
    | Zen.Types.Main.PK pk -> ZenAbi.Sender(Kind = ZenAbi.SenderKind.PK, PublicKey = pk)
    | Zen.Types.Main.Contract (v, h) -> ZenAbi.Sender(Kind = ZenAbi.SenderKind.Contract, Contract = ZenAbi.ContractId(v, h))
    | Zen.Types.Main.Anonymous -> ZenAbi.Sender.Anonymous

let private stateFrom (s: ZenAbi.StateUpdate) : stateUpdate =
    match s.Kind with
    | ZenAbi.StateKind.Delete -> Zen.Types.Main.Delete
    | ZenAbi.StateKind.Update -> Zen.Types.Main.Update (dataFrom s.Value)
    | _ -> Zen.Types.Main.NoChange

let private messageFrom (m: ZenAbi.Message) : Message option =
    if isNull m then None
    else Some { recipient = idFrom m.Recipient; command = m.Command; body = (if isNull m.Body then None else Some (dataFrom m.Body)) }

// ---------------------------------------------------------------- calls
/// One run gives both the declared cost and the result. The node asks for the cost and then
/// for the result with the same (immutable) arguments, so the last run is kept and reused when
/// every argument is the same object.
type Call =
    { tx: TxSkeleton.T
      context: ContractContext
      command: string
      sender: sender
      body: data option
      wallet: PointedOutput list
      state: data option }

let private sameCall (a: Call) (b: Call) =
    obj.ReferenceEquals(a.tx, b.tx) && a.context = b.context && a.command = b.command
    && obj.ReferenceEquals(a.sender, b.sender) && obj.ReferenceEquals(a.body, b.body)
    && obj.ReferenceEquals(a.wallet, b.wallet) && obj.ReferenceEquals(a.state, b.state)

type Runner(contract: ZenAbi.IContract, contractId: ContractId) =
    let mutable last : (Call * ZenAbi.RunResult) option = None
    let gate = obj ()

    member _.Run (call: Call) : ZenAbi.RunResult =
        lock gate (fun () ->
            match last with
            | Some (c, r) when sameCall c call -> r
            | _ ->
                let wallet = call.wallet |> List.map (fun (p, o) -> ZenAbi.Input.Pointed(outpointTo p, outputTo o)) |> Array.ofList
                let r = ZenAbi.Rules.Run(contract, txTo call.tx, ZenAbi.Context(call.context.blockNumber, call.context.timestamp),
                                         idTo contractId, call.command, senderTo call.sender, optTo call.body, wallet, optTo call.state)
                last <- Some (call, r)
                r)

    /// The declared cost; fails when the cost function fails, runs out of gas or declares
    /// more than the per-call limit.
    member x.Cost tx context command sender body wallet state : Result<int64, string> =
        try
            let r = x.Run { tx = tx; context = context; command = command; sender = sender; body = body; wallet = wallet; state = state }
            if r.Cost > ZenAbi.Rules.MaxGasPerCall then Error (sprintf "declared cost %O above the limit" r.Cost)
            elif r.Cost.IsZero && r.OutOfGas then Error "cost function out of gas"
            else Ok (int64 r.Cost)
        with ex -> Exception.toError "V1 costFn" ex

    /// The result, under the V1 execution rule (ZenAbi.Rules.Rejection: gas, limit, overflow).
    member x.Main tx context (_: ContractId) command sender body wallet state =
        try
            let r = x.Run { tx = tx; context = context; command = command; sender = sender; body = body; wallet = wallet; state = state }
            match ZenAbi.Rules.Rejection r with
            | null -> Ok (txFrom r.Return.Tx, messageFrom r.Return.Message, stateFrom r.Return.State)
            | e -> Error e
        with ex -> Exception.toError "V1 mainFn" ex

// ---------------------------------------------------------------- building and loading
/// The V1 toolchain: a checkout of navoranetwork/zp-contracts-v1 with Zulib verified
/// (scripts/verify-zulib.sh) and, unless FSTAR_HOME is set, the pinned F* in its fstar/ folder.
let toolchain () =
    match Environment.GetEnvironmentVariable "ZP_V1_TOOLCHAIN" with
    | null | "" -> Path.Combine(Platform.workingDirectory, "contract-tool-v1")
    | dir -> dir

let private moduleName hash = "Z" + (Hash.bytes hash |> Convert.ToHexString).ToLowerInvariant()

/// The outcome of a build that did not produce the contract.
type BuildFailure =
    /// The contract is refused: every node with the pinned toolchain refuses it (build-contract.sh
    /// exit 10). The activation is invalid.
    | Refused of string
    /// The build failed here, for a reason that says nothing about the contract (exit 20, a crash,
    /// a time limit, a missing toolchain). A node must not reject a block for it.
    | EnvironmentFailure of string

exception BuildEnvironmentError of string

/// What a node does when it cannot build a contract for a reason of its own: stop, rather than
/// reject a block the other nodes accept (it would leave the chain). Tests replace it.
let mutable onEnvironmentFailure : string -> unit = fun reason ->
    eprintfn "FATAL: cannot build a V1 contract here (%s). The node stops instead of rejecting a block that other nodes may accept. Fix the toolchain (see zp-contracts-v1 toolchain.lock) and restart." reason
    exit 3

/// The most time one build may take. Past it the build is killed and counts as an environment
/// failure: type-checking time is bounded by the elaborator's rules (no type-level computation)
/// and the source size, so a valid contract is far below this on any working node.
let buildTimeLimit = TimeSpan.FromMinutes 10.

/// Contracts refused in this process, by module name: a refused source is built at most once per
/// node run, however often it comes back (in templates, as a new transaction, in a block).
let private refused = System.Collections.Concurrent.ConcurrentDictionary<string, string>()

let wasRefused (ContractId (_, hash)) = refused.ContainsKey (moduleName hash)

let rec private build (contractsPath: string) (code: string) hash : Result<unit, BuildFailure> =
    let dir = toolchain ()
    let src = Path.GetTempFileName()
    try
        try
            File.WriteAllBytes(src, Encoding.UTF8.GetBytes code)
            let psi = ProcessStartInfo("bash", WorkingDirectory = dir, RedirectStandardOutput = true,
                                       RedirectStandardError = true, UseShellExecute = false)
            for a in [ Path.Combine(dir, "scripts", "build-contract.sh"); "--lax"; src; folder (Path.GetFullPath contractsPath) ] do
                psi.ArgumentList.Add a
            if String.IsNullOrEmpty (Environment.GetEnvironmentVariable "FSTAR_HOME") then
                psi.Environment.["FSTAR_HOME"] <- Path.Combine(dir, "fstar")
            use p = Process.Start psi
            let err = p.StandardError.ReadToEndAsync()
            let out = p.StandardOutput.ReadToEndAsync()
            if not (p.WaitForExit buildTimeLimit) then
                (try p.Kill true with _ -> ())
                Error (EnvironmentFailure (sprintf "build took more than %O" buildTimeLimit))
            else
            p.WaitForExit()
            let text = (out.Result.Trim() + " " + err.Result.Trim()).Trim()
            let lines = out.Result.Trim().Split('\n')
            match p.ExitCode with
            | 0 when lines.[lines.Length - 1].Trim() = (moduleName hash).Substring 1 -> Ok ()
            | 0 -> Error (EnvironmentFailure "the build did not report the contract's hash")
            | 10 -> Error (Refused (sprintf "V1 contract refused: %s" text))
            | code -> Error (EnvironmentFailure (sprintf "build exit %d: %s" code text))
        with ex -> Error (EnvironmentFailure (sprintf "V1 build: %s" ex.Message))
    finally
        try File.Delete src with _ -> ()

/// Build a V1 contract (lax: type-checked and cost-elaborated, no Z3) into the V1 folder.
/// Ok, or Error with why the contract is refused. A failure of the build environment is retried
/// once; if it fails again the node stops (onEnvironmentFailure), and if that returns, the
/// BuildEnvironmentError exception is raised: never a refusal.
let compile (contractsPath: string) (code: string) (contractId: ContractId) : Result<unit, string> =
    let (ContractId (_, hash)) = contractId
    match refused.TryGetValue (moduleName hash) with
    | true, error -> Error error
    | _ ->
        let attempt () = build contractsPath code hash
        let result = match attempt () with Error (EnvironmentFailure _) -> attempt () | r -> r
        match result with
        | Ok () -> Ok ()
        | Error (Refused error) -> refused.[moduleName hash] <- error; Error error
        | Error (EnvironmentFailure reason) ->
            onEnvironmentFailure reason
            raise (BuildEnvironmentError reason)

/// The libsecp256k1 the node ships for V0 (package zen_secp256k1_*), next to the node. V1
/// contracts verify signatures with exactly this build, as V0 contracts do.
let secp256k1Path () =
    let name =
        if OperatingSystem.IsWindows() then "secp256k1.dll"
        elif OperatingSystem.IsMacOS() then "libsecp256k1.dylib"
        else "libsecp256k1.so"
    // next to this assembly (the node's folder), where the zen_secp256k1 package puts it
    Path.Combine(Path.GetDirectoryName(Reflection.Assembly.GetExecutingAssembly().Location), name)

/// Load a built V1 contract; its main and cost functions in the node's contract form.
let load (contractsPath: string) (contractId: ContractId) =
    let (ContractId (_, hash)) = contractId
    let dir = Path.GetFullPath (folder contractsPath)     // the node's contracts path is relative
    let dll = Path.Combine(dir, moduleName hash + ".dll")
    if not (File.Exists dll) then Error "compiled V1 contract DLL file not found"
    // its load context takes FSharp.Core from the same folder; without it the node's own (4.3.4)
    // cannot stand in, and the contract would only fail when called
    elif not (File.Exists (Path.Combine(dir, "FSharp.Core.dll"))) then Error "V1 contract runtime (FSharp.Core.dll) not found"
    elif not (File.Exists (secp256k1Path ())) then Error (sprintf "libsecp256k1 not found next to the node (%s)" (secp256k1Path ()))
    else
        try
            ZenAbi.ContractLoadContext.Secp256k1Path <- secp256k1Path ()
            let runner = Runner(ZenAbi.ContractLoadContext.Load(dll, dir), contractId)
            Ok runner
        with ex -> Exception.toError "V1 load" ex
