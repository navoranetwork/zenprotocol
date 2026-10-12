// The load context for one V1 contract (.NET Core only; compiled for net10.0 hosts).
using System.Reflection;
using System.Runtime.Loader;
using System.IO;

namespace ZenAbi
{
    /// One V1 contract in its own load context: its own copy of FSharp.Core (from runtimeDir), and
    /// ZenAbi shared with the host. Unloadable when the contract expires.
    public sealed class ContractLoadContext : AssemblyLoadContext
    {
        readonly string runtimeDir;
        public ContractLoadContext(string name, string runtimeDir) : base(name, isCollectible: true) { this.runtimeDir = Path.GetFullPath(runtimeDir); }   // LoadFromAssemblyPath needs absolute paths

        protected override Assembly Load(AssemblyName name)
        {
            // ZenAbi is shared: always the host's own copy, whatever version the contract was
            // built against (the node's ZenAbi must not be looked up by version).
            if (name.Name == "ZenAbi") return typeof(IContract).Assembly;
            var path = Path.Combine(runtimeDir, name.Name + ".dll");
            return File.Exists(path) ? LoadFromAssemblyPath(path) : null;
        }

        /// Load a contract DLL with its runtime (FSharp.Core 10) from runtimeDir.
        public static IContract Load(string dll, string runtimeDir)
        {
            var ctx = new ContractLoadContext(Path.GetFileNameWithoutExtension(dll), runtimeDir);
            using (var s = File.OpenRead(dll))
                return new Held(ctx, Contracts.Entry(ctx.LoadFromStream(s)));
        }

        /// The contract together with its load context. A collectible context that nothing
        /// references unloads itself when collected, after which the contract cannot load
        /// FSharp.Core (or anything else) lazily: the contract must keep its context alive.
        sealed class Held : IContract
        {
            readonly ContractLoadContext context;
            readonly IContract contract;
            public Held(ContractLoadContext context, IContract contract) { this.context = context; this.contract = contract; }
            public RunResult Run(TxSkeleton tx, Context ctx, ContractId contractId, string command, Sender sender,
                                 Data body, Input[] wallet, Data state)
                => contract.Run(tx, ctx, contractId, command, sender, body, wallet, state);
        }
    }
}
