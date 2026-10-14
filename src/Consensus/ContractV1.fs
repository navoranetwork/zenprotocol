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
            // a contract built without proofs can declare a negative cost (`cast nat` is not
            // checked): refused here too, whatever its Zulib does (it would lower a block's weight)
            if r.Cost.Sign < 0 then Error (sprintf "negative declared cost %O" r.Cost)
            elif r.Cost > ZenAbi.Rules.MaxGasPerCall then Error (sprintf "declared cost %O above the limit" r.Cost)
            elif r.Cost.IsZero && r.OutOfGas then Error "cost function out of gas"
            else Ok (int64 r.Cost)
        with ex -> Exception.toError "V1 costFn" ex

    /// The result, under the V1 execution rule (ZenAbi.Rules.Rejection: gas, limit, overflow).
    member x.Main tx context (_: ContractId) command sender body wallet state =
        try
            let r = x.Run { tx = tx; context = context; command = command; sender = sender; body = body; wallet = wallet; state = state }
            // gas used must be within [0, declared cost]: anything else means gas was created
            if r.Cost.Sign < 0 || r.Used.Sign < 0 || r.Used > r.Cost then
                Error (sprintf "V1 gas accounting out of range (declared %O, used %O)" r.Cost r.Used)
            else
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
    // already built by this node (block templates, a reorg, a restart): the DLL's name is the
    // SHA3 of the source and the build writes it atomically, so it is the same file a rebuild
    // would make (builds are byte-identical); building again took 15-20 s each time
    | _ when File.Exists (Path.Combine(Path.GetFullPath (folder contractsPath), moduleName hash + ".dll")) -> Ok ()
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

/// The library V1 contracts load (secp256k1Path), checked once at start with libsecp256k1's own
/// vector (zp-contracts-v1 contracts/crypto-test): the compressed key parses to V0's 64-byte internal
/// form, the signature verifies, and it does not verify another message. Calls the same file through
/// its own exports, as a contract's DllImport does. A node that fails it would run V1 contracts
/// differently from the others, so it must not start. Ok: the file and its SHA-256.
module private SelfTestVector =
    let pk = Convert.FromHexString "026f4b37dd5a125b678c67b8c89e519037a3be63214ccb34764ce03f03a8ac6793"
    let internalForm =
        [| 147uy; 103uy; 172uy; 168uy; 3uy; 63uy; 224uy; 76uy; 118uy; 52uy; 203uy; 76uy; 33uy; 99uy; 190uy; 163uy; 55uy; 144uy; 81uy; 158uy; 200uy; 184uy; 103uy; 140uy; 103uy; 91uy; 18uy; 90uy; 221uy; 55uy; 75uy; 111uy
           116uy; 65uy; 242uy; 69uy; 240uy; 3uy; 172uy; 234uy; 87uy; 240uy; 190uy; 236uy; 162uy; 199uy; 224uy; 169uy; 108uy; 145uy; 45uy; 240uy; 73uy; 113uy; 38uy; 127uy; 229uy; 230uy; 76uy; 165uy; 118uy; 199uy; 189uy; 42uy |]
    let signature =
        [| 97uy; 224uy; 111uy; 12uy; 110uy; 78uy; 29uy; 9uy; 5uy; 104uy; 93uy; 232uy; 174uy; 212uy; 105uy; 216uy; 37uy; 53uy; 72uy; 252uy; 30uy; 77uy; 153uy; 125uy; 182uy; 205uy; 249uy; 110uy; 186uy; 243uy; 28uy; 199uy
           70uy; 23uy; 0uy; 74uy; 182uy; 86uy; 182uy; 123uy; 125uy; 200uy; 96uy; 212uy; 199uy; 163uy; 36uy; 109uy; 68uy; 194uy; 38uy; 226uy; 90uy; 137uy; 219uy; 216uy; 154uy; 219uy; 231uy; 254uy; 169uy; 66uy; 104uy; 38uy |]
    let msg =
        [| 42uy; 109uy; 103uy; 234uy; 156uy; 185uy; 45uy; 79uy; 23uy; 81uy; 99uy; 180uy; 160uy; 86uy; 215uy; 24uy; 136uy; 7uy; 175uy; 125uy; 129uy; 142uy; 20uy; 131uy; 138uy; 132uy; 127uy; 65uy; 65uy; 200uy; 19uy; 21uy |]
    let other =
        [| 95uy; 80uy; 71uy; 222uy; 6uy; 237uy; 103uy; 173uy; 101uy; 78uy; 255uy; 100uy; 79uy; 98uy; 84uy; 20uy; 101uy; 172uy; 139uy; 62uy; 44uy; 190uy; 185uy; 22uy; 240uy; 231uy; 154uy; 93uy; 133uy; 33uy; 226uy; 79uy |]

[<Runtime.InteropServices.UnmanagedFunctionPointer(Runtime.InteropServices.CallingConvention.Cdecl)>]
type private ContextCreate = delegate of uint32 -> nativeint
[<Runtime.InteropServices.UnmanagedFunctionPointer(Runtime.InteropServices.CallingConvention.Cdecl)>]
type private PubkeyParse = delegate of nativeint * byte[] * byte[] * unativeint -> int
[<Runtime.InteropServices.UnmanagedFunctionPointer(Runtime.InteropServices.CallingConvention.Cdecl)>]
type private EcdsaVerify = delegate of nativeint * byte[] * byte[] * byte[] -> int

let secp256k1SelfTest () : Result<string * string, string> =
    let path = secp256k1Path ()
    if not (File.Exists path) then Error (sprintf "libsecp256k1 not found next to the node (%s)" path) else
    try
        let lib = Runtime.InteropServices.NativeLibrary.Load path
        let export name = Runtime.InteropServices.NativeLibrary.GetExport(lib, name)
        let ctx = Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer<ContextCreate>(export "secp256k1_context_create").Invoke(0x0101u)   // SECP256K1_CONTEXT_VERIFY, as V1
        let parse = Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer<PubkeyParse>(export "secp256k1_ec_pubkey_parse")
        let verify = Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer<EcdsaVerify>(export "secp256k1_ecdsa_verify")
        let internalForm = Array.zeroCreate<byte> 64
        if parse.Invoke(ctx, internalForm, SelfTestVector.pk, unativeint 33) <> 1 then Error "the test key does not parse"
        elif internalForm <> SelfTestVector.internalForm then Error "the test key's internal form differs from V0's"
        elif verify.Invoke(ctx, SelfTestVector.signature, SelfTestVector.msg, internalForm) <> 1 then Error "the test signature does not verify"
        elif verify.Invoke(ctx, SelfTestVector.signature, SelfTestVector.other, internalForm) <> 0 then Error "the test signature verifies another message"
        else
            use f = File.OpenRead path
            Ok (path, (Security.Cryptography.SHA256.HashData f |> Convert.ToHexString).ToLowerInvariant())
    with ex -> Error (sprintf "%s: %s" path ex.Message)

/// Contracts loaded so far, by DLL path: one load context per contract for the node's life,
/// however often a template, a block or a reorg asks for it (each load made a new context).
let private loaded = System.Collections.Concurrent.ConcurrentDictionary<string, Runner>()

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
        match loaded.TryGetValue dll with
        | true, runner -> Ok runner
        | _ ->
        try
            ZenAbi.ContractLoadContext.Secp256k1Path <- secp256k1Path ()
            let runner = loaded.GetOrAdd(dll, fun _ -> Runner(ZenAbi.ContractLoadContext.Load(dll, dir), contractId))
            Ok runner
        with ex -> Exception.toError "V1 load" ex
