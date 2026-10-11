// usage: dotnet fsi scripts/run-test-module.fsx src/Consensus.Tests/bin/Release Consensus.Tests.ContractV1Tests
// Runs the [<Test>] functions of one test module by reflection (dotnet test filters do not
// select these F# module tests here).
open System
open System.Reflection
let dir, typeName = fsi.CommandLineArgs.[1], fsi.CommandLineArgs.[2]
AppDomain.CurrentDomain.add_AssemblyResolve(ResolveEventHandler(fun _ a ->
    let p = IO.Path.Combine(dir, AssemblyName(a.Name).Name + ".dll")
    if IO.File.Exists p then Assembly.LoadFrom p else null))
let asm = Assembly.LoadFrom(IO.Path.Combine(dir, "Consensus.Tests.dll"))
let t = asm.GetType(typeName, true)
let mutable failed = 0
for m in t.GetMethods() do
    if m.GetCustomAttributes() |> Seq.exists (fun a -> a.GetType().Name = "TestAttribute") then
        let sw = Diagnostics.Stopwatch.StartNew()
        try
            m.Invoke(null, [||]) |> ignore
            printfn "pass  %s (%d ms)" m.Name sw.ElapsedMilliseconds
        with :? TargetInvocationException as e ->
            match e.InnerException.GetType().Name with
            | "IgnoreException" -> printfn "skip  %s: %s" m.Name e.InnerException.Message
            | _ -> failed <- failed + 1; printfn "FAIL  %s: %s" m.Name (e.InnerException.ToString().Split('\n') |> Array.truncate 6 |> String.concat "\n")
exit failed
