// How a node runs V1 contracts: loading, running on a large stack, and the acceptance rule.
using System;
using System.IO;
using System.Numerics;
using System.Reflection;
using System.Threading;

namespace ZenAbi
{
    public static class Rules
    {
        /// The most gas one contract call may declare (consensus parameter; draft value).
        public static readonly BigInteger MaxGasPerCall = new BigInteger(10_000_000);

        /// Stack size for contract runs: deep but paid-for computations nest deeply.
        public const int ContractStackBytes = 512 * 1024 * 1024;

        /// The V1 execution rule: null if the call is accepted, otherwise why it fails.
        public static string Rejection(RunResult r)
        {
            if (r.OutOfGas) return "out of gas: declared cost " + r.Cost;
            if (r.Used > r.Cost) return "cost exceeded: used " + r.Used + ", declared " + r.Cost;
            if (r.Cost > MaxGasPerCall) return "declared cost " + r.Cost + " above the limit " + MaxGasPerCall;
            if (r.Error != null) return r.Error;
            if (r.Return.Tx.Overflow) return "asset total overflow";
            return null;
        }

        /// Run a call the way the node must: on its own large-stack thread, any exception turned
        /// into a failed call.
        public static RunResult Run(IContract c, TxSkeleton tx, Context context, ContractId contractId, string command,
                                    Sender sender, Data body, Input[] wallet, Data state)
        {
            RunResult result = null;
            Exception failure = null;
            var worker = new Thread(() =>
            {
                try { result = c.Run(tx, context, contractId, command, sender, body, wallet, state); }
                catch (Exception e) { failure = e; }
            }, ContractStackBytes);
            worker.Start();
            worker.Join();
            if (failure != null)
                return new RunResult { Error = "contract failed: " + (failure.InnerException ?? failure).Message };
            return result;
        }
    }

    /// Loads V1 contract DLLs. Each contract gets its own load context (on .NET Core; see
    /// ContractLoadContext in the host) so it can use its own FSharp.Core; ZenAbi is shared.
    public static class Contracts
    {
        public const string EntryType = "ZenContractAdapter+Entry";

        /// Create the contract's entry object from an already loaded contract assembly.
        public static IContract Entry(Assembly contract)
        {
            var t = contract.GetType(EntryType, throwOnError: true);
            return (IContract)Activator.CreateInstance(t);
        }

        /// Contract hash from a DLL path (Z<64 hex>.dll).
        public static byte[] HashOfPath(string dll)
        {
            var name = Path.GetFileNameWithoutExtension(dll);
            if (name.Length != 65 || name[0] != 'Z') throw new ArgumentException("expected Z<64 hex>.dll: " + dll);
            var h = new byte[32];
            for (int i = 0; i < 32; i++) h[i] = Convert.ToByte(name.Substring(1 + 2 * i, 2), 16);
            return h;
        }
    }
}
