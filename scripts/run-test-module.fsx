// usage: dotnet fsi scripts/run-test-module.fsx src/Consensus.Tests/bin/Release Consensus.Tests.ContractV1Tests
// Runs the [<Test>] functions of one test module by reflection (dotnet test filters do not
// select these F# module tests here), each after the module's [<SetUp>] functions.
// The assembly is the module name without its last part (Api.Tests.X -> Api.Tests.dll).
open System
open System.Reflection
let dir, typeName = fsi.CommandLineArgs.[1], fsi.CommandLineArgs.[2]
AppDomain.CurrentDomain.add_AssemblyResolve(ResolveEventHandler(fun _ a ->
    let p = IO.Path.Combine(dir, AssemblyName(a.Name).Name + ".dll")
    if IO.File.Exists p then Assembly.LoadFrom p else null))
let asmName = typeName.Substring(0, typeName.LastIndexOf '.')
let asm = Assembly.LoadFrom(IO.Path.Combine(dir, asmName + ".dll"))
let t = asm.GetType(typeName, true)
let has name (m: MethodInfo) = m.GetCustomAttributes() |> Seq.exists (fun a -> a.GetType().Name = name)
let setUps = t.GetMethods() |> Array.filter (has "SetUpAttribute")
let mutable failed = 0
for m in t.GetMethods() do
    if has "TestAttribute" m then
        let sw = Diagnostics.Stopwatch.StartNew()
        try
            for s in setUps do s.Invoke(null, [||]) |> ignore
            m.Invoke(null, [||]) |> ignore
            printfn "pass  %s (%d ms)" m.Name sw.ElapsedMilliseconds
        with :? TargetInvocationException as e ->
            match e.InnerException.GetType().Name with
            | "IgnoreException" -> printfn "skip  %s: %s" m.Name e.InnerException.Message
            | _ -> failed <- failed + 1; printfn "FAIL  %s: %s" m.Name (e.InnerException.ToString().Split('\n') |> Array.truncate 6 |> String.concat "\n")
exit failed
