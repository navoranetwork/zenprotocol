module Miner.Main

open Consensus
open Messaging.Events
open Messaging.Services
open Infrastructure
open Consensus.Types
open Consensus.Difficulty
open Consensus.Serialization
open FSharp
open System
open Infrastructure.LogEvent

/// How often at most the miner asks for a new block template when only the mempool changed, in milliseconds
/// (ZP_TEMPLATE_INTERVAL_MS, default 1000; 0 = on every new transaction, as before). A new tip always asks at once.
/// Building a template re-validates the whole mempool, so asking on every transaction made the template builder the
/// node's largest cost under load (throughput rerun 2026-10-14: 41% of CPU). Not consensus: only when our own
/// template is refreshed.
let templateIntervalMs =
    match System.Environment.GetEnvironmentVariable "ZP_TEMPLATE_INTERVAL_MS" with
    | null | "" -> 1000
    | v -> max 0 (int v)

let private sendTemplate client publisher =
    Wallet.getAddressPKHash client
    |> Result.map (fun pkHash ->
        Blockchain.getBlockTemplate client pkHash
        |> Block.serialize
        |> Message.NewTemplate
        |> Message.send publisher)
    |> Result.mapError (fun error ->
        eventX "Miner could not get address: {error}"
        >> setField "error" error
        |> Log.info)
    |> ignore

/// mempool changes not yet in a template (on the actor's own thread: the poller runs events and the timer in turn)
let mutable private pending = false

let handleEvent client publisher event =
    match event with
    | TipChanged _ ->
        pending <- false
        sendTemplate client publisher
    | TransactionAddedToMemPool _ when templateIntervalMs = 0 ->
        sendTemplate client publisher
    | TransactionAddedToMemPool _ ->
        pending <- true
    | _ -> ()

let private handleTimer client publisher =
    if pending then
        pending <- false
        sendTemplate client publisher

let main busName numberOfThreads =
    Actor.create<unit,unit,Event,unit> busName "Miner" (fun poller _ ebObservable  ->
        let client = ServiceBus.Client.create busName
        let publisher = FsNetMQ.Socket.pub ()

        let address = sprintf "inproc://%s-miner-inproc" busName
        FsNetMQ.Socket.bind publisher address

        let actors =
            [1..numberOfThreads]
            |> List.map (fun _ -> MiningActor.create busName address)

        eventX "Miner running"
        |> Log.info

        Wallet.getAddressPKHash client
        |> Result.map (fun pkHash ->
            let template = Blockchain.getBlockTemplate client pkHash |> Block.serialize

            Message.send publisher <| Message.NewTemplate template

            )
        |> Result.mapError (fun error ->
            eventX "Miner could not get address: {error}"
            >> setField "error" error
            |> Log.info)
        |> ignore

        eventX "Miner: a new template at most every {ms} ms on mempool changes, at once on a new tip"
        >> setField "ms" templateIntervalMs
        |> Log.info

        let observable =
            let events = ebObservable |> Observable.map (handleEvent client publisher)
            if templateIntervalMs = 0 then events else
            let timer = FsNetMQ.Timer.create (templateIntervalMs * 1<FsNetMQ.milliseconds>)
            FsNetMQ.Poller.addTimer poller timer
            |> Observable.map (fun _ -> handleTimer client publisher)
            |> Observable.merge events

        Disposables.fromFunction (fun () ->
            Message.send publisher Message.Exit

            // Dispose all actors
            Disposables.disposeList actors

            Disposables.dispose client
            Disposables.dispose publisher
        )
        , observable
    )