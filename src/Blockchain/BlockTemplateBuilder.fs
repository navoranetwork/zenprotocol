module Blockchain.BlockTemplateBuilder

open Consensus
open ValidationError
open Chain
open Types
open TransactionValidation

open Infrastructure
open Result

open Blockchain.State

open Consensus.CGP
open Infrastructure.LogEvent

module ZData = Zen.Types.Data

let result = Result.ResultBuilder<string>()


module private CGP =
    
    open FSharpx.Reader
    
    let reader = FSharpx.Reader.reader
    
    let (<@|) = map
    
    let (|@>) x f = map f x
    
    type Env =
        {
            chain : ChainParameters
            cgp   : CGP.T
        }
        static member getCGP =
            ask |@> fun env -> env.cgp 
        static member getChain =
            ask |@> fun env -> env.chain
        static member getEnv =
            ask
    
    type E<'a> = Reader<Env, 'a>
    
    let hasValidData
        ( msgBody : Option<Zen.Types.Data.data> )
        : E< bool > = reader {
            let! cgp = Env.getCGP
            
            let outputs =
                msgBody
                |> CGP.Contract.extractPayoutOutputs
                |> Option.defaultValue []
            
            let winner =
                cgp.payout
                |> Option.map CGP.Connection.internalizeRecipient
                |> Option.defaultValue []
            
            return List.sort outputs = List.sort winner
        }
    
    let filterValidCgpTxs
        ( xs : List<TransactionExtended * 'a> )
        : E< List<TransactionExtended * 'a> > = reader {
            let! env   = Env.getEnv
            let! chain = Env.getChain
            
            let extractValidCGPWitnesses ex =
                ex
                |> CGP.Connection.extractPayoutWitnesses chain
                |> List.filter (fun cw -> hasValidData cw.messageBody env)
            
            let isValidCgp =
                fst
                >> extractValidCGPWitnesses
                >> List.isSingleton
            
            return List.choose (Option.validateWith isValidCgp) xs
        }
    
    let removeAllCgpTxs
        ( txs : List<TransactionExtended * 'a> )
        : E< List<TransactionExtended * 'a> > = reader {
            let! chain = Env.getChain
            
            let isNonCGP =
                 fst
                 >> CGP.Connection.extractPayoutWitnesses chain
                 >> List.isEmpty
            
            return List.choose (Option.validateWith isNonCGP) txs
        }
    
    let filterCGPExecutions
        ( txs : List<TransactionExtended * 'a> )
        : E< List<TransactionExtended * 'a> > = reader {
            let! chain = Env.getChain
            let! cgp   = Env.getCGP
            
            let payoutWitnesses =
                txs
                |> List.concatMap (fst >> CGP.Connection.extractPayoutWitnesses chain)
            
            // Either return the 1st valid CGP tx, or remove all the cgp txs
            // (sorry for the convoluted implementation, it's more efficient this way)
            let uniqueCgp = reader {
                match! List.tryHead <@| filterValidCgpTxs txs with
                | None ->
                    eventX "No valid cgp transaction found, execute the contract correctly"
                    |> Log.error
                    return! Error <@| removeAllCgpTxs txs
                | Some tx ->
                    return Ok tx
            }
            
            match cgp.payout with
            | None ->
                // we can safely remove the cgp txs as if there are none it will return an empty list
                return! removeAllCgpTxs txs
            | Some _ ->
                match payoutWitnesses with
                | [] ->
                    eventX "You should create your own contract execution"
                    |> Log.error
                    return txs
                | [_] ->
                    return! uniqueCgp |@> Result.fromOk (fun _ -> txs)
                | _ :: _ :: _ ->
                    let! noCgpTxs = removeAllCgpTxs txs
                    return! uniqueCgp |@> Result.fromOk (fun tx -> tx :: noCgpTxs)
        }

// We pre-compute the weights of all transactions in the mempool.
// It may be better to compute the weights when transactions are inserted, but
// doing it when creating a template works reasonably well.
// There's no need to update the UTXO set when adding the weights -- the only
// use of the UTXOs is to dereference all the outputs.
let weights session state =
    MemPool.toList state.memoryState.mempool
    |> Result.traverseResultM (fun ex -> 
        UtxoSet.tryGetOutputs (UtxoSetRepository.get session) state.memoryState.utxoSet ex.tx.inputs
        |> Result.ofOption "could not get outputs"
        <@> TxSkeleton.fromTransaction ex.tx
        >>= Weight.transactionWeight ex.tx
        <@> fun weight -> ex, weight)

let selectOrderedTransactions (chain:Chain.ChainParameters) (session:DatabaseContext.Session) blockNumber timestamp acs contractCache transactions =
    let contractPath = session.context.contractPath
    let maxWeight = chain.maxBlockWeight
    let getUTXO = UtxoSetRepository.get session
    let blockNumber = blockNumber + 1ul

    // V1 activations whose contract this node has not built yet: at most this many builds per
    // template (each takes 20-30 s); the rest wait for later templates
    let maxV1BuildsPerTemplate = BlockConnection.V1Activations.maxPerBlock
    let v1Builds = ref 0
    let needsV1Build (ex: TransactionExtended) (state: MemoryState) =
        match ex.tx.contract with
        | Some (HighV (v, bytes)) when v = Version1 ->
            match ContractV1.decodeSource bytes with
            | Ok code ->
                let id = Contract.makeContractId Version1 code
                Option.isNone (ContractCache.tryFind id state.contractCache) && not (ContractV1.wasRefused id)
            | Error _ -> false
        | _ -> false

    let tryAddTransaction (state, added, notAdded, altered, weight) (ex,wt) =
        let newWeight = weight+wt
        if newWeight > maxWeight && (not <| Connection.isPayoutTransaction chain ex) then (state, added, notAdded, false, weight) else
        // at most BlockConnection.V1Activations.maxPerBlock V1 activations per block; the rest wait
        let v1Activations =
            added |> List.filter (fun (tx:TransactionExtended) -> match tx.tx.contract with Some (HighV (v, _)) when v = Version1 -> true | _ -> false) |> List.length
        if BlockConnection.V1Activations.isV1Activation ex && v1Activations >= BlockConnection.V1Activations.maxPerBlock then (state, added, notAdded, altered, weight) else
        if needsV1Build ex state && v1Builds.Value >= maxV1BuildsPerTemplate then (state, added, notAdded, altered, weight) else
        if needsV1Build ex state then v1Builds.Value <- v1Builds.Value + 1
        validateInContext chain getUTXO contractPath blockNumber timestamp
            // state.contractStates, not ContractStates.asDatabase: a call must see the contract state left by the calls
            // already in this template, as block validation does; otherwise two calls each valid alone both go in and
            // the block fails validation (the miner then retries the same invalid block)
            state.activeContractSet state.contractCache state.utxoSet (ContractStateRepository.get session) state.contractStates ex
        |> function
            | Error (Orphan | ContractNotActive) ->
                (state, added, (ex,wt)::notAdded, altered, weight)
            | Error _ ->
                // Tried again in the next pass: the transactions are sorted by weight, so a contract call can come
                // before the earlier call it depends on; once that one is added, this one may be valid.
                (state, added, (ex,wt)::notAdded, altered, weight)
            | Ok (tx, acs, contractCache, contractStates) ->
                let utxoSet = UtxoSet.handleTransaction getUTXO ex.txHash ex.tx state.utxoSet
                let mempool = MemPool.add ex state.mempool
                ({state with activeContractSet=acs;mempool=mempool;utxoSet=utxoSet;contractCache=contractCache;contractStates=contractStates}, tx::added, notAdded, true, newWeight)

    let foldOverTransactions foldState txs =
        List.fold tryAddTransaction foldState txs
        |> fun (s, added, notAdded, altered, wt) -> (s, added, List.rev notAdded, altered, wt)

    let foldUntilUnchanged state txs =
        let rec inner foldState txs =
            match foldOverTransactions foldState txs with
            | (s, added, notAdded, true, wt) -> inner (s, added, [], false, wt) notAdded
            | (s, added, _, false, _) -> (s, List.rev added)
        inner (state, [], [], false, 0I) txs

    let initialState = {
        utxoSet = UtxoSet.asDatabase
        activeContractSet = acs
        orphanPool = OrphanPool.create()
        mempool = MemPool.empty
        contractCache = contractCache
        contractStates = ContractStates.asDatabase
        invalidTxHashes = Set.empty
    }

    foldUntilUnchanged initialState transactions


let makeTransactionList chain (session:DatabaseContext.Session) (state:State) timestamp = result {
    let! txs = weights session state
    let txs =
        if CGP.isPayoutBlock chain (state.tipState.tip.header.blockNumber + 1ul) then
            CGP.filterCGPExecutions txs { chain=chain ; cgp=state.cgp }
        else
            txs
        // kept in arrival order (MemPool.toList), not sorted by weight: a wallet builds a contract call on the state left
        // by its earlier calls in the mempool, so the calls must reach the template in the order they were made
    return selectOrderedTransactions chain session state.tipState.tip.header.blockNumber timestamp state.tipState.activeContractSet state.memoryState.contractCache txs
}