// ZenAbi: the stable interface between the ZP node and V1 contract DLLs.
//
// Only plain .NET types appear here (no FSharp.Core): the node keeps FSharp.Core 4.3.4 for V0
// contracts, and each V1 contract runs in its own load context with its own FSharp.Core. This
// assembly is the only one they share. Hashes, keys and signatures are byte arrays.
using System;
using System.Collections.Generic;
using System.Numerics;

namespace ZenAbi
{
    public sealed class ContractId
    {
        public uint Version;
        public byte[] Hash;            // 32 bytes
        public ContractId(uint version, byte[] hash) { Version = version; Hash = hash; }
    }

    public sealed class Asset
    {
        public uint Version;
        public byte[] ContractHash;    // 32 bytes; all zero for ZP
        public byte[] SubType;         // 32 bytes
        public Asset(uint version, byte[] contractHash, byte[] subType) { Version = version; ContractHash = contractHash; SubType = subType; }
    }

    public enum LockKind { PK, Contract, Fee, Destroy, ActivationSacrifice, ExtensionSacrifice, Coinbase, HighV }

    public sealed class Lock
    {
        public LockKind Kind;
        public byte[] Hash;            // PK, Coinbase: public key hash
        public ContractId Contract;    // Contract, ExtensionSacrifice
        public uint Number;            // Coinbase: block number; HighV: identifier
        public byte[] Bytes;           // HighV
        public static Lock PK(byte[] hash) => new Lock { Kind = LockKind.PK, Hash = hash };
        public static Lock ToContract(ContractId c) => new Lock { Kind = LockKind.Contract, Contract = c };
        public static Lock Of(LockKind k) => new Lock { Kind = k };
    }

    public sealed class Spend
    {
        public Asset Asset;
        public ulong Amount;
        public Spend(Asset asset, ulong amount) { Asset = asset; Amount = amount; }
    }

    public sealed class Outpoint
    {
        public byte[] TxHash;          // 32 bytes
        public uint Index;
        public Outpoint(byte[] txHash, uint index) { TxHash = txHash; Index = index; }
    }

    public sealed class Output
    {
        public Lock Lock;
        public Spend Spend;
        public Output(Lock @lock, Spend spend) { Lock = @lock; Spend = spend; }
    }

    /// An output being spent, or a mint.
    public sealed class Input
    {
        public Outpoint Outpoint;      // null for a mint
        public Output Output;          // null for a mint
        public Spend Mint;             // null unless a mint
        public bool IsMint => Mint != null;
        public static Input Pointed(Outpoint o, Output output) => new Input { Outpoint = o, Output = output };
        public static Input Minting(Spend s) => new Input { Mint = s };
    }

    /// Inputs and outputs in order. Overflow: an asset total passed 2^64-1 while the contract ran;
    /// the call fails (V0 threw on overflow).
    public sealed class TxSkeleton
    {
        public Input[] Inputs = new Input[0];
        public Output[] Outputs = new Output[0];
        public bool Overflow;
    }

    public enum DataKind { I64, Byte, ByteArray, U32, U64, String, Hash, Lock, Signature, PublicKey, Array, Dict, List }

    public sealed class Data
    {
        public DataKind Kind;
        public long I64;
        public ulong U64;              // also Byte and U32
        public byte[] Bytes;           // ByteArray, Hash, Signature, PublicKey
        public string Str;
        public Lock Lock;
        public Data[] Items;           // Array, List
        public KeyValuePair<string, Data>[] Dict;   // any order; contracts see keys in V0 order
    }

    public enum SenderKind { Anonymous, PK, Contract }

    public sealed class Sender
    {
        public SenderKind Kind;
        public byte[] PublicKey;       // PK: 64-byte libsecp256k1 internal form
        public ContractId Contract;
        public static readonly Sender Anonymous = new Sender { Kind = SenderKind.Anonymous };
    }

    public sealed class Context
    {
        public uint BlockNumber;
        public ulong Timestamp;
        public Context(uint blockNumber, ulong timestamp) { BlockNumber = blockNumber; Timestamp = timestamp; }
    }

    public sealed class Message
    {
        public ContractId Recipient;
        public string Command;
        public Data Body;              // null: no body
    }

    public enum StateKind { NoChange, Delete, Update }

    public sealed class StateUpdate
    {
        public StateKind Kind;
        public Data Value;             // Update
    }

    public sealed class ContractReturn
    {
        public TxSkeleton Tx;
        public Message Message;        // null: none
        public StateUpdate State;
    }

    /// One call: the contract's answer (Return, or Error), the cost it declared, the (bounded) cost
    /// of computing that declaration, and the gas main used. Main runs with the declared cost as
    /// its gas budget and is stopped when it is spent (OutOfGas).
    public sealed class RunResult
    {
        public ContractReturn Return;  // null on error
        public string Error;           // null on success
        public BigInteger Cost;
        public BigInteger CostFnCost;
        public BigInteger Used;
        public bool OutOfGas;
    }

    public interface IContract
    {
        RunResult Run(TxSkeleton tx, Context context, ContractId contractId, string command, Sender sender,
                      Data body, Input[] wallet, Data state);
    }
}
