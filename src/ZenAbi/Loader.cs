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
        public ContractLoadContext(string name, string runtimeDir) : base(name, isCollectible: true) { this.runtimeDir = runtimeDir; }

        protected override Assembly Load(AssemblyName name)
        {
            if (name.Name == "ZenAbi") return null;                 // shared with the host
            var path = Path.Combine(runtimeDir, name.Name + ".dll");
            return File.Exists(path) ? LoadFromAssemblyPath(path) : null;
        }

        /// Load a contract DLL with its runtime (FSharp.Core 10) from runtimeDir.
        public static IContract Load(string dll, string runtimeDir)
        {
            var ctx = new ContractLoadContext(Path.GetFileNameWithoutExtension(dll), runtimeDir);
            using (var s = File.OpenRead(dll))
                return Contracts.Entry(ctx.LoadFromStream(s));
        }
    }
}
